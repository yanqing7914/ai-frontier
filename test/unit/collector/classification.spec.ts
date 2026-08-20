describe('Stage 7 topic classification', () => {
  let service: {
    classifyArticle: (title: string, content: string, tier: string) => any;
  };

  beforeEach(() => {
    jest.resetModules();
    const { AiScoringService } = require('../../../server/modules/collector/ai-scoring.service');
    service = new AiScoringService({ load: jest.fn() });
  });

  it('classifies a Chinese coding fact with the specialized gate', () => {
    const result = service.classifyArticle(
      '编程助手正式上线',
      '该编程助手已正式上线，在大型代码库中生成代码并理解跨文件仓库，自动修复代码缺陷并完成工程重构。',
      'authoritative',
    );
    expect(result.primaryDirection).toBe('coding');
    expect(result.candidates.find((item: any) => item.direction === 'coding').eligible).toBe(true);
  });

  it('does not promote planned or rumored claims', () => {
    const result = service.classifyArticle(
      '医院计划部署助手',
      '该医院计划在医疗行业上线产品，据称可能自动化导诊流程，但尚未部署。',
      'authoritative',
    );
    expect(result.primaryDirection).toBeNull();
  });

  it('keeps a low-margin multi-direction result ambiguous', () => {
    const result = service.classifyArticle(
      '代码智能体上线',
      '该代码智能体正式上线，可自主执行多步骤任务并调用终端工具，使用多智能体工作流编排。该编程助手可生成代码、理解跨文件代码库，并自动修复代码缺陷完成工程重构。',
      'authoritative',
    );
    expect(result.evidence).toEqual(expect.arrayContaining(['agent', 'coding']));
    expect(result.ambiguous).toBe(true);
    expect(result.primaryDirection).toBeNull();
  });

  it('keeps an application keyword candidate ineligible without deployment facts', () => {
    const result = service.classifyArticle(
      '医疗 AI 应用概念',
      '文章讨论医疗行业和业务问题，并介绍一个尚未上线、没有试点的 AI 应用概念。',
      'signal',
    );
    expect(result.primaryDirection).not.toBe('applications');
  });
});
