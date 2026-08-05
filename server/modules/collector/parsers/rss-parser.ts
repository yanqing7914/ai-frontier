import Parser from 'rss-parser';
import type { ParsedItem, ParseResult } from './types';

const rssParser = new Parser({
  timeout: 15000,
  maxRedirects: 5,
  headers: { 'User-Agent': 'AI-News-Dashboard/1.0' },
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

export async function parseRssFeed(url: string): Promise<ParseResult> {
  try {
    const feed = await rssParser.parseURL(url);
    if (!feed || !feed.items) {
      return { items: [], error: 'No items in feed' };
    }

    const items: ParsedItem[] = [];
    for (const item of feed.items) {
      const title = (item.title ?? '').trim();
      const link = (item.link ?? '').trim();
      if (!title || !link) continue;

      const rawHtml = item.content ?? item.contentSnippet ?? '';
      const content = decodeEntities(rawHtml.replace(/<[^>]*>/g, '').trim());
      const pubDate = item.pubDate ? new Date(item.pubDate) : null;

      items.push({
        title,
        url: link,
        publishedAt: pubDate && !isNaN(pubDate.getTime()) ? pubDate : null,
        content,
        rawContent: rawHtml,
      });
    }

    return { items };
  } catch (error: unknown) {
    const errMsg = error instanceof Error ? error.message : String(error);
    return { items: [], error: errMsg };
  }
}
