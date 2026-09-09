import type { Direction } from '../../../shared/directions';
import {
  DIRECTIONS,
  DIMENSION_FULL,
  normalizeDirection,
  ALL_DIRECTION_IDS,
  hasSufficientDirectionEvidence,
} from '../../../shared/directions';
import type {
  DimensionScores,
  DirectionScoreItem,
  ScoreEvidence,
} from '@shared/api.interface';

const LEGACY_DIM_KEYS = ['novelty', 'depth', 'impact', 'authority', 'timeliness'];
const LEGACY_CLEAR_SUM = DIMENSION_FULL * 2;

export function hasCoreEvidence(
  dimensionScores: Record<string, number> | null | undefined,
  direction: string,
): boolean {
  if (!dimensionScores || !direction) return false;
  const normalized = normalizeDirection(direction);
  if (!normalized) return false;

  const meta = DIRECTIONS.find((d) => d.id === normalized);
  if (meta) {
    if (hasSufficientDirectionEvidence(normalized, dimensionScores)) return true;
  }

  const legacySum = LEGACY_DIM_KEYS.reduce(
    (sum, k) => sum + ((dimensionScores[k] as number) ?? 0),
    0,
  );
  return legacySum >= LEGACY_CLEAR_SUM;
}

/** A published primary score must still have direct, verified source quotes. */
export function hasVerifiedPrimaryEvidence(
  evidence: ScoreEvidence[] | null | undefined,
  direction: string,
  dimensionScores: Record<string, number> | null | undefined,
): boolean {
  if (!evidence || !dimensionScores) return false;
  const normalized = normalizeDirection(direction);
  if (!normalized) return false;
  const coveredDimensions = new Set(
    evidence
      .filter((item) => item.direction === normalized
        && item.score >= DIMENSION_FULL
        && item.certainty !== 'planned'
        && item.certainty !== 'claimed'
        && item.certainty !== 'rumor'
        && item.quote.trim().length > 0)
      .map((item) => item.dimension),
  );
  return Object.entries(dimensionScores)
    .filter(([, score]) => typeof score === 'number' && score >= DIMENSION_FULL)
    .every(([dimension]) => coveredDimensions.has(dimension));
}

export interface PublishGateInput {
  primaryDirection: string | null;
  primaryScore: number | null;
  status: string;
  dimensionScores: Record<string, number> | null;
  evidence?: ScoreEvidence[] | null;
  publishThreshold: number;
  /** A published score must be backed by evidence validated from the AI output. */
  aiProcessed?: boolean;
  /** Explicit opt-in for publishing rule-scored articles when AI is unavailable. */
  allowDegradedPublish?: boolean;
  /** Explicit human provenance audit may override a pending trace. */
  provenanceOverride?: boolean;
  /** Only unverified aggregation/reposts are withheld from automatic publication. */
  traceStatus?: 'first_party' | 'editorial' | 'verified_reference' | 'aggregator' | 'needs_review' | 'unknown' | null;
}

export function canPublishArticle(input: PublishGateInput): boolean {
  const {
    primaryDirection, primaryScore, status, dimensionScores, evidence,
    publishThreshold, traceStatus, aiProcessed, allowDegradedPublish,
    provenanceOverride,
  } = input;
  if (!primaryDirection) return false;
  if (!normalizeDirection(primaryDirection)) return false;
  if (status === 'pending_review' || status === 'blocked') return false;
  // Provenance is an allow-list. Null, legacy values and aggregators fail closed.
  if ((!traceStatus || !['first_party', 'editorial', 'verified_reference'].includes(traceStatus)) && !provenanceOverride) return false;
  if (aiProcessed === false && allowDegradedPublish !== true) return false;
  if ((primaryScore ?? 0) < publishThreshold) return false;
  if (!hasCoreEvidence(dimensionScores, primaryDirection)) return false;
  if (!hasVerifiedPrimaryEvidence(evidence, primaryDirection, dimensionScores)) return false;
  return true;
}

export function aggregateDirectionScores(
  scores: { direction: string; totalScore: number; dimensionScores: unknown }[],
): DirectionScoreItem[] {
  const grouped = new Map<string, {
    totalScore: number;
    dimensionScores: DimensionScores;
    evidence: ScoreEvidence[];
  }>();

  for (const row of scores) {
    const dir = normalizeDirection(row.direction);
    if (!dir) continue;
    const existing = grouped.get(dir);
    const rowScores = (row.dimensionScores ?? {}) as DimensionScores;
    if (existing) {
      const merged: DimensionScores = { ...existing.dimensionScores };
      for (const [k, v] of Object.entries(rowScores)) {
        merged[k] = Math.max(merged[k] ?? 0, v as number);
      }
      grouped.set(dir, {
        totalScore: Math.max(existing.totalScore, row.totalScore),
        dimensionScores: merged,
        evidence: existing.evidence,
      });
    } else {
      grouped.set(dir, {
        totalScore: row.totalScore,
        dimensionScores: { ...rowScores },
        evidence: [],
      });
    }
  }

  return ALL_DIRECTION_IDS.map((dir: Direction) => {
    const data = grouped.get(dir);
    return {
      direction: dir,
      totalScore: data?.totalScore ?? 0,
      dimensionScores: data?.dimensionScores ?? {},
      evidence: data?.evidence ?? [],
    };
  });
}
