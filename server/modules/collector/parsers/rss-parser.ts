import Parser from 'rss-parser';
import type { ParsedItem, ParseResult } from './types';
import { cleanHtml, makeStats, parseDateFields, provenance, resolveHttpUrl } from './utils';

const rssParser = new Parser({
  timeout: 15000,
  maxRedirects: 5,
  headers: { 'User-Agent': 'AI-News-Dashboard/1.0' },
  // rss-parser does not expose namespaced fields unless they are requested.
  customFields: { item: ['content:encoded', 'summary', 'dc:date', 'updated'] },
});

function extractItemContent(item: Record<string, unknown>): { raw: string; status: 'full' | 'summary' | 'missing' } {
  for (const key of ['content:encoded', 'content']) {
    const value = item[key];
    if (typeof value === 'string' && value.trim()) return { raw: value.trim(), status: 'full' };
  }
  for (const key of ['summary', 'contentSnippet', 'description']) {
    const value = item[key];
    if (typeof value === 'string' && value.trim()) return { raw: value.trim(), status: 'summary' };
  }
  return { raw: '', status: 'missing' };
}

function toParsedItems(
  feedItems: Record<string, unknown>[],
  baseUrl: string,
): { items: ParsedItem[]; warnings: string[]; skipped: number } {
  const items: ParsedItem[] = [];
  const warnings: string[] = [];
  let skipped = 0;
  for (let index = 0; index < feedItems.length; index++) {
    const item = feedItems[index];
    const title = typeof item.title === 'string' ? item.title.trim() : '';
    const resolvedUrl = resolveHttpUrl(item.link ?? item.guid, baseUrl);
    if (!title || !resolvedUrl) {
      skipped++;
      warnings.push(`item ${index + 1} skipped: missing title or safe http(s) link`);
      continue;
    }

    const body = extractItemContent(item);
    const content = cleanHtml(body.raw);
    const itemWarnings = body.status === 'missing' ? ['body missing from feed item'] : [];
    items.push({
      title,
      url: resolvedUrl.canonical,
      originalUrl: resolvedUrl.original,
      canonicalUrl: resolvedUrl.canonical,
      publishedAt: parseDateFields(item, ['isoDate', 'pubDate', 'published', 'updated', 'dc:date', 'date']),
      content,
      rawContent: body.raw,
      contentStatus: body.status,
      warnings: itemWarnings.length ? itemWarnings : undefined,
    });
  }
  return { items, warnings, skipped };
}

export async function parseRssContent(rawXml: string, sourceUrl = ''): Promise<ParseResult> {
  try {
    const feed = await rssParser.parseString(rawXml);
    if (!feed || !Array.isArray(feed.items)) {
      return { items: [], error: 'RSS/Atom feed has no items collection', stats: makeStats(0, 0, 0), provenance: provenance('rss', sourceUrl) };
    }
    const converted = toParsedItems(feed.items as unknown as Record<string, unknown>[], sourceUrl);
    const error = converted.items.length === 0 && feed.items.length > 0
      ? 'RSS/Atom feed contained no parseable items'
      : undefined;
    return {
      items: converted.items,
      error,
      warnings: converted.warnings.length ? converted.warnings : undefined,
      stats: makeStats(feed.items.length, converted.items.length, converted.skipped),
      provenance: provenance('rss', sourceUrl),
    };
  } catch (error: unknown) {
    const errMsg = error instanceof Error ? error.message : String(error);
    return { items: [], error: errMsg, stats: makeStats(0, 0, 0), provenance: provenance('rss', sourceUrl) };
  }
}

export async function parseRssFeed(url: string): Promise<ParseResult> {
  try {
    const feed = await rssParser.parseURL(url);
    if (!feed || !Array.isArray(feed.items)) {
      return { items: [], error: 'RSS/Atom feed has no items collection', stats: makeStats(0, 0, 0), provenance: provenance('rss', url, { finalUrl: url }) };
    }
    const converted = toParsedItems(feed.items as unknown as Record<string, unknown>[], url);
    const error = converted.items.length === 0 && feed.items.length > 0
      ? 'RSS/Atom feed contained no parseable items'
      : undefined;
    return {
      items: converted.items,
      error,
      warnings: converted.warnings.length ? converted.warnings : undefined,
      stats: makeStats(feed.items.length, converted.items.length, converted.skipped),
      provenance: provenance('rss', url, { finalUrl: url }),
    };
  } catch (error: unknown) {
    const errMsg = error instanceof Error ? error.message : String(error);
    return { items: [], error: errMsg, stats: makeStats(0, 0, 0), provenance: provenance('rss', url, { finalUrl: url }) };
  }
}
