import type { ParsedItem, ParseResult } from './types';
import { cleanHtml, makeStats, parseDateFields, provenance, resolveHttpUrl } from './utils';

const API_TIMEOUT = 15000;
const COLLECTION_KEYS = ['items', 'results', 'entries', 'posts', 'articles'];
const WRAPPER_KEYS = ['data', 'payload', 'response'];

interface ExtractedCollection {
  items: unknown[];
  recognized: boolean;
}

function getCollection(value: unknown): ExtractedCollection {
  if (Array.isArray(value)) return { items: value, recognized: true };
  if (!value || typeof value !== 'object') return { items: [], recognized: false };
  const obj = value as Record<string, unknown>;
  for (const key of COLLECTION_KEYS) {
    if (Array.isArray(obj[key])) return { items: obj[key] as unknown[], recognized: true };
  }
  if (Array.isArray(obj.edges)) {
    return {
      items: (obj.edges as unknown[]).map((edge) => (
        edge && typeof edge === 'object' && 'node' in edge
          ? (edge as Record<string, unknown>).node
          : edge
      )),
      recognized: true,
    };
  }
  for (const wrapper of WRAPPER_KEYS) {
    const nested = getCollection(obj[wrapper]);
    if (nested.recognized) return nested;
  }
  for (const value of Object.values(obj)) {
    if (!value || typeof value !== 'object') continue;
    const nested = getCollection(value);
    if (nested.recognized) return nested;
  }
  return { items: [], recognized: false };
}

function stringValue(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (value && typeof value === 'object') {
    const rendered = (value as Record<string, unknown>).rendered;
    if (typeof rendered === 'string') return rendered.trim();
  }
  return '';
}

function extractStringField(item: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const text = stringValue(item[key]);
    if (text) return text;
  }
  return '';
}

function extractBody(item: Record<string, unknown>): { raw: string; status: 'full' | 'summary' | 'missing' } {
  const full = extractStringField(item, ['content', 'body', 'text', 'articleBody']);
  if (full) return { raw: full, status: 'full' };
  const summary = extractStringField(item, ['description', 'summary', 'excerpt']);
  if (summary) return { raw: summary, status: 'summary' };
  return { raw: '', status: 'missing' };
}

function convertItems(rawItems: unknown[], sourceUrl: string): { items: ParsedItem[]; skipped: number; warnings: string[] } {
  const items: ParsedItem[] = [];
  const warnings: string[] = [];
  let skipped = 0;
  for (let index = 0; index < rawItems.length; index++) {
    const raw = rawItems[index];
    if (!raw || typeof raw !== 'object') {
      skipped++;
      warnings.push(`item ${index + 1} skipped: item is not an object`);
      continue;
    }
    const obj = raw as Record<string, unknown>;
    const title = cleanHtml(extractStringField(obj, ['title', 'name', 'headline']));
    const resolvedUrl = resolveHttpUrl(extractStringField(obj, ['url', 'link', 'href', 'permalink', 'guid']), sourceUrl);
    if (!title || !resolvedUrl) {
      skipped++;
      warnings.push(`item ${index + 1} skipped: missing title or safe http(s) link`);
      continue;
    }
    const body = extractBody(obj);
    const content = cleanHtml(body.raw);
    items.push({
      title,
      url: resolvedUrl.canonical,
      originalUrl: resolvedUrl.original,
      canonicalUrl: resolvedUrl.canonical,
      publishedAt: parseDateFields(obj, [
        'isoDate', 'publishedAt', 'published_at', 'published', 'updated', 'updatedAt', 'updated_at',
        'date', 'pubDate', 'created_at', 'createdAt', 'datePublished', 'timestamp', 'dc:date',
      ]),
      content,
      rawContent: JSON.stringify(obj),
      contentStatus: body.status,
      warnings: body.status === 'missing' ? ['body missing from API item'] : undefined,
    });
  }
  return { items, skipped, warnings };
}

export async function parseApiContent(rawJson: string, sourceUrl = ''): Promise<ParseResult> {
  try {
    const data = JSON.parse(rawJson);
    const collection = getCollection(data);
    if (!collection.recognized) {
      return {
        items: [],
        error: 'Unrecognized API response structure: expected an item array, data.items, or GraphQL edges',
        stats: makeStats(0, 0, 0),
        provenance: provenance('api', sourceUrl),
      };
    }
    const converted = convertItems(collection.items, sourceUrl);
    const error = collection.items.length > 0 && converted.items.length === 0
      ? 'API response contained no parseable items'
      : undefined;
    return {
      items: converted.items,
      error,
      warnings: converted.warnings.length ? converted.warnings : undefined,
      stats: makeStats(collection.items.length, converted.items.length, converted.skipped),
      provenance: provenance('api', sourceUrl),
    };
  } catch (error: unknown) {
    const errMsg = error instanceof Error ? error.message : String(error);
    return { items: [], error: errMsg, stats: makeStats(0, 0, 0), provenance: provenance('api', sourceUrl) };
  }
}

export async function parseApiFeed(url: string): Promise<ParseResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'AI-News-Dashboard/1.0', 'Accept': 'application/json' },
      redirect: 'follow',
    });
    const finalUrl = response.url || url;
    const contentType = response.headers?.get('content-type') || '';
    if (!response.ok) {
      return { items: [], error: `HTTP ${response.status} for ${url}`, stats: makeStats(0, 0, 0), provenance: provenance('api', url, { finalUrl, contentType, httpStatus: response.status }) };
    }
    const body = typeof response.text === 'function'
      ? await response.text()
      : JSON.stringify(await response.json());
    const result = await parseApiContent(body, finalUrl);
    return {
      ...result,
      provenance: provenance('api', url, { finalUrl, contentType, httpStatus: response.status }),
    };
  } catch (error: unknown) {
    const errMsg = error instanceof Error ? error.message : String(error);
    return { items: [], error: errMsg, stats: makeStats(0, 0, 0), provenance: provenance('api', url) };
  } finally {
    clearTimeout(timer);
  }
}
