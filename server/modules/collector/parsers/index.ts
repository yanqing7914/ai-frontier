import type { ParseResult } from './types';
import { parseRssFeed } from './rss-parser';
import { parseApiFeed } from './api-parser';
import { parseWebFeed } from './web-parser';

export type { ParsedItem, ParseResult, FeedSourceInput } from './types';

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
