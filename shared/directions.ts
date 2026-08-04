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
