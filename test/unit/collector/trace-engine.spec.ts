import {
  getOriginPolicy,
  validateUrlSyntax,
  traceOriginFromContent,
  probeSafeLink,
} from '../../../server/modules/collector/trace-engine';

describe('getOriginPolicy', () => {
  it('does not treat a signal-tier editorial publication as an aggregator', () => {
    expect(getOriginPolicy({
      tier: 'signal',
      discoveryUrl: 'https://36kr.com/p/example',
      sourceUrl: 'https://www.36kr.com/feed',
      sourceName: '36氪 RSS',
      sourceCategoryId: 'media_analysis',
    })).toBe('editorial');
  });

  it('keeps an explicit public-account bridge subject to source verification', () => {
    expect(getOriginPolicy({
      tier: 'signal',
      discoveryUrl: 'https://mp.weixin.qq.com/s/example',
      sourceUrl: 'https://plink.anyfeeder.com/weixin/almosthuman2014',
      sourceName: '机器之心（公众号桥接）',
      sourceCategoryId: 'media_analysis',
    })).toBe('aggregator');
  });

  it('recognizes official publications as first party', () => {
    expect(getOriginPolicy({
      tier: 'authoritative',
      discoveryUrl: 'https://openai.com/news/example',
      sourceUrl: 'https://openai.com/news/rss.xml',
      sourceName: 'OpenAI News',
      sourceCategoryId: 'official_release',
    })).toBe('first_party');
  });

  it('honors a source policy explicitly set by operators', () => {
    expect(getOriginPolicy({
      originPolicy: 'editorial',
      tier: 'signal',
      discoveryUrl: 'https://mp.weixin.qq.com/s/example',
      sourceUrl: 'https://plink.anyfeeder.com/weixin/example',
      sourceName: 'Custom bridge',
    })).toBe('editorial');
  });
});

describe('trace SSRF safety', () => {
  it('rejects local, metadata, userinfo, mapped IPv6, and dangerous-port URLs', () => {
    for (const url of [
      'http://localhost/admin',
      'http://127.0.0.1:8080/admin',
      'http://169.254.169.254/latest/meta-data',
      'http://user:pass@example.com/article',
      'http://[::ffff:127.0.0.1]/article',
      'http://example.com:6379/article',
    ]) {
      expect(validateUrlSyntax(url).safe).toBe(false);
    }
  });

  it('fails closed when only unsafe candidates are present', async () => {
    const result = await traceOriginFromContent(
      'https://aggregator.example/feed/item',
      '<link rel="canonical" href="http://127.0.0.1:8080/internal">',
      'https://aggregator.example/feed',
    );
    expect(result.status).toBe('needs_review');
    expect(result.originalUrl).toBeNull();
  });

  it('does not probe local or metadata addresses', async () => {
    await expect(probeSafeLink('http://localhost:8080/')).resolves.toMatchObject({
      state: 'needs_review',
    });
    await expect(probeSafeLink('http://169.254.169.254/latest/meta-data')).resolves.toMatchObject({
      state: 'needs_review',
    });
  });

  it('does not treat a body link as a verified origin', async () => {
    const result = await traceOriginFromContent(
      'https://aggregator.example/feed/item',
      'Read more at https://127.0.0.1/article',
      'https://aggregator.example/feed',
    );
    expect(result.status).toBe('needs_review');
  });
});
