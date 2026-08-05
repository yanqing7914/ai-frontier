import Parser from 'rss-parser';
import type { ParsedItem, ParseResult } from './types';

const rssParser = new Parser({
  timeout: 15000,
  maxRedirects: 5,
  headers: { 'User-Agent': 'AI-News-Dashboard/1.0' },
  // rss-parser does not expose namespaced fields unless they are requested.
  customFields: { item: ['content:encoded', 'summary'] },
});

function decodeEntities(text: string): string {
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

function extractItemContent(item: Record<string, unknown>): string {
  const candidates = [
    item['content:encoded'], item.content, item.summary,
    item.contentSnippet, item.description,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate;
  }
  return '';
}

function toParsedItems(feedItems: Record<string, unknown>[]): ParsedItem[] {
  const items: ParsedItem[] = [];
  for (const item of feedItems) {
    const title = typeof item.title === 'string' ? item.title.trim() : '';
    const link = typeof item.link === 'string' ? item.link.trim() : '';
    if (!title || !link) continue;

    const rawHtml = extractItemContent(item);
    const content = decodeEntities(rawHtml.replace(/<[^>]*>/g, '').trim());
    const pubDate = typeof item.pubDate === 'string' ? new Date(item.pubDate) : null;
    items.push({
      title, url: link,
      publishedAt: pubDate && !isNaN(pubDate.getTime()) ? pubDate : null,
      content: content || title,
      rawContent: rawHtml,
    });
  }
  return items;
}

export async function parseRssContent(rawXml: string): Promise<ParseResult> {
  try {
    const feed = await rssParser.parseString(rawXml);
    if (!feed || !feed.items) {
      return { items: [], error: 'No items in feed' };
    }

    return { items: toParsedItems(feed.items as unknown as Record<string, unknown>[]) };
  } catch (error: unknown) {
    const errMsg = error instanceof Error ? error.message : String(error);
    return { items: [], error: errMsg };
  }
}

export async function parseRssFeed(url: string): Promise<ParseResult> {
  try {
    const feed = await rssParser.parseURL(url);
    if (!feed || !feed.items) {
      return { items: [], error: 'No items in feed' };
    }

    return { items: toParsedItems(feed.items as unknown as Record<string, unknown>[]) };
  } catch (error: unknown) {
    const errMsg = error instanceof Error ? error.message : String(error);
    return { items: [], error: errMsg };
  }
}
