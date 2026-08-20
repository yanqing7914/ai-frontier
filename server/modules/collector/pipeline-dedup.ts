import * as crypto from 'crypto';

/**
 * URL parameters which identify a distribution/click rather than the article.
 * Keep this list in one place: Stage 5, the database filter and duplicate gates
 * all use canonicalizeDedupUrl below.
 */
const TRACKING_PARAMS = new Set([
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'utm_id',
  'fbclid', 'gclid', 'mc_cid', 'mc_eid', 'ref', 'source',
  'fb_action_ids', 'fb_action_types', 'fb_ref', 'fb_source',
]);

export interface DedupInput {
  /** Stable index/key used by the caller to recover the full normalized item. */
  id?: string;
  url: string;
  contentHash: string;
  title: string;
  originPolicy?: string | null;
  sourceTier?: string | null;
  sourceName?: string | null;
  contentLength?: number;
}

export interface DedupResult {
  passed: DedupInput[];
  deduped: number;
  reasons: { batchUrl: number; batchHash: number };
}

/**
 * Canonical identity for article URLs. This deliberately does not trim
 * punctuation from the path: punctuation can be a legal part of a URL.
 */
export function canonicalizeDedupUrl(value: string): string {
  if (typeof value !== 'string' || !value.trim()) return '';
  try {
    const parsed = new URL(value.trim());
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
    parsed.protocol = parsed.protocol.toLowerCase();
    parsed.hostname = parsed.hostname.toLowerCase();
    if ((parsed.protocol === 'http:' && parsed.port === '80') ||
        (parsed.protocol === 'https:' && parsed.port === '443')) {
      parsed.port = '';
    }
    parsed.hash = '';

    const kept: Array<[string, string]> = [];
    parsed.searchParams.forEach((paramValue, paramName) => {
      if (!TRACKING_PARAMS.has(paramName.toLowerCase())) {
        kept.push([paramName, paramValue]);
      }
    });
    kept.sort(([nameA, valueA], [nameB, valueB]) =>
      nameA.localeCompare(nameB) || valueA.localeCompare(valueB));
    parsed.search = '';
    for (const [name, paramValue] of kept) parsed.searchParams.append(name, paramValue);

    // URL.toString() uses a trailing slash for an empty path consistently.
    return parsed.toString();
  } catch {
    return '';
  }
}

/** Backwards-compatible name used by existing unit tests/callers. */
export function stripTrackingParams(url: string): string {
  return canonicalizeDedupUrl(url);
}

export function computeDedupHash(title: string, dedupUrl: string): string {
  const normalizedTitle = typeof title === 'string'
    ? title.normalize('NFKC').replace(/\s+/g, ' ').trim()
    : '';
  return crypto.createHash('md5').update(`${normalizedTitle}\n${canonicalizeDedupUrl(dedupUrl)}`).digest('hex');
}

const ORIGIN_PRIORITY: Record<string, number> = {
  first_party: 0,
  editorial: 1,
  aggregator: 2,
};
const TIER_PRIORITY: Record<string, number> = {
  authoritative: 0,
  validation: 1,
  signal: 2,
};

/** Stable winner selection for two representations of the same article. */
export function compareDedupCandidates(a: DedupInput, b: DedupInput): number {
  const origin = (ORIGIN_PRIORITY[a.originPolicy ?? ''] ?? 3) - (ORIGIN_PRIORITY[b.originPolicy ?? ''] ?? 3);
  if (origin !== 0) return origin;
  const tier = (TIER_PRIORITY[a.sourceTier ?? ''] ?? 3) - (TIER_PRIORITY[b.sourceTier ?? ''] ?? 3);
  if (tier !== 0) return tier;
  const completeness = (b.contentLength ?? 0) - (a.contentLength ?? 0);
  if (completeness !== 0) return completeness;
  const source = (a.sourceName ?? '').localeCompare(b.sourceName ?? '');
  if (source !== 0) return source;
  const title = a.title.localeCompare(b.title);
  if (title !== 0) return title;
  return a.contentHash.localeCompare(b.contentHash) || a.url.localeCompare(b.url);
}

export function dedupBatch(items: DedupInput[]): DedupResult {
  const byUrl = new Map<string, DedupInput>();
  const byHash = new Map<string, DedupInput>();
  let batchUrl = 0;
  let batchHash = 0;
  // Sort by source/content quality before applying either identity. This makes
  // the winner independent of fetch completion order in concurrent runs.
  const passed: DedupInput[] = [];
  for (const item of [...items].sort(compareDedupCandidates)) {
    const normUrl = canonicalizeDedupUrl(item.url);
    if (byUrl.has(normUrl)) {
      batchUrl++;
      continue;
    }
    if (byHash.has(item.contentHash)) {
      batchHash++;
      continue;
    }
    byUrl.set(normUrl, item);
    byHash.set(item.contentHash, item);
    passed.push(item);
  }
  return { passed, deduped: batchUrl + batchHash, reasons: { batchUrl, batchHash } };
}

export function filterAgainstExisting(
  items: DedupInput[],
  existingHashes: Set<string>,
  existingUrls: Set<string>,
): { passed: DedupInput[]; deduped: number } {
  const passed: DedupInput[] = [];
  let deduped = 0;
  for (const item of items) {
    const normUrl = canonicalizeDedupUrl(item.url);
    if (existingHashes.has(item.contentHash) || existingUrls.has(normUrl)) {
      deduped++;
      continue;
    }
    passed.push(item);
  }
  return { passed, deduped };
}
