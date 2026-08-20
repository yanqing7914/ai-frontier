import type { ParseProvenance, ParseStats } from './types';

export function parserTypeFor(feedType: string): string {
  const normalized = feedType.trim().toLowerCase();
  return normalized === 'atom' ? 'atom' : normalized;
}

export function resolveHttpUrl(raw: unknown, baseUrl?: string): { original: string; canonical: string } | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const original = raw.trim();
  try {
    const parsed = baseUrl ? new URL(original, baseUrl) : new URL(original);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return { original, canonical: parsed.toString() };
  } catch {
    return null;
  }
}

export function parseDate(value: unknown): Date | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const millis = Math.abs(value) < 1e11 ? value * 1000 : value;
    const date = new Date(millis);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  if (typeof value !== 'string' || !value.trim()) return null;
  const trimmed = value.trim();
  if (/^\d{10,13}$/.test(trimmed)) return parseDate(Number(trimmed));
  const date = new Date(trimmed);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function parseDateFields(record: Record<string, unknown>, keys: string[]): Date | null {
  for (const key of keys) {
    const date = parseDate(record[key]);
    if (date) return date;
  }
  return null;
}

export function cleanHtml(value: string): string {
  return value
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

export function makeStats(input: number, parsed: number, skipped: number): ParseStats {
  return { input, parsed, skipped };
}

export function provenance(
  parserType: string,
  sourceUrl?: string,
  extra: Omit<ParseProvenance, 'parserType' | 'sourceUrl'> = {},
): ParseProvenance {
  return { parserType, sourceUrl, ...extra };
}

export function hasContentType(contentType: string | undefined, patterns: RegExp[]): boolean {
  if (!contentType) return true;
  const normalized = contentType.toLowerCase();
  return patterns.some((pattern) => pattern.test(normalized));
}

export function looksLikeJson(raw: string): boolean {
  const trimmed = raw.trim();
  return trimmed.startsWith('{') || trimmed.startsWith('[');
}

export function looksLikeXml(raw: string): boolean {
  return /^\s*(?:<\?xml[\s\S]*?\?>\s*)?<(?:rss|feed)(?:\s|>)/i.test(raw);
}

export function looksLikeHtml(raw: string): boolean {
  return /<html\b|<body\b|<!doctype\s+html/i.test(raw);
}
