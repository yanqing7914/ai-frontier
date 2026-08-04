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
  let scoringService: { ruleBasedScoreArticle: (t: string, c: string, s: string) => unknown };

  beforeEach(() => {
    jest.resetModules();
    const { AiScoringService } = require('../../../server/modules/collector/ai-scoring.service');
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
      title, content, 'authoritative',
    ) as { primaryDirection: string | null; directionScores: Record<string, { normalizedScore: number }> };

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
      title, content, 'authoritative',
    ) as { primaryDirection: string | null; directionScores: Record<string, { normalizedScore: number }> };

    expect(result.primaryDirection).toBe('business_ecosystem');
  });

  it('classifies policy/regulation article as safety_governance', () => {
    const title = 'Global AI Regulation and Safety Governance Framework Adopted';
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
      title, content, 'authoritative',
    ) as { primaryDirection: string | null; primaryScore: number; directionScores: Record<string, { normalizedScore: number }> };

    expect(result.primaryDirection).toBe('safety_governance');
  });

  it('classifies dataset+benchmark article as data_eval', () => {
    const title = 'New Dataset with 50000 Samples Released for MMLU Benchmark Evaluation';
    const content = [
      'A new open source dataset with 50000 samples was released for',
      'multilingual benchmark evaluation. The MMLU leaderboard shows GPT-4',
      'achieving 87% accuracy. The methodology uses novel metrics for',
      'reproducibility assessment. Open source code is available under MIT',
      'license. The evaluation framework protocol covers 200 task categories.',
    ].join(' ');

    const result = scoringService.ruleBasedScoreArticle(
      title, content, 'authoritative',
    ) as { primaryDirection: string | null; directionScores: Record<string, { normalizedScore: number }> };

    expect(result.primaryDirection).toBe('data_eval');
  });
});
