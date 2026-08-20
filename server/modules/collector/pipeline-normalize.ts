import * as crypto from 'crypto';

const TRACKING_PARAMS = new Set([
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term',
  'utm_content', 'utm_id', 'fbclid', 'gclid', 'mc_cid', 'mc_eid',
]);

export function normalizeUrlForDedup(url: string): string {
  if (!url) return '';
  try {
    const parsed = new URL(url.trim());
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
    parsed.hash = '';
    for (const param of TRACKING_PARAMS) {
      parsed.searchParams.delete(param);
    }
    const result = parsed.toString();
    return result.endsWith('?') ? result.slice(0, -1) : result;
  } catch {
    return '';
  }
}

function normalizeHttpUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const parsed = new URL(value.trim());
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

function normalizeTitle(value: unknown): string {
  if (typeof value !== 'string') return '';
  return decodeEntities(value)
    .normalize('NFKC')
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function validDate(value: unknown): Date | null {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) return null;
  return value;
}

export interface ParsedItem {
  title: string;
  url: string;
  canonicalUrl?: string;
  publishedAt: Date | null;
  content: string;
  rawContent: string;
  contentStatus?: 'full' | 'summary' | 'missing';
}

export interface NormalizedItem {
  title: string;
  url: string;
  originalUrl: string;
  canonicalUrl: string | null;
  dedupUrl: string;
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
  dropReasons: { missingTitle: number; missingUrl: number; invalidUrl: number; missingContent: number };
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
    .replace(/&#(\d+);/g, (entity, code: string) => decodeCodePoint(entity, Number.parseInt(code, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (entity, code: string) => decodeCodePoint(entity, Number.parseInt(code, 16)));
}

function decodeCodePoint(entity: string, codePoint: number): string {
  return Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10FFFF
    ? String.fromCodePoint(codePoint)
    : entity;
}

export function cleanContent(rawHtml: string): string {
  if (typeof rawHtml !== 'string') return '';
  const stripped = rawHtml
    .replace(/<!--([\s\S]*?)-->/g, ' ')
    .replace(/<(script|style|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<\/?(?:br|p|div|li|tr|h[1-6]|section|article|blockquote)\b[^>]*>/gi, ' ')
    .replace(/<[^>]*>/g, ' ');
  return decodeEntities(stripped).replace(/\s+/g, ' ').trim();
}

export function computeContentHash(title: string, url: string): string {
  const canonicalTitle = normalizeTitle(title);
  const dedupUrl = normalizeUrlForDedup(url);
  return crypto.createHash('md5').update(`${canonicalTitle}\n${dedupUrl}`).digest('hex');
}

export function normalizeItems(
  items: ParsedItem[],
  sourceMeta: { name: string; tier: string; feedSourceId: string },
): NormalizeResult {
  const result: NormalizedItem[] = [];
  let missingTitle = 0;
  let missingUrl = 0;
  let invalidUrl = 0;
  let missingContent = 0;

  for (const item of items) {
    const title = normalizeTitle(item.title);
    const originalUrl = typeof item.url === 'string' ? item.url.trim() : '';
    const url = normalizeHttpUrl(originalUrl);

    if (!title) { missingTitle++; continue; }
    if (!originalUrl) { missingUrl++; continue; }
    if (!url) { invalidUrl++; continue; }

    const content = cleanContent(item.content)
      || (item.contentStatus === 'missing' ? '' : cleanContent(item.rawContent));
    if (!content) { missingContent++; continue; }

    const canonicalUrl = normalizeHttpUrl(item.canonicalUrl) ?? null;
    const dedupUrl = normalizeUrlForDedup(canonicalUrl ?? url);
    const contentHash = computeContentHash(title, dedupUrl);

    result.push({
      title,
      url,
      originalUrl,
      canonicalUrl,
      dedupUrl,
      contentHash,
      content,
      rawContent: item.rawContent,
      publishedAt: validDate(item.publishedAt),
      sourceName: sourceMeta.name,
      sourceTier: sourceMeta.tier,
      feedSourceId: sourceMeta.feedSourceId,
    });
  }

  return {
    items: result,
    dropped: missingTitle + missingUrl + invalidUrl + missingContent,
    dropReasons: { missingTitle, missingUrl, invalidUrl, missingContent },
  };
}
