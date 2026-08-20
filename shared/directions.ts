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
  /** Human-readable version of the actual direction gate, shown to operators. */
  eligibilitySummary: string;
}

/**
 * Field contract for a 5-point evidence item. Field values named here must be
 * recoverable from its quote (except canonical status values such as
 * "deployed", which are checked against the quoted action).
 */
export interface DirectionEvidenceRequirement {
  required: string[];
  oneOf?: string[];
}

export const DIMENSION_FULL = 5;
export const DIMENSION_HALF = 2.5;

/**
 * A direction is eligible only when its own editorial facts form a complete
 * story. This is deliberately stricter than a weighted total: a high score in
 * generic supporting dimensions must not turn a keyword-heavy article into a
 * primary direction.
 */
export function hasSufficientDirectionEvidence(
  direction: Direction,
  dimensionScores: Record<string, number>,
): boolean {
  const full = (dimension: string) =>
    (dimensionScores[dimension] ?? 0) >= DIMENSION_FULL;
  const atLeastHalf = (dimension: string) =>
    (dimensionScores[dimension] ?? 0) >= DIMENSION_HALF;
  // A partial/claimed (2.5) observation is useful to operators but cannot
  // complete a direction's publication story. Eligibility counts only direct,
  // fully evidenced facts.
  const evidenceCount = Object.values(dimensionScores).filter(
    (value) => value >= DIMENSION_FULL,
  ).length;

  switch (direction) {
    case 'model':
      return full('entity') && full('capability') && evidenceCount >= 3;
    case 'agent':
      return full('task_boundary')
        && (full('tool_call') || full('orchestration'))
        && evidenceCount >= 3;
    case 'multimodal':
      return full('modality_coverage') && full('io_capability')
        && evidenceCount >= 3;
    case 'coding':
      return evidenceCount >= 3 && (
        (full('code_gen') && (full('repo_understanding') || full('engineering')))
        || (full('code_gen') && full('ide_integration')
          && (atLeastHalf('engineering') || atLeastHalf('delivery') || atLeastHalf('benchmark')))
        || (full('engineering') && (full('delivery') || full('security')))
      );
    case 'infrastructure':
      return evidenceCount >= 3 && (
        (full('hardware') || full('training') || full('cloud') || full('edge'))
          && (full('performance') || full('cost') || full('software_stack') || full('ops'))
      );
    case 'data_eval':
      return evidenceCount >= 3 && (
        (full('data_asset')
          && (full('coverage') || full('quality') || full('governance')))
        || (full('methodology')
          && (full('performance') || full('reproducibility') || full('quality')))
      );
    case 'safety_governance':
      return evidenceCount >= 3 && full('risk_type')
        && (full('controls') || full('verification') || full('regulation'));
    case 'applications':
      return evidenceCount >= 3 && full('industry')
        && full('business_problem') && full('launch_status');
    case 'business_ecosystem':
      return evidenceCount >= 3 && (
        (full('business_fact')
          && (full('entity_market') || full('strategy') || full('business_model')))
        || (full('entity_market') && full('open_source'))
        || (full('talent') && full('strategy'))
      );
  }
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
    eligibilitySummary: '模型实体和能力变化均须有直接事实，且至少 3 个维度有可核验证据。',
  },
  agent: {
    weights: { task_boundary: 1.5, tool_call: 1.5, protocol: 1, orchestration: 1.5, observability: 0.75, production: 1.5, benchmark: 0.75, workflow: 1.5 },
    coreDimensions: ['task_boundary', 'tool_call', 'orchestration'], minCoreEvidence: 2, minEvidenceDimensions: 3, maxWithoutCoreEvidence: 12,
    eligibilitySummary: '须有多步骤任务，并具备实际工具调用或编排，且至少 3 个维度有可核验证据。',
  },
  multimodal: {
    weights: { modality_coverage: 1.5, io_capability: 1.5, quality: 1, realtime: 1, editing: 0.75, '3d_world': 1, safety_copyright: 0.75, product: 1 },
    coreDimensions: ['modality_coverage', 'io_capability'], minCoreEvidence: 2, minEvidenceDimensions: 2, maxWithoutCoreEvidence: 12,
    eligibilitySummary: '同一事实须明确至少两种实际模态及输入到输出能力，且至少 3 个维度有可核验证据。',
  },
  coding: {
    weights: { code_gen: 1.5, repo_understanding: 1.25, engineering: 1.5, ide_integration: 1, delivery: 1, benchmark: 0.75, cost_speed: 0.75, security: 0.75 },
    coreDimensions: ['code_gen', 'engineering', 'repo_understanding'], minCoreEvidence: 2, minEvidenceDimensions: 3, maxWithoutCoreEvidence: 12,
    eligibilitySummary: '代码生成须结合仓库理解或工程执行；或有工程交付/安全事实，且至少 3 个维度有可核验证据。',
  },
  infrastructure: {
    weights: { hardware: 1.5, training: 1, performance: 1.5, cost: 1, software_stack: 1.25, cloud: 1.25, edge: 0.75, ops: 0.75 },
    coreDimensions: ['hardware', 'performance', 'software_stack'], minCoreEvidence: 2, minEvidenceDimensions: 2, maxWithoutCoreEvidence: 12,
    eligibilitySummary: '硬件、训练、云或端侧至少一项，须与性能、成本、软件栈或运维结果至少一项绑定，且至少 3 个维度有证据。',
  },
  data_eval: {
    weights: { data_asset: 1.5, coverage: 1, methodology: 1.5, reproducibility: 1.25, performance: 1.25, quality: 1, governance: 1, decision_value: 0.75 },
    coreDimensions: ['data_asset', 'methodology', 'performance'], minCoreEvidence: 2, minEvidenceDimensions: 3, maxWithoutCoreEvidence: 10,
    eligibilitySummary: '数据资产须结合覆盖、质量或治理；或评测方法须结合结果、复现或质量，且至少 3 个维度有证据。',
  },
  safety_governance: {
    weights: { risk_type: 1.25, controls: 1.5, verification: 1.5, privacy: 1, copyright: 1, regulation: 1.25, framework: 1.25, deployment_impact: 1 },
    coreDimensions: ['risk_type', 'controls', 'verification', 'regulation'], minCoreEvidence: 2, minEvidenceDimensions: 2, maxWithoutCoreEvidence: 10,
    eligibilitySummary: '须有具体 AI 风险，并有控制、验证或监管事实至少一项，且至少 3 个维度有可核验证据。',
  },
  applications: {
    weights: { industry: 1.25, business_problem: 1.5, launch_status: 1.5, scale: 1, roi: 1.25, workflow_change: 1.25, replicability: 0.75, risk_responsibility: 1 },
    coreDimensions: ['industry', 'business_problem', 'launch_status'], minCoreEvidence: 2, minEvidenceDimensions: 3, maxWithoutCoreEvidence: 10,
    eligibilitySummary: '须同时具备行业采用方、明确业务问题和真实试点/生产上线，且至少 3 个维度有可核验证据。',
  },
  business_ecosystem: {
    weights: { business_fact: 1.5, entity_market: 1.25, strategy: 1.25, business_model: 1.5, market_landscape: 1.25, open_source: 0.75, talent: 0.75, signal: 1 },
    coreDimensions: ['business_fact', 'entity_market', 'strategy', 'business_model'], minCoreEvidence: 2, minEvidenceDimensions: 2, maxWithoutCoreEvidence: 10,
    eligibilitySummary: '已确认商业事实须结合市场、战略或模式；也可由市场+开源社区或人才+战略事实构成，且至少 3 个维度有证据。',
  },
};

/**
 * A complete contract for every direction dimension. The scorer only accepts a
 * five-point item when all `required` fields and one `oneOf` field are present.
 * The service additionally verifies those claims against the original quote.
 */
export const DIRECTION_EVIDENCE_REQUIREMENTS: Record<
  Direction,
  Record<string, DirectionEvidenceRequirement>
> = {
  model: {
    entity: { required: ['model_name', 'provider'] },
    capability: { required: ['task', 'capability_change'] },
    availability: { required: ['access_mode'], oneOf: ['availability_date', 'audience', 'region'] },
    performance: { required: ['metric', 'value'], oneOf: ['unit', 'baseline', 'dataset'] },
    cost: { required: ['metric', 'value'], oneOf: ['unit', 'denominator', 'baseline'] },
    ecosystem: { required: ['integration', 'component'] },
    adoption: { required: ['adopter'], oneOf: ['metric', 'value', 'deployment_scope'] },
  },
  agent: {
    task_boundary: { required: ['task', 'steps'] },
    tool_call: { required: ['tool', 'operation'] },
    protocol: { required: ['protocol', 'counterpart'] },
    orchestration: { required: ['orchestration', 'workflow'] },
    observability: { required: ['mechanism'], oneOf: ['scope', 'result'] },
    production: { required: ['status'], oneOf: ['control', 'owner', 'environment'] },
    benchmark: { required: ['metric', 'value'], oneOf: ['unit', 'task', 'baseline'] },
    workflow: { required: ['workflow', 'role'] },
  },
  multimodal: {
    modality_coverage: { required: ['modalities', 'operation'] },
    io_capability: { required: ['input_modality', 'output_modality', 'operation'] },
    quality: { required: ['metric', 'value'], oneOf: ['unit', 'dataset', 'baseline'] },
    realtime: { required: ['metric', 'value'], oneOf: ['unit', 'mode'] },
    editing: { required: ['edit_op', 'target_modality'], oneOf: ['target_region_or_time', 'constraints'] },
    '3d_world': { required: ['task', 'representation'], oneOf: ['metric', 'result'] },
    safety_copyright: { required: ['risk_type', 'control'], oneOf: ['scope', 'result', 'license'] },
    product: { required: ['product_name', 'status'], oneOf: ['date', 'access_url', 'audience'] },
  },
  coding: {
    code_gen: { required: ['task', 'code_artifact'] },
    repo_understanding: { required: ['repository', 'task'] },
    engineering: { required: ['engineering_task', 'outcome'] },
    ide_integration: { required: ['ide_or_terminal', 'integration'] },
    delivery: { required: ['metric', 'value'], oneOf: ['unit', 'baseline', 'task'] },
    benchmark: { required: ['metric', 'value'], oneOf: ['unit', 'benchmark_name', 'baseline'] },
    cost_speed: { required: ['metric', 'value'], oneOf: ['unit', 'baseline', 'workload'] },
    security: { required: ['risk_type', 'control'], oneOf: ['scope', 'result'] },
  },
  infrastructure: {
    hardware: { required: ['vendor', 'hardware'], oneOf: ['workload', 'memory', 'interconnect'] },
    training: { required: ['workload', 'mechanism'], oneOf: ['cluster', 'framework', 'scale'] },
    performance: { required: ['metric', 'value', 'unit'], oneOf: ['workload', 'baseline', 'batch_or_concurrency'] },
    cost: { required: ['metric', 'value', 'unit'], oneOf: ['workload', 'denominator', 'baseline'] },
    software_stack: { required: ['package', 'optimization'], oneOf: ['hardware', 'workload', 'version'] },
    cloud: { required: ['provider', 'service'], oneOf: ['region', 'capacity', 'sla', 'pricing'] },
    edge: { required: ['device', 'runtime'], oneOf: ['model', 'latency', 'power', 'offline'] },
    ops: { required: ['mechanism'], oneOf: ['slo', 'mttr', 'uptime', 'failure_rate'] },
  },
  data_eval: {
    data_asset: { required: ['asset_name'], oneOf: ['version', 'size', 'access_url', 'license'] },
    coverage: { required: ['scope'], oneOf: ['count', 'percentage', 'sampling'] },
    methodology: { required: ['protocol', 'metric'], oneOf: ['split', 'aggregation', 'baseline'] },
    reproducibility: { required: ['artifact_url'], oneOf: ['version', 'license', 'environment', 'seed'] },
    performance: { required: ['model', 'task', 'metric', 'value'], oneOf: ['unit', 'split', 'baseline', 'ci'] },
    quality: { required: ['process'], oneOf: ['quality_metric', 'agreement', 'noise_rate', 'annotator_count'] },
    governance: { required: ['governance_action'], oneOf: ['license', 'provenance', 'consent', 'pii', 'jurisdiction'] },
    decision_value: { required: ['stakeholder', 'decision'], oneOf: ['action', 'outcome', 'threshold'] },
  },
  safety_governance: {
    risk_type: { required: ['risk_class', 'target_system'], oneOf: ['affected_party', 'harm'] },
    controls: { required: ['control_type', 'threat'], oneOf: ['scope', 'owner', 'threshold'] },
    verification: { required: ['method', 'result'], oneOf: ['evaluator', 'sample', 'date'] },
    privacy: { required: ['data_type', 'processing'], oneOf: ['legal_basis', 'retention', 'technique'] },
    copyright: { required: ['work_or_data', 'right_type'], oneOf: ['license', 'claimant', 'legal_status'] },
    regulation: { required: ['jurisdiction'], oneOf: ['instrument', 'obligation', 'effective_date'] },
    framework: { required: ['framework_name', 'controls_covered'], oneOf: ['adopter', 'version', 'date'] },
    deployment_impact: { required: ['deployment_context', 'outcome'], oneOf: ['affected_scale', 'owner', 'date'] },
  },
  applications: {
    industry: { required: ['industry'], oneOf: ['adopter', 'use_case'] },
    business_problem: { required: ['problem'], oneOf: ['baseline', 'target_metric', 'owner'] },
    launch_status: { required: ['status'], oneOf: ['date', 'environment', 'adopter'] },
    scale: { required: ['metric', 'value', 'unit'], oneOf: ['period', 'denominator'] },
    roi: { required: ['metric', 'value', 'unit'], oneOf: ['before', 'after', 'baseline', 'period'] },
    workflow_change: { required: ['old_flow', 'new_flow'], oneOf: ['roles_changed', 'human_override'] },
    replicability: { required: ['case_count'], oneOf: ['adopters', 'playbook', 'outcomes', 'prerequisites'] },
    risk_responsibility: { required: ['accountable_owner'], oneOf: ['human_review', 'escalation', 'liability', 'controls'] },
  },
  business_ecosystem: {
    business_fact: { required: ['event_type', 'parties'], oneOf: ['amount', 'status', 'source', 'date'] },
    entity_market: { required: ['entity', 'market'], oneOf: ['role', 'share', 'competitors', 'geography'] },
    strategy: { required: ['action', 'counterpart'], oneOf: ['scope', 'rationale', 'status', 'date'] },
    business_model: { required: ['pricing_or_revenue'], oneOf: ['billing_unit', 'tiers', 'contract', 'change_date'] },
    market_landscape: { required: ['competitors', 'metric', 'value'], oneOf: ['period', 'methodology', 'source'] },
    open_source: { required: ['repo'], oneOf: ['license', 'metric', 'value', 'contributor_source'] },
    talent: { required: ['person_or_count', 'event_type'], oneOf: ['role', 'organization', 'date'] },
    signal: { required: ['signal_type', 'parties'], oneOf: ['status', 'signed_date', 'amount', 'scope', 'source'] },
  },
};

export function getDirectionEvidenceRequirement(
  direction: Direction,
  dimension: string,
): DirectionEvidenceRequirement | undefined {
  return DIRECTION_EVIDENCE_REQUIREMENTS[direction][dimension];
}

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
