import { normalizeDirection } from '../../../shared/directions';
import { DIRECTION_SCORING_POLICIES } from '../../../shared/directions';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('AI scoring capability configuration', () => {
  it('keeps every output-field description within the platform limit', () => {
    const capability = JSON.parse(
      readFileSync(
        resolve(process.cwd(), 'server/capabilities/ai_article_scoring_1.json'),
        'utf8',
      ),
    ) as { formValue: { jsonStructure: Array<{ paramDescription: string }> } };

    for (const field of capability.formValue.jsonStructure) {
      expect(field.paramDescription.length).toBeLessThanOrEqual(500);
    }
  });

  it('puts the nine direction schemas in the prompt rather than one limited field description', () => {
    const capability = JSON.parse(
      readFileSync(
        resolve(process.cwd(), 'server/capabilities/ai_article_scoring_1.json'),
        'utf8',
      ),
    ) as { formValue: { prompt: string; jsonStructure: Array<{ name: string }> } };

    expect(capability.formValue.prompt).toContain('model: {entity,capability');
    expect(capability.formValue.prompt).toContain('business_ecosystem: {business_fact');
    expect(capability.formValue.jsonStructure.map((field) => field.name)).toContain('evidence');
  });
});

describe('normalizeDirection - unknown direction handling', () => {
  it('returns null for unknown_direction', () => {
    expect(normalizeDirection('unknown_direction')).toBeNull();
  });

  it('returns null for automotive', () => {
    expect(normalizeDirection('automotive')).toBeNull();
  });

  it('returns null for robotics', () => {
    expect(normalizeDirection('robotics')).toBeNull();
  });

  it('does NOT default to model for unknown values', () => {
    const result = normalizeDirection('random_garbage');
    expect(result).toBeNull();
    expect(result).not.toBe('model');
    expect(result).not.toBe('agent');
  });

  it('returns null for empty string', () => {
    expect(normalizeDirection('')).toBeNull();
  });

  it('returns null for null', () => {
    expect(normalizeDirection(null)).toBeNull();
  });

  it('returns null for undefined', () => {
    expect(normalizeDirection(undefined)).toBeNull();
  });

  it('passes through valid directions', () => {
    expect(normalizeDirection('model')).toBe('model');
    expect(normalizeDirection('agent')).toBe('agent');
    expect(normalizeDirection('applications')).toBe('applications');
    expect(normalizeDirection('business_ecosystem')).toBe('business_ecosystem');
  });

  it('maps legacy directions correctly', () => {
    expect(normalizeDirection('multi')).toBe('multimodal');
    expect(normalizeDirection('infra')).toBe('infrastructure');
    expect(normalizeDirection('eval')).toBe('data_eval');
    expect(normalizeDirection('data')).toBe('data_eval');
    expect(normalizeDirection('security')).toBe('safety_governance');
  });
});

describe('nine direction scorecards', () => {
  let scoringService: {
    ruleBasedScoreArticle: (t: string, c: string, s: string) => unknown;
  };

  beforeEach(() => {
    jest.resetModules();
    const {
      AiScoringService,
    } = require('../../../server/modules/collector/ai-scoring.service');
    scoringService = new AiScoringService({ load: jest.fn(), call: jest.fn() });
  });

  it('assigns independent core evidence requirements to every direction', () => {
    expect(Object.keys(DIRECTION_SCORING_POLICIES)).toHaveLength(9);
    for (const policy of Object.values(DIRECTION_SCORING_POLICIES)) {
      expect(policy.coreDimensions.length).toBeGreaterThan(0);
      expect(policy.maxWithoutCoreEvidence).toBeLessThan(20);
    }
  });

  it('does not use one shared weight profile across all directions', () => {
    expect(DIRECTION_SCORING_POLICIES.model.weights.capability).toBe(2);
    expect(DIRECTION_SCORING_POLICIES.applications.weights.business_problem).toBe(1.5);
    expect(DIRECTION_SCORING_POLICIES.safety_governance.weights.verification).toBe(1.5);
    expect(DIRECTION_SCORING_POLICIES.model.coreDimensions).not.toEqual(
      DIRECTION_SCORING_POLICIES.applications.coreDimensions,
    );
  });

  it('sets distinct core evidence thresholds per direction', () => {
    for (const policy of Object.values(DIRECTION_SCORING_POLICIES)) {
      expect(policy.minCoreEvidence).toBeGreaterThan(0);
      expect(policy.minEvidenceDimensions).toBeGreaterThanOrEqual(
        policy.minCoreEvidence,
      );
    }
    expect(DIRECTION_SCORING_POLICIES.applications.minEvidenceDimensions).toBe(3);
    expect(DIRECTION_SCORING_POLICIES.model.minEvidenceDimensions).toBe(3);
  });

  it('requires two model core dimensions plus breadth to become primary', () => {
    const result = scoringService.ruleBasedScoreArticle(
      'GPT-6 reaches 95% on MMLU',
      'OpenAI released GPT-6 version 6.0. It reaches a record MMLU benchmark score of 95%.',
      'authoritative',
    ) as {
      primaryDirection: string | null;
      directionScores: Record<string, { normalizedScore: number }>;
    };

    expect(result.primaryDirection).toBe('model');
    expect(result.directionScores.model.normalizedScore).toBeGreaterThan(0);
  });

  it('caps publish score without strong multi-dimension evidence', () => {
    const result = scoringService.ruleBasedScoreArticle(
      'AI model API update',
      'OpenAI released a new model API. The model is available now with lower cost.',
      'authoritative',
    ) as {
      primaryDirection: string | null;
      publishScore: number;
    };

    expect(result.primaryDirection).toBeNull();
    expect(result.publishScore).toBeLessThan(40);
  });
});

describe('AiScoringService ruleBasedScoreArticle - direction classification', () => {
  let scoringService: {
    ruleBasedScoreArticle: (t: string, c: string, s: string) => unknown;
  };

  beforeEach(() => {
    jest.resetModules();
    const {
      AiScoringService,
    } = require('../../../server/modules/collector/ai-scoring.service');
    scoringService = new AiScoringService({ load: jest.fn(), call: jest.fn() });
  });

  it('classifies automotive/robot industry article as applications', () => {
    const title = 'Waymo Launches Autonomous Driving Service in Phoenix';
    const content = [
      'Waymo launched its autonomous driving robotaxi service now in Phoenix,',
      'serving over 50000 daily rides across 3 cities. Toyota deployed the',
      'robotic fleet for enterprise logistics automation. ROI improved by 35%',
      'with significant workflow change in manufacturing industry operations.',
      'The healthcare and automotive verticals see production-ready deployment.',
    ].join(' ');

    const result = scoringService.ruleBasedScoreArticle(
      title,
      content,
      'authoritative',
    ) as {
      primaryDirection: string | null;
      directionScores: Record<string, { normalizedScore: number }>;
    };

    expect(result.primaryDirection).toBe('applications');
  });

  it('classifies funding/acquisition article as business_ecosystem', () => {
    const title = 'OpenAI Raises $6.6 Billion in Series F Funding';
    const content = [
      'OpenAI raised $6.6 billion in funding led by Thrive Capital.',
      'The company valuation reached $150 billion. Microsoft expanded its',
      'strategic partnership with a new $10 billion investment deal.',
      'The acquisition signals major market consolidation. IPO rumors grow',
      'as enterprise customers expand. Series F funding round confirmed.',
    ].join(' ');

    const result = scoringService.ruleBasedScoreArticle(
      title,
      content,
      'authoritative',
    ) as {
      primaryDirection: string | null;
      directionScores: Record<string, { normalizedScore: number }>;
    };

    expect(result.primaryDirection).toBe('business_ecosystem');
  });

  it('classifies policy/regulation article as safety_governance', () => {
    const title =
      'Global AI Regulation and Safety Governance Framework Adopted';
    const content = [
      'The EU AI Act regulation entered into force today requiring',
      'mandatory risk assessments. China published new AI governance',
      'guidelines. The US executive order mandates AI safety audits and',
      'verification of foundation models. Policy proposals target guardrails',
      'and safeguards for AI deployment. Privacy regulations and copyright',
      'disputes are emerging as key risk types. Regulatory frameworks must',
      'be established for responsible AI governance adoption worldwide.',
    ].join(' ');

    const result = scoringService.ruleBasedScoreArticle(
      title,
      content,
      'authoritative',
    ) as {
      primaryDirection: string | null;
      primaryScore: number;
      directionScores: Record<string, { normalizedScore: number }>;
    };

    expect(result.primaryDirection).toBe('safety_governance');
  });

  it('classifies dataset+benchmark article as data_eval', () => {
    const title =
      'New Dataset with 50000 Samples Released for MMLU Benchmark Evaluation';
    const content = [
      'A new open source dataset with 50000 samples was released for',
      'multilingual benchmark evaluation. The MMLU leaderboard shows GPT-4',
      'achieving 87% accuracy. The methodology uses novel metrics for',
      'reproducibility assessment. Open source code is available under MIT',
      'license. The evaluation framework protocol covers 200 task categories.',
    ].join(' ');

    const result = scoringService.ruleBasedScoreArticle(
      title,
      content,
      'authoritative',
    ) as {
      primaryDirection: string | null;
      directionScores: Record<string, { normalizedScore: number }>;
    };

    expect(result.primaryDirection).toBe('data_eval');
  });

  it('does not promote a generic utility repository into an AI direction', () => {
    const result = scoringService.ruleBasedScoreArticle(
      'yt-dlp: A feature-rich command-line audio/video downloader',
      'A command-line program to download videos and audio from many websites. '
        + 'Supports subtitles, playlists, and multiple output formats.',
      'signal',
    ) as { primaryDirection: string | null; primaryScore: number };

    expect(result.primaryDirection).toBeNull();
    expect(result.primaryScore).toBe(0);
  });

  it('requires business evidence for applications instead of a generic product mention', () => {
    const result = scoringService.ruleBasedScoreArticle(
      'New AI assistant demo',
      'A demo shows an assistant answering questions in a browser.',
      'signal',
    ) as {
      primaryDirection: string | null;
      directionScores: Record<string, { normalizedScore: number }>;
    };

    expect(result.directionScores.applications.normalizedScore).toBeLessThanOrEqual(10);
    expect(result.primaryDirection).not.toBe('applications');
  });
});

describe('AiScoringService AI scoring - nine direction dimensions', () => {
  it('degrades unsupported direct applications dimensions from the AI plugin response', async () => {
    const pluginOutput = {
      summary: '某车企把智能座舱助手部署到量产车型。',
      scores: {
        model: {
          entity: 0,
          capability: 0,
          availability: 0,
          performance: 0,
          cost: 0,
          ecosystem: 0,
          adoption: 0,
        },
        agent: {
          task_boundary: 0,
          tool_call: 0,
          protocol: 0,
          orchestration: 0,
          observability: 0,
          production: 0,
          benchmark: 0,
          workflow: 0,
        },
        multimodal: {
          modality_coverage: 0,
          io_capability: 0,
          quality: 0,
          realtime: 0,
          editing: 0,
          '3d_world': 0,
          safety_copyright: 0,
          product: 0,
        },
        coding: {
          code_gen: 0,
          repo_understanding: 0,
          engineering: 0,
          ide_integration: 0,
          delivery: 0,
          benchmark: 0,
          cost_speed: 0,
          security: 0,
        },
        infrastructure: {
          hardware: 0,
          training: 0,
          performance: 0,
          cost: 0,
          software_stack: 0,
          cloud: 0,
          edge: 0,
          ops: 0,
        },
        data_eval: {
          data_asset: 0,
          coverage: 0,
          methodology: 0,
          reproducibility: 0,
          performance: 0,
          quality: 0,
          governance: 0,
          decision_value: 0,
        },
        safety_governance: {
          risk_type: 0,
          controls: 0,
          verification: 0,
          privacy: 0,
          copyright: 0,
          regulation: 0,
          framework: 0,
          deployment_impact: 0,
        },
        applications: {
          industry: 5,
          business_problem: 5,
          launch_status: 5,
          scale: 5,
          roi: 5,
          workflow_change: 5,
          replicability: 5,
          risk_responsibility: 5,
        },
        business_ecosystem: {
          business_fact: 0,
          entity_market: 0,
          strategy: 0,
          business_model: 0,
          market_landscape: 0,
          open_source: 0,
          talent: 0,
          signal: 0,
        },
      },
    };
    const call = jest.fn().mockResolvedValue(pluginOutput);
    const load = jest.fn().mockReturnValue({ call });
    const {
      AiScoringService,
    } = require('../../../server/modules/collector/ai-scoring.service');
    const service = new AiScoringService({ load });

    const result = await service.scoreArticle(
      '智能座舱助手在量产车型上线',
      '一家汽车企业上线智能座舱助手。',
      'signal',
    );

    expect(result.aiProcessed).toBe(false);
    expect(result.primaryDirection).toBeNull();
    expect(result.directionScores.applications.dimensionScores.industry).toBe(0);
    expect(result.directionScores.applications.normalizedScore).toBeLessThan(40);
    expect(result.degradeReason).toContain('complete text-grounded evidence chain');
    expect(load).toHaveBeenCalledWith('ai_article_scoring_1');
    expect(call).toHaveBeenCalledWith(
      'textToJson',
      expect.objectContaining({
        article_text: expect.stringContaining('智能座舱助手在量产车型上线'),
      }),
    );
  });

  it('degrades legacy score-only plugin output because it has no evidence chain', async () => {
    const call = jest.fn().mockResolvedValue({
      summary: '兼容旧版输出。',
      scores: {
        security: {
          novelty: 20,
          depth: 20,
          impact: 20,
          authority: 20,
          timeliness: 20,
        },
      },
    });
    const {
      AiScoringService,
    } = require('../../../server/modules/collector/ai-scoring.service');
    const service = new AiScoringService({
      load: jest.fn().mockReturnValue({ call }),
    });

    const result = await service.scoreArticle(
      'AI监管框架发布',
      '新的AI监管和安全治理框架已经发布。',
      'authoritative',
    );

    expect(result.aiProcessed).toBe(false);
    expect(result.primaryDirection).toBeNull();
    expect(result.degradeReason).toContain('summary is empty, ungrounded, or exceeds 200 characters');
  });

  it('degrades when the plugin returns a summary without usable scores', async () => {
    const service = new (
      require('../../../server/modules/collector/ai-scoring.service')
        .AiScoringService
    )({
      load: jest.fn().mockReturnValue({
        call: jest.fn().mockResolvedValue({ summary: '只有摘要。' }),
      }),
    });

    const result = await service.scoreArticle(
      'OpenAI launches a new model API',
      'OpenAI released an API with benchmark results.',
      'signal',
    );

    expect(result.aiProcessed).toBe(false);
    expect(result.degradeReason).toContain('missing usable direction scores');
  });

  it('preserves half-point dimensions returned by the plugin', async () => {
    const service = new (
      require('../../../server/modules/collector/ai-scoring.service')
        .AiScoringService
    )({
      load: jest.fn().mockReturnValue({
        call: jest.fn().mockResolvedValue({
          summary: '模型 API 更新。',
          scores: { model: { entity: 2.5 } },
        }),
      }),
    });

    const result = await service.scoreArticle(
      'Model API update',
      'A model API update is available.',
      'signal',
    );

    expect(result.directionScores.model.dimensionScores.entity).toBe(0);
  });

  it('accepts a complete, text-grounded application evidence chain', async () => {
    const title = '某医院已将导诊助手部署到20个科室';
    const content = '某医院已将导诊助手部署到20个科室，解决患者候诊时间过长的问题。上线后平均候诊时间下降30%。';
    const service = new (
      require('../../../server/modules/collector/ai-scoring.service')
        .AiScoringService
    )({
      load: jest.fn().mockReturnValue({
        call: jest.fn().mockResolvedValue({
          summary: '某医院部署导诊助手，候诊时间下降30%。',
          scores: {
            applications: {
              industry: 5, business_problem: 5, launch_status: 5,
              scale: 5, roi: 5, workflow_change: 0,
              replicability: 0, risk_responsibility: 0,
            },
          },
          evidence: [
            {
              direction: 'applications', dimension: 'industry', score: 5,
              quote: '某医院已将导诊助手部署到20个科室', subject: '某医院',
              predicate: '部署', object: '导诊助手', certainty: 'fact',
              fields: { industry: '医院', adopter: '某医院', use_case: '导诊助手' },
            },
            {
              direction: 'applications', dimension: 'business_problem', score: 5,
              quote: '解决患者候诊时间过长的问题', subject: '患者',
              predicate: '解决', object: '患者候诊时间过长的问题', certainty: 'fact',
              fields: { problem: '患者候诊时间过长的问题', baseline: '候诊时间过长' },
            },
            {
              direction: 'applications', dimension: 'launch_status', score: 5,
              quote: '某医院已将导诊助手部署到20个科室', subject: '某医院',
              predicate: '部署', object: '导诊助手', certainty: 'fact',
              fields: { status: 'deployed', adopter: '某医院', environment: '20个科室' },
            },
            {
              direction: 'applications', dimension: 'scale', score: 5,
              quote: '某医院已将导诊助手部署到20个科室', subject: '某医院',
              predicate: '部署', object: '20个科室', certainty: 'fact',
              fields: { metric: '科室', value: 20, unit: '个', period: '部署' },
            },
            {
              direction: 'applications', dimension: 'roi', score: 5,
              quote: '上线后平均候诊时间下降30%', subject: '平均候诊时间',
              predicate: '下降', object: '30%', certainty: 'fact',
              fields: { metric: '平均候诊时间', value: 30, unit: '%', baseline: '上线后' },
            },
          ],
        }),
      }),
    });

    const result = await service.scoreArticle(title, content, 'authoritative');

    expect(result.primaryDirection).toBe('applications');
    expect(result.directionScores.applications.dimensionScores.roi).toBe(5);
    expect(result.directionScores.applications.normalizedScore).toBeGreaterThan(20);
  });

  it('rejects invented quotes and caps planned deployment evidence', async () => {
    const service = new (
      require('../../../server/modules/collector/ai-scoring.service')
        .AiScoringService
    )({
      load: jest.fn().mockReturnValue({
        call: jest.fn().mockResolvedValue({
          summary: '厂商计划展示医疗助手。',
          scores: {
            applications: {
              industry: 5, business_problem: 5, launch_status: 5,
              scale: 0, roi: 0, workflow_change: 0,
              replicability: 0, risk_responsibility: 0,
            },
          },
          evidence: [
            {
              direction: 'applications', dimension: 'industry', score: 5,
              quote: '某医院已经部署到100家门店', subject: '某医院',
              predicate: '部署', object: '助手', certainty: 'fact',
              fields: { industry: '医疗', adopter: '某医院' },
            },
            {
              direction: 'applications', dimension: 'launch_status', score: 5,
              quote: '厂商计划展示医疗助手', subject: '厂商',
              predicate: '计划展示', object: '医疗助手', certainty: 'planned',
              fields: { status: 'planned', date: '未来' },
            },
          ],
        }),
      }),
    });

    const result = await service.scoreArticle(
      '医疗助手计划发布',
      '厂商计划展示医疗助手，尚未开始客户试点。',
      'signal',
    );

    expect(result.primaryDirection).toBeNull();
    expect(result.directionScores.applications.dimensionScores.industry).toBe(0);
    expect(result.directionScores.applications.dimensionScores.launch_status).toBe(2.5);
    expect(result.aiProcessed).toBe(false);
  });

  it('caps full scores whose structured facts are not present in the quote', async () => {
    const title = 'OpenAI 发布 GPT-5';
    const content = 'OpenAI 发布 GPT-5，并表示模型在推理任务上有所提升。';
    const service = new (
      require('../../../server/modules/collector/ai-scoring.service')
        .AiScoringService
    )({
      load: jest.fn().mockReturnValue({
        call: jest.fn().mockResolvedValue({
          summary: 'OpenAI 发布 GPT-5。',
          scores: {
            model: { entity: 5, capability: 5, performance: 5 },
          },
          evidence: [
            {
              direction: 'model', dimension: 'entity', score: 5,
              quote: 'OpenAI 发布 GPT-5', subject: 'OpenAI', predicate: '发布', object: 'GPT-5',
              certainty: 'fact', fields: { model_name: 'GPT-5', provider: 'OpenAI' },
            },
            {
              direction: 'model', dimension: 'capability', score: 5,
              quote: '模型在推理任务上有所提升', subject: '模型', predicate: '提升', object: '推理任务',
              certainty: 'fact', fields: { task: '推理任务', capability_change: '提升' },
            },
            {
              direction: 'model', dimension: 'performance', score: 5,
              quote: '模型在推理任务上有所提升', subject: '模型', predicate: '提升', object: '推理任务',
              certainty: 'fact', fields: { metric: 'MMLU', value: 95, unit: '%' },
            },
          ],
        }),
      }),
    });

    const result = await service.scoreArticle(title, content, 'authoritative');

    expect(result.directionScores.model.dimensionScores.entity).toBe(5);
    // The model cannot use the made-up performance field to prove its claim;
    // the score remains tied to its own actual quote tuple.
    expect(result.directionScores.model.dimensionScores.performance).toBe(2.5);
    expect(result.primaryDirection).toBeNull();
  });

  it.each([
    [
      'multimodal',
      '图像到视频生成',
      '该产品接收图像输入并生成视频，延迟为 120 ms。',
      ['modality_coverage', 'io_capability', 'realtime'],
      [
        { dimension: 'modality_coverage', quote: '接收图像输入并生成视频', subject: '图像输入', predicate: '生成', object: '视频', fields: { modalities: ['图像', '视频'], operation: '生成视频' } },
        { dimension: 'io_capability', quote: '接收图像输入并生成视频', subject: '图像输入', predicate: '生成', object: '视频', fields: { input_modality: '图像', output_modality: '视频', operation: '生成' } },
        { dimension: 'realtime', quote: '延迟为 120 ms', subject: '延迟', predicate: '为', object: '120 ms', fields: { metric: '延迟', value: 120, unit: 'ms', mode: '延迟' } },
      ],
    ],
    [
      'infrastructure',
      '云端推理集群',
      '云服务商为模型推理部署 GPU 集群，模型推理吞吐达到 1000 tokens/s，vLLM 优化模型推理。',
      ['cloud', 'performance', 'software_stack'],
      [
        { dimension: 'cloud', quote: '云服务商为模型推理部署 GPU 集群', subject: '云服务商', predicate: '部署', object: 'GPU 集群', fields: { provider: '云服务商', service: '模型推理', capacity: 'GPU 集群' } },
        { dimension: 'performance', quote: '模型推理吞吐达到 1000 tokens/s', subject: '模型推理', predicate: '达到', object: '1000 tokens/s', fields: { metric: '吞吐', value: 1000, unit: 'tokens/s', workload: '模型推理' } },
        { dimension: 'software_stack', quote: 'vLLM 优化模型推理', subject: 'vLLM', predicate: '优化', object: '模型推理', fields: { package: 'vLLM', optimization: '优化', workload: '模型推理' } },
      ],
    ],
    [
      'data_eval',
      '评测协议发布',
      '研究团队发布 EvalSet v1 数据集，EvalSet v1 覆盖 20 个任务，并公开评测协议和 MIT 许可证。',
      ['data_asset', 'coverage', 'methodology'],
      [
        { dimension: 'data_asset', quote: '研究团队发布 EvalSet v1 数据集', subject: '研究团队', predicate: '发布', object: 'EvalSet v1 数据集', fields: { asset_name: 'EvalSet v1', version: 'v1' } },
        { dimension: 'coverage', quote: 'EvalSet v1 覆盖 20 个任务', subject: 'EvalSet v1', predicate: '覆盖', object: '20 个任务', fields: { scope: '任务', count: 20 } },
        { dimension: 'methodology', quote: '公开评测协议', subject: '评测协议', predicate: '公开', object: '评测协议', fields: { protocol: '评测协议', metric: '公开', baseline: '评测协议' } },
      ],
    ],
    [
      'safety_governance',
      '提示注入防护',
      '红队发现提示注入可导致访问控制越权，团队针对提示注入部署沙箱控制，并完成审计测试。',
      ['risk_type', 'controls', 'verification'],
      [
        { dimension: 'risk_type', quote: '提示注入可导致访问控制越权', subject: '提示注入', predicate: '导致', object: '访问控制越权', fields: { risk_class: '提示注入', target_system: '访问控制', harm: '越权' } },
        { dimension: 'controls', quote: '针对提示注入部署沙箱控制', subject: '提示注入', predicate: '部署', object: '沙箱控制', fields: { control_type: '沙箱控制', threat: '提示注入', scope: '沙箱控制' } },
        { dimension: 'verification', quote: '完成审计测试', subject: '审计测试', predicate: '完成', object: '审计测试', fields: { method: '审计测试', result: '完成', date: '完成' } },
      ],
    ],
    [
      'business_ecosystem',
      '融资与战略合作',
      '公司完成 5000 万美元融资，并与云服务商签署战略合作协议。',
      ['business_fact', 'strategy', 'signal'],
      [
        { dimension: 'business_fact', quote: '公司完成 5000 万美元融资', subject: '公司', predicate: '完成', object: '5000 万美元融资', fields: { event_type: '融资', parties: '公司', amount: '5000 万美元', status: 'completed' } },
        { dimension: 'strategy', quote: '与云服务商签署战略合作协议', subject: '云服务商', predicate: '签署', object: '战略合作协议', fields: { action: '签署', counterpart: '云服务商', scope: '战略合作协议', status: 'signed' } },
        { dimension: 'signal', quote: '与云服务商签署战略合作协议', subject: '云服务商', predicate: '签署', object: '战略合作协议', fields: { signal_type: '合作', parties: '云服务商', status: 'signed', scope: '战略合作协议' } },
      ],
    ],
  ])('accepts a complete %s evidence chain', async (direction, title, content, dimensions, entries) => {
    const scores = Object.fromEntries(dimensions.map((dimension) => [dimension, 5]));
    const evidence = entries.map((entry) => ({
      direction,
      score: 5,
      certainty: 'fact',
      ...entry,
    }));
    const service = new (
      require('../../../server/modules/collector/ai-scoring.service')
        .AiScoringService
    )({
      load: jest.fn().mockReturnValue({
        call: jest.fn().mockResolvedValue({ summary: title, scores: { [direction]: scores }, evidence }),
      }),
    });

    const result = await service.scoreArticle(title, content, 'authoritative');
    expect(result.primaryDirection).toBe(direction);
    expect(result.directionScores[direction].hasClearEvidence).toBe(true);
  });

  it('allows strong signal-source evidence to reach the default threshold', () => {
    const service = new (
      require('../../../server/modules/collector/ai-scoring.service')
        .AiScoringService
    )({ load: jest.fn() });
    const result = service.ruleBasedScoreArticle(
      'OpenAI releases GPT-6 API with record benchmark and 50% lower cost',
      [
        'OpenAI released GPT-6 version 6.0 today with API and SDK access.',
        'It reaches a record MMLU benchmark score of 95% and costs $1 per million tokens.',
        'The model integrates with PyTorch and is deployed by 50000 enterprise users.',
        'This industry-first breakthrough is a significant milestone with revolutionary impact.',
        'Evidence: https://openai.com/research/gpt-6. ',
        'Detailed technical analysis. '.repeat(140),
      ].join(' '),
      'signal',
    );

    expect(result.publishScore).toBeGreaterThanOrEqual(75);
  });
});
