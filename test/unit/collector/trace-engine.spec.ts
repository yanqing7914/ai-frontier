import { getOriginPolicy } from '../../../server/modules/collector/trace-engine';

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
