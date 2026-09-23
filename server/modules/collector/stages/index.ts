/**
 * Collector stage map.
 *
 * Orchestration stays in CollectorService. Each named stage already has a
 * focused helper module; new pipeline work should land here instead of
 * growing collector.service.ts.
 */
export { PIPELINE_STAGE_ORDER, shouldAttemptAiScoring } from '../pipeline-types';
export type { PipelineStage, PipelineArticle, RawFetchResponse } from '../pipeline-types';
export { fetchRawContent, parseRawContent } from '../parsers';
export { normalizeItems } from '../pipeline-normalize';
export { canonicalizeDedupUrl, computeDedupHash, dedupBatch, filterAgainstExisting } from '../pipeline-dedup';
export { planEventClusters } from '../event-cluster';
export type { EventClusterInput, EventClusterGroup, EventClusterPlan } from '../event-cluster';
export { runClusterStage } from './cluster-stage';
export type { ClusterStageLogger, ClusterStageResult } from './cluster-stage';
export { canPublishArticle } from '../publish-gate';
