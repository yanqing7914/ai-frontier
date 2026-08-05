import * as crypto from 'crypto';

const TRACKING_PARAMS = new Set([
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term',
  'utm_content', 'utm_id', 'fbclid', 'gclid', 'mc_cid', 'mc_eid',
]);

export function normalizeUrlForDedup(url: string): string {
  if (!url) return url;
  let cleaned = url.replace(/[.,;:!?)\]}>]+$/, '');
  try {
    const parsed = new URL(cleaned);
    parsed.hash = '';
    for (const param of TRACKING_PARAMS) {
      parsed.searchParams.delete(param);
    }
    const result = parsed.toString();
    return result.endsWith('?') ? result.slice(0, -1) : result;
  } catch {
    return cleaned;
  }
}

export interface ParsedItem {
  title: string;
  url: string;
  canonicalUrl?: string;
  publishedAt: Date | null;
  content: string;
  rawContent: string;
}

export interface NormalizedItem {
  title: string;
  url: string;
  originalUrl: string;
  canonicalUrl: string | null;
  contentHash: string;
  content: string;
  rawContent: string;
  publishedAt: Date | null;
  sourceName: string;
  sourceTier: string;
  feedSourceId: string;
}

export interface NormalizeResult {
  items: NormalizedItem[];
  dropped: number;
  dropReasons: { missingTitle: number; missingUrl: number };
}

export function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, '/')
    .replace(/&nbsp;/g, ' ')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) =>
      String.fromCharCode(parseInt(code, 10)),
    )
    .replace(/&#x([0-9a-fA-F]+);/g, (_, code: string) =>
      String.fromCharCode(parseInt(code, 16)),
    );
}

export function cleanContent(rawHtml: string): string {
  const stripped = rawHtml.replace(/<[^>]*>/g, '');
  return decodeEntities(stripped).replace(/\s+/g, ' ').trim();
}

export function computeContentHash(title: string, url: string): string {
  return crypto.createHash('md5').update(title + url).digest('hex');
}

export function normalizeItems(
  items: ParsedItem[],
  sourceMeta: { name: string; tier: string; feedSourceId: string },
): NormalizeResult {
  const result: NormalizedItem[] = [];
  let missingTitle = 0;
  let missingUrl = 0;

  for (const item of items) {
    const title = item.title.trim();
    const url = item.url.trim();

    if (!title) { missingTitle++; continue; }
    if (!url) { missingUrl++; continue; }

    const content = item.content || cleanContent(item.rawContent) || title;
    const normalizedUrl = normalizeUrlForDedup(url);
    const contentHash = computeContentHash(title, normalizedUrl);

    result.push({
      title,
      url,
      originalUrl: url,
      canonicalUrl: item.canonicalUrl || null,
      contentHash,
      content,
      rawContent: item.rawContent,
      publishedAt: item.publishedAt,
      sourceName: sourceMeta.name,
      sourceTier: sourceMeta.tier,
      feedSourceId: sourceMeta.feedSourceId,
    });
  }

  return {
    items: result,
    dropped: missingTitle + missingUrl,
    dropReasons: { missingTitle, missingUrl },
  };
}
