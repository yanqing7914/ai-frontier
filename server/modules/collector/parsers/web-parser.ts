import type { ParsedItem, ParseResult } from './types';

const WEB_TIMEOUT = 15000;

interface ExtractedMeta {
  title: string;
  canonicalUrl: string;
  ogUrl: string;
  description: string;
  datePublished: string;
  bodyText: string;
}

function extractMeta(html: string): ExtractedMeta {
  const meta: ExtractedMeta = {
    title: '',
    canonicalUrl: '',
    ogUrl: '',
    description: '',
    datePublished: '',
    bodyText: '',
  };

  const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  if (titleMatch) meta.title = titleMatch[1].trim();

  const canonicalMatch = html.match(/<link[^>]*rel=["']canonical["'][^>]*href=["']([^"']+)["']/i)
    || html.match(/<link[^>]*href=["']([^"']+)["'][^>]*rel=["']canonical["']/i);
  if (canonicalMatch) meta.canonicalUrl = canonicalMatch[1];

  const metaTagRe = /<meta\s+([^>]+)>/gi;
  let m: RegExpExecArray | null;
  while ((m = metaTagRe.exec(html)) !== null) {
    const attrs = m[1];
    const propMatch = attrs.match(/(?:property|name)=["']([^"']+)["']/i);
    const contentMatch = attrs.match(/content=["']([^"']+)["']/i);
    if (!propMatch || !contentMatch) continue;
    const prop = propMatch[1];
    const content = contentMatch[1];
    if (prop === 'og:url') meta.ogUrl = content;
    if (prop === 'og:title' && !meta.title) meta.title = content;
    if (prop === 'og:description') meta.description = content;
    if (prop === 'article:published_time' && !meta.datePublished) meta.datePublished = content;
  }

  const jsonLdRe = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let jm: RegExpExecArray | null;
  while ((jm = jsonLdRe.exec(html)) !== null) {
    try {
      const ld = JSON.parse(jm[1]);
      const items = Array.isArray(ld) ? ld : [ld];
      for (const item of items) {
        if (item.datePublished && !meta.datePublished) meta.datePublished = item.datePublished;
        if (item.headline && !meta.title) meta.title = item.headline;
        if (item.description && !meta.description) meta.description = item.description;
      }
    } catch {
      // ignore invalid JSON-LD
    }
  }

  const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  if (bodyMatch) {
    const bodyHtml = bodyMatch[1];
    const contentMatch = bodyHtml.match(/<(?:article|main)[^>]*>([\s\S]*?)<\/(?:article|main)>/i);
    const targetHtml = contentMatch ? contentMatch[1] : bodyHtml;
    const text = targetHtml.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    meta.bodyText = text.slice(0, 5000);
  }

  return meta;
}

export async function parseWebFeed(url: string): Promise<ParseResult> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), WEB_TIMEOUT);
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'AI-News-Dashboard/1.0',
        'Accept': 'text/html,application/xhtml+xml',
      },
    });
    clearTimeout(timer);

    if (!response.ok) {
      return { items: [], error: `HTTP ${response.status} for ${url}` };
    }

    const html = await response.text();
    const meta = extractMeta(html);

    const finalUrl = meta.canonicalUrl || meta.ogUrl || url;
    const title = meta.title;
    if (!title) {
      return { items: [], error: 'No title found in page' };
    }

    const content = meta.description || meta.bodyText.slice(0, 500) || title;
    const publishedAt = meta.datePublished
      ? new Date(meta.datePublished)
      : null;

    const item: ParsedItem = {
      title,
      url: finalUrl,
      canonicalUrl: meta.canonicalUrl || undefined,
      publishedAt: publishedAt && !isNaN(publishedAt.getTime()) ? publishedAt : null,
      content,
      rawContent: html.slice(0, 10000),
    };

    return { items: [item] };
  } catch (error: unknown) {
    const errMsg = error instanceof Error ? error.message : String(error);
    return { items: [], error: errMsg };
  }
}

export { extractMeta };
