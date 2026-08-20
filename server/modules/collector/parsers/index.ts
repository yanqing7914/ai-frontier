import type { ParseResult } from './types';
import { parseRssFeed, parseRssContent } from './rss-parser';
import { parseApiFeed, parseApiContent } from './api-parser';
import { parseWebFeed, parseWebContent, extractMeta } from './web-parser';
import {
  fetchRawContent,
  FetchBodyTooLargeError,
  FetchHttpError,
  parseRetryAfter,
  type RawFetchOptions,
  type RawFetchResult,
} from './fetch-raw';
import { hasContentType, looksLikeHtml, looksLikeJson, looksLikeXml, parserTypeFor, provenance } from './utils';

export type { ParsedItem, ParseResult, FeedSourceInput } from './types';
export {
  fetchRawContent,
  FetchBodyTooLargeError,
  FetchHttpError,
  parseRetryAfter,
  type RawFetchOptions,
  type RawFetchResult,
} from './fetch-raw';
export { extractMeta } from './web-parser';

export interface RawParseOptions {
  finalUrl?: string;
  contentType?: string;
  httpStatus?: number;
}

function formatMismatch(feedType: string, rawContent: string, contentType?: string): string | undefined {
  const type = parserTypeFor(feedType);
  const header = contentType ? `Content-Type ${contentType}` : 'response body';
  if (type === 'rss' || type === 'atom') {
    if (contentType && !hasContentType(contentType, [/(?:application|text)\/(?:rss|atom|xml)|application\/rdf\+xml/i])) {
      return `${header} does not match ${type.toUpperCase()} parser`;
    }
    if (!looksLikeXml(rawContent)) return `response body does not match ${type.toUpperCase()} XML format`;
  }
  if (type === 'api') {
    if (contentType && !hasContentType(contentType, [/application\/(?:[\w.+-]*\+)?json/i, /text\/json/i])) {
      return `${header} does not match API JSON parser`;
    }
    if (!looksLikeJson(rawContent)) return 'response body does not match API JSON format';
  }
  if (type === 'web') {
    if (contentType && !hasContentType(contentType, [/text\/html/i, /application\/xhtml\+xml/i])) {
      return `${header} does not match web HTML parser`;
    }
    if (!looksLikeHtml(rawContent)) return 'response body does not match web HTML format';
  }
  return undefined;
}

export async function parseFeed(
  feedType: string,
  url: string,
): Promise<ParseResult> {
  const type = feedType.trim().toLowerCase();
  switch (type) {
    case 'rss':
    case 'atom':
      return parseRssFeed(url);
    case 'api':
      return parseApiFeed(url);
    case 'web':
      return parseWebFeed(url);
    default:
      return { items: [], error: `Unsupported feed_type: ${feedType}`, provenance: provenance(type, url) };
  }
}

export async function parseRawContent(
  feedType: string,
  rawContent: string,
  sourceUrl: string,
  options: RawParseOptions = {},
): Promise<ParseResult> {
  const type = feedType.trim().toLowerCase();
  const finalUrl = options.finalUrl || sourceUrl;
  const mismatch = formatMismatch(type, rawContent, options.contentType);
  if (mismatch) {
    return {
      items: [],
      error: mismatch,
      stats: { input: 0, parsed: 0, skipped: 0 },
      provenance: provenance(parserTypeFor(type), sourceUrl, {
        finalUrl,
        contentType: options.contentType,
        httpStatus: options.httpStatus,
      }),
    };
  }
  let result: ParseResult;
  switch (type) {
    case 'rss':
    case 'atom':
      result = await parseRssContent(rawContent, finalUrl);
      break;
    case 'api':
      result = await parseApiContent(rawContent, finalUrl);
      break;
    case 'web':
      result = await parseWebContent(rawContent, finalUrl);
      break;
    default:
      return { items: [], error: `Unsupported feed_type: ${feedType}`, provenance: provenance(type, sourceUrl) };
  }
  return {
    ...result,
    provenance: {
      ...result.provenance,
      sourceUrl,
      finalUrl,
      contentType: options.contentType,
      httpStatus: options.httpStatus,
      parserType: parserTypeFor(type),
    },
  };
}
