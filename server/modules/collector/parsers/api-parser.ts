import type { ParsedItem, ParseResult } from './types';

const API_TIMEOUT = 15000;

function extractItemsArray(data: unknown): unknown[] {
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object') {
    const obj = data as Record<string, unknown>;
    for (const key of ['items', 'data', 'results', 'entries', 'posts', 'articles']) {
      if (Array.isArray(obj[key])) return obj[key] as unknown[];
    }
  }
  return [];
}

function extractStringField(item: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const val = item[key];
    if (typeof val === 'string' && val.trim()) return val.trim();
  }
  return '';
}

function extractDateField(item: Record<string, unknown>, keys: string[]): Date | null {
  for (const key of keys) {
    const val = item[key];
    if (typeof val === 'string' || typeof val === 'number') {
      const d = new Date(val);
      if (!isNaN(d.getTime())) return d;
    }
  }
  return null;
}

export async function parseApiContent(rawJson: string): Promise<ParseResult> {
  try {
    const data = JSON.parse(rawJson);
    const rawItems = extractItemsArray(data);
    const items: ParsedItem[] = [];

    for (const raw of rawItems) {
      if (!raw || typeof raw !== 'object') continue;
      const obj = raw as Record<string, unknown>;

      const title = extractStringField(obj, ['title', 'name', 'headline']);
      const link = extractStringField(obj, ['url', 'link', 'href', 'permalink']);
      if (!title || !link) continue;

      const content = extractStringField(obj, [
        'content', 'description', 'summary', 'body', 'text', 'excerpt',
      ]);
      const publishedAt = extractDateField(obj, [
        'publishedAt', 'published_at', 'date', 'pubDate', 'created_at', 'createdAt',
      ]);

      items.push({
        title,
        url: link,
        publishedAt,
        content: content || title,
        rawContent: JSON.stringify(obj),
      });
    }

    return { items };
  } catch (error: unknown) {
    const errMsg = error instanceof Error ? error.message : String(error);
    return { items: [], error: errMsg };
  }
}

export async function parseApiFeed(url: string): Promise<ParseResult> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), API_TIMEOUT);
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'AI-News-Dashboard/1.0',
        'Accept': 'application/json',
      },
    });
    clearTimeout(timer);

    if (!response.ok) {
      return { items: [], error: `HTTP ${response.status} for ${url}` };
    }

    const data = await response.json();
    const rawItems = extractItemsArray(data);
    const items: ParsedItem[] = [];

    for (const raw of rawItems) {
      if (!raw || typeof raw !== 'object') continue;
      const obj = raw as Record<string, unknown>;

      const title = extractStringField(obj, ['title', 'name', 'headline']);
      const link = extractStringField(obj, ['url', 'link', 'href', 'permalink']);
      if (!title || !link) continue;

      const content = extractStringField(obj, [
        'content', 'description', 'summary', 'body', 'text', 'excerpt',
      ]);
      const publishedAt = extractDateField(obj, [
        'publishedAt', 'published_at', 'date', 'pubDate', 'created_at', 'createdAt',
      ]);

      items.push({
        title,
        url: link,
        publishedAt,
        content: content || title,
        rawContent: JSON.stringify(obj),
      });
    }

    return { items };
  } catch (error: unknown) {
    const errMsg = error instanceof Error ? error.message : String(error);
    return { items: [], error: errMsg };
  }
}
