export type Direction =
  | 'model' | 'agent' | 'multimodal' | 'coding'
  | 'infrastructure' | 'data_eval' | 'safety_governance'
  | 'applications' | 'business_ecosystem';

export interface DirectionMeta {
  id: Direction;
  label: string;
  name: string;
  sortOrder: number;
  bg: string;
  fg: string;
  dimensions: string[];
}

export interface DirectionScoringPolicy {
  weights: Record<string, number>;
  coreDimensions: string[];
  /** Number of core dimensions that must have direct evidence for eligibility. */
  minCoreEvidence: number;
  /** Number of non-zero dimensions needed to avoid a keyword-only score. */
  minEvidenceDimensions: number;
  maxWithoutCoreEvidence: number;
}

export const DIRECTIONS: DirectionMeta[] = [
  {
    id: 'model', label: '模型', name: 'Model', sortOrder: 1,
    bg: 'hsl(265,48%,60%)', fg: 'hsl(265,55%,28%)',
    dimensions: ['entity', 'capability', 'availability', 'performance', 'cost', 'ecosystem', 'adoption'],
  },
  {
    id: 'agent', label: '智能体', name: 'Agent', sortOrder: 2,
    bg: 'hsl(220,50%,58%)', fg: 'hsl(220,60%,25%)',
    dimensions: ['task_boundary', 'tool_call', 'protocol', 'orchestration', 'observability', 'production', 'benchmark', 'workflow'],
  },
  {
    id: 'multimodal', label: '多模态', name: 'Multimodal', sortOrder: 3,
    bg: 'hsl(310,42%,58%)', fg: 'hsl(310,50%,28%)',
    dimensions: ['modality_coverage', 'io_capability', 'quality', 'realtime', 'editing', '3d_world', 'safety_copyright', 'product'],
  },
  {
    id: 'coding', label: '编程', name: 'Coding', sortOrder: 4,
    bg: 'hsl(170,45%,48%)', fg: 'hsl(170,55%,22%)',
    dimensions: ['code_gen', 'repo_understanding', 'engineering', 'ide_integration', 'delivery', 'benchmark', 'cost_speed', 'security'],
  },
  {
    id: 'infrastructure', label: '基础设施', name: 'Infrastructure', sortOrder: 5,
    bg: 'hsl(195,50%,50%)', fg: 'hsl(195,60%,22%)',
    dimensions: ['hardware', 'training', 'performance', 'cost', 'software_stack', 'cloud', 'edge', 'ops'],
  },
  {
    id: 'data_eval', label: '数据与评测', name: 'Data & Evaluation', sortOrder: 6,
    bg: 'hsl(45,55%,52%)', fg: 'hsl(45,65%,25%)',
    dimensions: ['data_asset', 'coverage', 'methodology', 'reproducibility', 'performance', 'quality', 'governance', 'decision_value'],
  },
  {
    id: 'safety_governance', label: '安全治理', name: 'Safety & Governance', sortOrder: 7,
    bg: 'hsl(0,48%,58%)', fg: 'hsl(0,58%,28%)',
    dimensions: ['risk_type', 'controls', 'verification', 'privacy', 'copyright', 'regulation', 'framework', 'deployment_impact'],
  },
  {
    id: 'applications', label: '应用落地', name: 'Applications', sortOrder: 8,
    bg: 'hsl(150,45%,50%)', fg: 'hsl(150,55%,22%)',
    dimensions: ['industry', 'business_problem', 'launch_status', 'scale', 'roi', 'workflow_change', 'replicability', 'risk_responsibility'],
  },
  {
    id: 'business_ecosystem', label: '商业生态', name: 'Business Ecosystem', sortOrder: 9,
    bg: 'hsl(30,50%,52%)', fg: 'hsl(30,60%,25%)',
    dimensions: ['business_fact', 'entity_market', 'strategy', 'business_model', 'market_landscape', 'open_source', 'talent', 'signal'],
  },
];

export const ALL_DIRECTION_IDS: Direction[] = DIRECTIONS.map((d) => d.id);

/** Direction-specific scorecards keep the nine editorial directions distinct. */
export const DIRECTION_SCORING_POLICIES: Record<Direction, DirectionScoringPolicy> = {
  model: {
    weights: { entity: 1.5, capability: 2, availability: 1, performance: 1.5, cost: 1, ecosystem: 1, adoption: 1 },
    coreDimensions: ['entity', 'capability'], minCoreEvidence: 2, minEvidenceDimensions: 3, maxWithoutCoreEvidence: 12,
  },
  agent: {
    weights: { task_boundary: 1.5, tool_call: 1.5, protocol: 1, orchestration: 1.5, observability: 0.75, production: 1.5, benchmark: 0.75, workflow: 1.5 },
    coreDimensions: ['task_boundary', 'tool_call', 'orchestration'], minCoreEvidence: 2, minEvidenceDimensions: 3, maxWithoutCoreEvidence: 12,
  },
  multimodal: {
    weights: { modality_coverage: 1.5, io_capability: 1.5, quality: 1, realtime: 1, editing: 0.75, '3d_world': 1, safety_copyright: 0.75, product: 1 },
    coreDimensions: ['modality_coverage', 'io_capability'], minCoreEvidence: 2, minEvidenceDimensions: 2, maxWithoutCoreEvidence: 12,
  },
  coding: {
    weights: { code_gen: 1.5, repo_understanding: 1.25, engineering: 1.5, ide_integration: 1, delivery: 1, benchmark: 0.75, cost_speed: 0.75, security: 0.75 },
    coreDimensions: ['code_gen', 'engineering', 'repo_understanding'], minCoreEvidence: 2, minEvidenceDimensions: 3, maxWithoutCoreEvidence: 12,
  },
  infrastructure: {
    weights: { hardware: 1.5, training: 1, performance: 1.5, cost: 1, software_stack: 1.25, cloud: 1.25, edge: 0.75, ops: 0.75 },
    coreDimensions: ['hardware', 'performance', 'software_stack'], minCoreEvidence: 2, minEvidenceDimensions: 2, maxWithoutCoreEvidence: 12,
  },
  data_eval: {
    weights: { data_asset: 1.5, coverage: 1, methodology: 1.5, reproducibility: 1.25, performance: 1.25, quality: 1, governance: 1, decision_value: 0.75 },
    coreDimensions: ['data_asset', 'methodology', 'performance'], minCoreEvidence: 2, minEvidenceDimensions: 3, maxWithoutCoreEvidence: 10,
  },
  safety_governance: {
    weights: { risk_type: 1.25, controls: 1.5, verification: 1.5, privacy: 1, copyright: 1, regulation: 1.25, framework: 1.25, deployment_impact: 1 },
    coreDimensions: ['risk_type', 'controls', 'verification', 'regulation'], minCoreEvidence: 2, minEvidenceDimensions: 2, maxWithoutCoreEvidence: 10,
  },
  applications: {
    weights: { industry: 1.25, business_problem: 1.5, launch_status: 1.5, scale: 1, roi: 1.25, workflow_change: 1.25, replicability: 0.75, risk_responsibility: 1 },
    coreDimensions: ['industry', 'business_problem', 'launch_status'], minCoreEvidence: 2, minEvidenceDimensions: 3, maxWithoutCoreEvidence: 10,
  },
  business_ecosystem: {
    weights: { business_fact: 1.5, entity_market: 1.25, strategy: 1.25, business_model: 1.5, market_landscape: 1.25, open_source: 0.75, talent: 0.75, signal: 1 },
    coreDimensions: ['business_fact', 'entity_market', 'strategy', 'business_model'], minCoreEvidence: 2, minEvidenceDimensions: 2, maxWithoutCoreEvidence: 10,
  },
};

export function getDirectionScoringPolicy(id: Direction): DirectionScoringPolicy {
  return DIRECTION_SCORING_POLICIES[id];
}

export const LEGACY_DIRECTION_MAP: Record<string, Direction> = {
  multi: 'multimodal',
  infra: 'infrastructure',
  eval: 'data_eval',
  data: 'data_eval',
  security: 'safety_governance',
};

export function normalizeDirection(raw: string | null | undefined): Direction | null {
  if (!raw) return null;
  if (LEGACY_DIRECTION_MAP[raw]) return LEGACY_DIRECTION_MAP[raw];
  if (ALL_DIRECTION_IDS.includes(raw as Direction)) return raw as Direction;
  return null;
}


export function isValidDirection(value: string): value is Direction {
  return ALL_DIRECTION_IDS.includes(value as Direction);
}

export function getDirectionMeta(id: Direction): DirectionMeta | undefined {
  return DIRECTIONS.find((d) => d.id === id);
}

export const MAX_DIRECTION_SCORE = 40;
export const FACT_THRESHOLD = 20;
export const DIMENSION_FULL = 5;
export const DIMENSION_HALF = 2.5;
