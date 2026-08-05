import { normalizeUrl } from './trace-engine';

const TRACKING_PARAMS_EXTRA = new Set([
  'ref', 'source', 'fb_action_ids', 'fb_action_types',
  'fb_ref', 'fb_source', 'mc_cid', 'mc_eid',
]);

export interface DedupInput {
  url: string;
  contentHash: string;
  title: string;
}

export interface DedupResult {
  passed: DedupInput[];
  deduped: number;
  reasons: { batchUrl: number; batchHash: number };
}

export function stripTrackingParams(url: string): string {
  let cleaned = url;
  try {
    const parsed = new URL(cleaned);
    parsed.hash = '';
    for (const param of TRACKING_PARAMS_EXTRA) {
      parsed.searchParams.delete(param);
    }
    const result = parsed.toString();
    return result.endsWith('?') ? result.slice(0, -1) : result;
  } catch {
    return cleaned;
  }
}

export function dedupBatch(items: DedupInput[]): DedupResult {
  const seenUrls = new Map<string, number>();
  const seenHashes = new Map<string, number>();
  const passed: DedupInput[] = [];
  let batchUrl = 0;
  let batchHash = 0;

  for (const item of items) {
    const normUrl = stripTrackingParams(normalizeUrl(item.url));

    if (seenUrls.has(normUrl)) {
      batchUrl++;
      continue;
    }
    if (seenHashes.has(item.contentHash)) {
      batchHash++;
      continue;
    }

    seenUrls.set(normUrl, passed.length);
    seenHashes.set(item.contentHash, passed.length);
    passed.push(item);
  }

  return {
    passed,
    deduped: batchUrl + batchHash,
    reasons: { batchUrl, batchHash },
  };
}

export function filterAgainstExisting(
  items: DedupInput[],
  existingHashes: Set<string>,
  existingUrls: Set<string>,
): { passed: DedupInput[]; deduped: number } {
  const passed: DedupInput[] = [];
  let deduped = 0;

  for (const item of items) {
    if (existingHashes.has(item.contentHash)) {
      deduped++;
      continue;
    }
    const normUrl = stripTrackingParams(normalizeUrl(item.url));
    if (existingUrls.has(normUrl)) {
      deduped++;
      continue;
    }
    passed.push(item);
  }

  return { passed, deduped };
}
