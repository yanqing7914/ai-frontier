import * as crypto from 'crypto';

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

    const content = cleanContent(item.rawContent) || title;
    const contentHash = computeContentHash(title, url);

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
