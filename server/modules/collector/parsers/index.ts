import type { ParseResult } from './types';
import { parseRssFeed, parseRssContent } from './rss-parser';
import { parseApiFeed, parseApiContent } from './api-parser';
import { parseWebFeed, parseWebContent, extractMeta } from './web-parser';
import { fetchRawContent, type RawFetchResult } from './fetch-raw';

export type { ParsedItem, ParseResult, FeedSourceInput } from './types';
export { fetchRawContent, type RawFetchResult } from './fetch-raw';
export { extractMeta } from './web-parser';

export async function parseFeed(
  feedType: string,
  url: string,
): Promise<ParseResult> {
  switch (feedType) {
    case 'rss':
    case 'atom':
      return parseRssFeed(url);
    case 'api':
      return parseApiFeed(url);
    case 'web':
      return parseWebFeed(url);
    default:
      return { items: [], error: `Unsupported feed_type: ${feedType}` };
  }
}

export async function parseRawContent(
  feedType: string,
  rawContent: string,
  sourceUrl: string,
): Promise<ParseResult> {
  switch (feedType) {
    case 'rss':
    case 'atom':
      return parseRssContent(rawContent);
    case 'api':
      return parseApiContent(rawContent);
    case 'web':
      return parseWebContent(rawContent, sourceUrl);
    default:
      return { items: [], error: `Unsupported feed_type: ${feedType}` };
  }
}
