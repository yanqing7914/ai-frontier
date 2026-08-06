import { normalizeDirection } from '../../../shared/directions';

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
});

describe('AiScoringService AI scoring - nine direction dimensions', () => {
  it('uses direct applications dimensions from the AI plugin response', async () => {
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

    expect(result.aiProcessed).toBe(true);
    expect(result.primaryDirection).toBe('applications');
    expect(result.directionScores.applications.dimensionScores.industry).toBe(
      5,
    );
    expect(result.directionScores.applications.normalizedScore).toBe(40);
    expect(load).toHaveBeenCalledWith('ai_article_scoring_1');
    expect(call).toHaveBeenCalledWith(
      'textToJson',
      expect.objectContaining({
        article_text: expect.stringContaining('智能座舱助手在量产车型上线'),
      }),
    );
  });

  it('keeps legacy eight-direction plugin output compatible', async () => {
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

    expect(result.aiProcessed).toBe(true);
    expect(result.primaryDirection).toBe('safety_governance');
    expect(result.directionScores.safety_governance.normalizedScore).toBe(40);
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

    expect(result.directionScores.model.dimensionScores.entity).toBe(2.5);
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
