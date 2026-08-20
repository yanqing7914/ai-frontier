import { presentHotArticle } from '../../../server/modules/article/hot-article-presentation';

describe('Chinese-friendly hot article presentation', () => {
  it('turns a bare release version into a useful Chinese title and explanation', () => {
    const result = presentHotArticle({
      title: 'v2.1.236',
      summary: "What's changed Added ANTHROPIC_DEFAULT_MODEL environment variable: sets the model new sessions start on, while a /model pick still overrides it and persists across restarts.",
      sourceName: 'Anthropic Claude Code Releases',
      direction: 'model',
    });

    expect(result.displayTitle).toContain('Claude Code');
    expect(result.displayTitle).toContain('默认模型配置');
    expect(result.summary).toContain('ANTHROPIC_DEFAULT_MODEL');
    expect(result.summary).toContain('新会话');
  });

  it('explains a GitHub repository in Chinese instead of showing its raw slug', () => {
    const result = presentHotArticle({
      title: 'abhigyanpatwari/GitNexus',
      summary: 'GitNexus is a client-side code intelligence engine and knowledge graph creator that runs entirely in your browser.',
      sourceName: 'GitHub Trending Daily - TypeScript',
      direction: 'model',
    });

    expect(result.displayTitle).toBe('GitNexus：在浏览器内生成代码知识图谱');
    expect(result.summary).toContain('代码仓库');
    expect(result.summary).toContain('浏览器本地');
  });

  it('keeps a concise Chinese source title and trims overly long copy', () => {
    const result = presentHotArticle({
      title: '某医院部署AI导诊助手；后续还将扩展更多业务场景｜行业观察',
      summary: '某医院已在20个科室部署AI导诊助手，帮助患者分流并减少人工重复问询。',
      sourceName: '官方发布',
      direction: 'applications',
    });

    expect(result.displayTitle).toBe('某医院部署AI导诊助手');
    expect(result.summary).toContain('20个科室');
  });
});
