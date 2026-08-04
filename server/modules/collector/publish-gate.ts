import type { Direction } from '../../../shared/directions';
import {
  DIRECTIONS,
  DIMENSION_FULL,
  normalizeDirection,
  ALL_DIRECTION_IDS,
} from '../../../shared/directions';
import type { DimensionScores, DirectionScoreItem } from '../../../shared/api.interface';

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
    for (const dim of meta.dimensions) {
      if (typeof dimensionScores[dim] === 'number' && dimensionScores[dim] >= DIMENSION_FULL) {
        return true;
      }
    }
  }

  const legacySum = LEGACY_DIM_KEYS.reduce(
    (sum, k) => sum + ((dimensionScores[k] as number) ?? 0),
    0,
  );
  return legacySum >= LEGACY_CLEAR_SUM;
}

export interface PublishGateInput {
  primaryDirection: string | null;
  primaryScore: number | null;
  status: string;
  dimensionScores: Record<string, number> | null;
  publishThreshold: number;
}

export function canPublishArticle(input: PublishGateInput): boolean {
  const { primaryDirection, primaryScore, status, dimensionScores, publishThreshold } = input;
  if (!primaryDirection) return false;
  if (!normalizeDirection(primaryDirection)) return false;
  if (status === 'pending_review' || status === 'blocked') return false;
  if ((primaryScore ?? 0) < publishThreshold) return false;
  if (!hasCoreEvidence(dimensionScores, primaryDirection)) return false;
  return true;
}

export function aggregateDirectionScores(
  scores: { direction: string; totalScore: number; dimensionScores: unknown }[],
): DirectionScoreItem[] {
  const grouped = new Map<string, { totalScore: number; dimensionScores: DimensionScores }>();

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
      });
    } else {
      grouped.set(dir, {
        totalScore: row.totalScore,
        dimensionScores: { ...rowScores },
      });
    }
  }

  return ALL_DIRECTION_IDS.map((dir: Direction) => {
    const data = grouped.get(dir);
    return {
      direction: dir,
      totalScore: data?.totalScore ?? 0,
      dimensionScores: data?.dimensionScores ?? {},
    };
  });
}
