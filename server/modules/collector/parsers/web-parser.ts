import type { ParsedItem, ParseResult } from './types';
import { cleanHtml, makeStats, parseDate, provenance, resolveHttpUrl } from './utils';

const WEB_TIMEOUT = 15000;

interface ExtractedMeta {
  title: string;
  canonicalUrl: string;
  ogUrl: string;
  description: string;
  datePublished: string;
  dateUpdated: string;
  bodyText: string;
  bodyStatus: 'full' | 'summary' | 'missing';
  warnings: string[];
}

function attribute(attrs: string, name: string): string {
  const match = attrs.match(new RegExp(`${name}\\s*=\\s*["']([^"']*)["']`, 'i'));
  return match?.[1]?.trim() || '';
}

function collectJsonLdDates(value: unknown, meta: ExtractedMeta): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const entry of value) collectJsonLdDates(entry, meta);
    return;
  }
  const obj = value as Record<string, unknown>;
  if (!meta.datePublished && typeof obj.datePublished === 'string') meta.datePublished = obj.datePublished;
  if (!meta.datePublished && typeof obj.dateCreated === 'string') meta.datePublished = obj.dateCreated;
  if (!meta.dateUpdated && typeof obj.dateModified === 'string') meta.dateUpdated = obj.dateModified;
  if (!meta.title && typeof obj.headline === 'string') meta.title = obj.headline.trim();
  if (!meta.description && typeof obj.description === 'string') meta.description = obj.description.trim();
  if (obj['@graph']) collectJsonLdDates(obj['@graph'], meta);
}

function extractMeta(html: string): ExtractedMeta {
  const meta: ExtractedMeta = {
    title: '', canonicalUrl: '', ogUrl: '', description: '', datePublished: '', dateUpdated: '',
    bodyText: '', bodyStatus: 'missing', warnings: [],
  };

  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (titleMatch) meta.title = cleanHtml(titleMatch[1]);

  const linkRe = /<link\s+([^>]+)>/gi;
  let linkMatch: RegExpExecArray | null;
  while ((linkMatch = linkRe.exec(html)) !== null) {
    const attrs = linkMatch[1];
    if (/\brel\s*=\s*["'][^"']*canonical[^"']*["']/i.test(attrs)) meta.canonicalUrl = attribute(attrs, 'href');
  }

  const metaTagRe = /<meta\s+([^>]+)>/gi;
  let m: RegExpExecArray | null;
  while ((m = metaTagRe.exec(html)) !== null) {
    const attrs = m[1];
    const prop = attribute(attrs, 'property') || attribute(attrs, 'name');
    const content = attribute(attrs, 'content');
    if (!prop || !content) continue;
    const normalized = prop.toLowerCase();
    if (normalized === 'og:url') meta.ogUrl = content;
    if (normalized === 'og:title' && !meta.title) meta.title = content;
    if ((normalized === 'description' || normalized === 'og:description') && !meta.description) meta.description = content;
    if (normalized === 'article:published_time' || normalized === 'datepublished' || normalized === 'date') {
      if (!meta.datePublished) meta.datePublished = content;
    }
    if (normalized === 'article:modified_time' || normalized === 'datemodified') {
      if (!meta.dateUpdated) meta.dateUpdated = content;
    }
  }

  const jsonLdRe = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let jm: RegExpExecArray | null;
  while ((jm = jsonLdRe.exec(html)) !== null) {
    try { collectJsonLdDates(JSON.parse(jm[1]), meta); } catch { meta.warnings.push('invalid JSON-LD ignored'); }
  }

  const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  if (bodyMatch) {
    const bodyHtml = bodyMatch[1]
      .replace(/<(?:nav|header|footer|aside|form|script|style)[^>]*>[\s\S]*?<\/(?:nav|header|footer|aside|form|script|style)>/gi, ' ');
    const contentMatch = bodyHtml.match(/<(?:article|main)[^>]*>([\s\S]*?)<\/(?:article|main)>/i);
    const text = cleanHtml(contentMatch ? contentMatch[1] : bodyHtml);
    if (text.length >= 40) {
      meta.bodyText = text.slice(0, 10000);
      meta.bodyStatus = 'full';
    }
  }
  if (meta.bodyStatus === 'missing' && meta.description) meta.bodyStatus = 'summary';
  if (!meta.bodyText && !meta.description) meta.warnings.push('body and description missing');
  return meta;
}

function looksLikeBlockedPage(html: string, title: string): string | null {
  const lower = `${title}\n${cleanHtml(html.slice(0, 20000))}`.toLowerCase();
  if (/captcha|verify you are human|robot check|access denied|security check/.test(lower)) return 'captcha or bot challenge page';
  if (/sign in|log in|登录|验证码|账号登录/.test(lower) && /password|密码|verification|验证/.test(lower)) return 'login or verification page';
  if (/404|page not found|页面不存在|内容不存在|not found/.test(lower)) return 'soft-404 page';
  return null;
}

function buildResult(rawHtml: string, fallbackUrl: string, http?: { finalUrl?: string; contentType?: string; httpStatus?: number }): ParseResult {
  const meta = extractMeta(rawHtml);
  const blocked = looksLikeBlockedPage(rawHtml, meta.title);
  const baseUrl = http?.finalUrl || fallbackUrl;
  const resolvedCanonical = resolveHttpUrl(meta.canonicalUrl || meta.ogUrl || baseUrl, baseUrl);
  if (blocked) return { items: [], error: blocked, warnings: meta.warnings, stats: makeStats(1, 0, 1), provenance: provenance('web', fallbackUrl, { ...http, finalUrl: baseUrl }) };
  if (!meta.title) return { items: [], error: 'No title found in page', warnings: meta.warnings, stats: makeStats(1, 0, 1), provenance: provenance('web', fallbackUrl, { ...http, finalUrl: baseUrl }) };
  if (meta.bodyStatus === 'missing') return { items: [], error: 'No reliable article body found in page', warnings: meta.warnings, stats: makeStats(1, 0, 1), provenance: provenance('web', fallbackUrl, { ...http, finalUrl: baseUrl }) };
  if (!resolvedCanonical) return { items: [], error: 'Page did not contain a safe http(s) URL', stats: makeStats(1, 0, 1), provenance: provenance('web', fallbackUrl, { ...http, finalUrl: baseUrl }) };

  const item: ParsedItem = {
    title: meta.title,
    url: resolvedCanonical.canonical,
    originalUrl: resolvedCanonical.original,
    canonicalUrl: meta.canonicalUrl ? resolvedCanonical.canonical : undefined,
    publishedAt: parseDate(meta.datePublished) || parseDate(meta.dateUpdated),
    content: meta.bodyText || meta.description,
    rawContent: rawHtml.slice(0, 20000),
    contentStatus: meta.bodyStatus,
    warnings: meta.warnings.length ? meta.warnings : undefined,
  };
  return { items: [item], warnings: meta.warnings.length ? meta.warnings : undefined, stats: makeStats(1, 1, 0), provenance: provenance('web', fallbackUrl, { ...http, finalUrl: baseUrl }) };
}

export async function parseWebContent(rawHtml: string, fallbackUrl: string): Promise<ParseResult> {
  try { return buildResult(rawHtml, fallbackUrl); }
  catch (error: unknown) {
    const errMsg = error instanceof Error ? error.message : String(error);
    return { items: [], error: errMsg, stats: makeStats(1, 0, 1), provenance: provenance('web', fallbackUrl) };
  }
}

export async function parseWebFeed(url: string): Promise<ParseResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WEB_TIMEOUT);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'AI-News-Dashboard/1.0', 'Accept': 'text/html,application/xhtml+xml' },
      redirect: 'follow',
    });
    const finalUrl = response.url || url;
    const contentType = response.headers?.get('content-type') || '';
    if (!response.ok) return { items: [], error: `HTTP ${response.status} for ${url}`, stats: makeStats(0, 0, 0), provenance: provenance('web', url, { finalUrl, contentType, httpStatus: response.status }) };
    const html = await response.text();
    return buildResult(html, url, { finalUrl, contentType, httpStatus: response.status });
  } catch (error: unknown) {
    const errMsg = error instanceof Error ? error.message : String(error);
    return { items: [], error: errMsg, stats: makeStats(0, 0, 0), provenance: provenance('web', url) };
  } finally { clearTimeout(timer); }
}

export { extractMeta };
