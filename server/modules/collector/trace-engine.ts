const TRACKING_PARAMS = new Set([
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term',
  'utm_content', 'utm_id', 'fbclid', 'gclid', 'mc_cid', 'mc_eid',
]);

const REDIRECT_PARAMS = [
  'url', 'u', 'target', 'redirect', 'redirect_uri',
  'redirect_url', 'dest', 'destination', 'link', 'q',
];

const STATIC_EXTENSIONS = new Set([
  '.jpg', '.jpeg', '.png', '.gif', '.svg', '.webp', '.ico', '.bmp',
  '.css', '.js', '.mjs', '.cjs', '.ts', '.map',
  '.woff', '.woff2', '.ttf', '.eot', '.otf',
  '.mp3', '.mp4', '.webm', '.ogg', '.wav', '.avi',
  '.pdf', '.zip', '.tar', '.gz', '.rar', '.7z',
  '.xml', '.rss', '.atom', '.json',
  '.exe', '.dmg', '.apk', '.deb', '.rpm',
]);

export const SECOND_HAND_DOMAINS = [
  'mp.weixin.qq.com',
  'news.google.com',
  'feedburner.com',
  'rsshub.app',
  'hnrss.org',
  '36kr.com',
  'leiphone.com',
  'marktechpost.com',
  'venturebeat.com',
  'the-decoder.com',
  'techcrunch.com',
  'theverge.com',
  'latent.space',
  'lastweekin.ai',
  'producthunt.com',
];

/**
 * A feed tier describes editorial priority, not whether an article is a
 * repost. Origin tracing is therefore decided from the source's collection
 * method and editorial identity instead of treating every signal source as
 * second-hand content.
 */
export type OriginPolicy = 'first_party' | 'editorial' | 'aggregator';

const EDITORIAL_DOMAINS = [
  '36kr.com', 'jiqizhixin.com', 'qbitai.com', 'infoq.cn',
  'leiphone.com', 'geekpark.net', 'zhidx.com', 'jazzyear.com',
  'deeptechchina.com', 'huxiu.com', 'latepost.com',
];

const AUTHORITATIVE_DOMAINS = [
  'github.com',
  'arxiv.org',
  'huggingface.co',
  'openai.com',
  'anthropic.com',
  'deepmind.com',
  'blog.google',
  'blogs.microsoft.com',
  'ai.meta.com',
  'research.google',
  'aws.amazon.com',
  'azure.microsoft.com',
  'nvidia.com',
  'distill.pub',
  'openreview.net',
  'paperswithcode.com',
];

const RESEARCH_MEDIA_DOMAINS = [
  'mit.edu',
  'stanford.edu',
  'nature.com',
  'science.org',
  'arstechnica.com',
  'wired.com',
  'ieee.org',
  'acm.org',
];

const PATH_BOOST_PATTERNS = [
  '/releases/',
  '/pull/',
  '/issues/',
  'arxiv.org/abs/',
  '/blog/',
  '/news/',
  '/changelog/',
];

export function normalizeUrl(url: string): string {
  if (!url) return url;
  let cleaned = url.replace(/[.,;:!?)\]}>]+$/, '');
  try {
    const parsed = new URL(cleaned);
    for (const param of TRACKING_PARAMS) {
      parsed.searchParams.delete(param);
    }
    const result = parsed.toString();
    return result.endsWith('?') ? result.slice(0, -1) : result;
  } catch {
    return cleaned;
  }
}

export function unwrapRedirects(url: string, maxDepth = 3): string {
  let current = url;
  for (let i = 0; i < maxDepth; i++) {
    try {
      const parsed = new URL(current);
      let unwrapped = false;
      for (const param of REDIRECT_PARAMS) {
        const value = parsed.searchParams.get(param);
        if (value && /^https?:\/\//i.test(value)) {
          current = value;
          unwrapped = true;
          break;
        }
      }
      if (!unwrapped) break;
    } catch {
      break;
    }
  }
  return current;
}

export function extractCandidatesFromHtml(html: string): string[] {
  const candidates: string[] = [];

  const canonicalRe = /<link[^>]*rel=["']canonical["'][^>]*href=["']([^"']+)["']/gi;
  const canonicalRe2 = /<link[^>]*href=["']([^"']+)["'][^>]*rel=["']canonical["']/gi;
  let m: RegExpExecArray | null;
  while ((m = canonicalRe.exec(html)) !== null) candidates.push(m[1]);
  while ((m = canonicalRe2.exec(html)) !== null) candidates.push(m[1]);

  const ogUrlRe = /<meta[^>]*(?:property|name)=["']og:url["'][^>]*content=["']([^"']+)["']/gi;
  const ogUrlRe2 = /<meta[^>]*content=["']([^"']+)["'][^>]*(?:property|name)=["']og:url["']/gi;
  while ((m = ogUrlRe.exec(html)) !== null) candidates.push(m[1]);
  while ((m = ogUrlRe2.exec(html)) !== null) candidates.push(m[1]);

  const urlRe = /https?:\/\/[^\s<>"'`]+/gi;
  while ((m = urlRe.exec(html)) !== null) candidates.push(m[0]);

  return [...new Set(candidates)];
}

export function getDomain(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

export function isSecondHandDomain(domain: string): boolean {
  const lower = domain.toLowerCase();
  return SECOND_HAND_DOMAINS.some(
    (sd) => lower === sd || lower.endsWith('.' + sd),
  );
}

function isEditorialDomain(domain: string): boolean {
  const lower = domain.toLowerCase();
  return EDITORIAL_DOMAINS.some((ed) => lower === ed || lower.endsWith('.' + ed));
}

export function getOriginPolicy(input: {
  originPolicy?: OriginPolicy | string | null;
  tier?: string | null;
  discoveryUrl: string;
  sourceUrl?: string | null;
  sourceName?: string | null;
  sourceCategoryId?: string | null;
}): OriginPolicy {
  if (input.originPolicy === 'first_party' || input.originPolicy === 'editorial' || input.originPolicy === 'aggregator') {
    return input.originPolicy;
  }
  const sourceUrl = input.sourceUrl ?? '';
  const sourceName = input.sourceName ?? '';
  const sourceDomain = getDomain(sourceUrl);
  const discoveryDomain = getDomain(input.discoveryUrl);
  const isBridge = /公众号桥接|桥接|rsshub|anyfeeder|聚合|转载/i.test(`${sourceName} ${sourceUrl}`)
    || sourceDomain.includes('rsshub')
    || sourceDomain.includes('anyfeeder')
    || sourceDomain === 'mp.weixin.qq.com';

  if (isBridge) return 'aggregator';
  if (isAuthoritativeDomain(discoveryDomain) || isAuthoritativeDomain(sourceDomain)) return 'first_party';
  if (input.sourceCategoryId === 'media_analysis' || isEditorialDomain(discoveryDomain) || isEditorialDomain(sourceDomain)) {
    return 'editorial';
  }
  if (isSecondHandDomain(sourceDomain) || isSecondHandDomain(discoveryDomain)) return 'aggregator';
  // Validation/signal is a priority, not a provenance assertion. Unknown
  // sources remain conservative and require evidence until classified.
  return input.tier === 'authoritative' ? 'first_party' : 'editorial';
}

function isAuthoritativeDomain(domain: string): boolean {
  const lower = domain.toLowerCase();
  return AUTHORITATIVE_DOMAINS.some(
    (ad) => lower === ad || lower.endsWith('.' + ad),
  );
}

function isResearchMediaDomain(domain: string): boolean {
  const lower = domain.toLowerCase();
  return RESEARCH_MEDIA_DOMAINS.some(
    (rd) => lower === rd || lower.endsWith('.' + rd),
  );
}

function hasStaticExtension(url: string): boolean {
  const path = url.split('?')[0].toLowerCase();
  const dotIdx = path.lastIndexOf('.');
  if (dotIdx === -1) return false;
  return STATIC_EXTENSIONS.has(path.slice(dotIdx));
}

export function filterCandidates(
  candidates: string[],
  sourceUrl: string,
): string[] {
  const sourceDomain = getDomain(sourceUrl);
  const normalizedSource = normalizeUrl(unwrapRedirects(sourceUrl));

  return candidates.filter((rawUrl) => {
    const url = normalizeUrl(unwrapRedirects(rawUrl));

    if (hasStaticExtension(url)) return false;
    if (url === normalizedSource) return false;

    const domain = getDomain(url);
    if (!domain) return false;
    if (domain === sourceDomain || sourceDomain.endsWith('.' + domain) || domain.endsWith('.' + sourceDomain)) {
      return false;
    }

    return true;
  });
}

export function scoreCandidate(url: string): number {
  let score = 5;
  const domain = getDomain(url);

  if (isAuthoritativeDomain(domain)) {
    score = 20;
  } else if (isResearchMediaDomain(domain)) {
    score = 10;
  }

  if (isSecondHandDomain(domain)) {
    score -= 30;
  }

  for (const pattern of PATH_BOOST_PATTERNS) {
    if (url.includes(pattern)) {
      score += 6;
      break;
    }
  }

  return score;
}

export function findBestOrigin(candidates: string[]): string | null {
  if (candidates.length === 0) return null;

  let bestUrl = candidates[0];
  let bestScore = scoreCandidate(candidates[0]);

  for (let i = 1; i < candidates.length; i++) {
    const s = scoreCandidate(candidates[i]);
    if (s > bestScore) {
      bestScore = s;
      bestUrl = candidates[i];
    }
  }

  return bestScore > 0 ? bestUrl : null;
}

export function shouldTrace(tier: string, discoveryUrl: string): boolean {
  return getOriginPolicy({ tier, discoveryUrl }) === 'aggregator';
}

export function normalizeTitle(title: string): string {
  return title
    .trim()
    .replace(/^[.,;:!?'"()[\]{}]+|[.,;:!?'"()[\]{}]+$/g, '')
    .toLowerCase();
}

export function traceFromRssContent(
  discoveryUrl: string,
  rawHtml: string,
  sourceUrl: string,
): string | null {
  const processed = new Set<string>();
  const normalizedDiscovery = normalizeUrl(unwrapRedirects(discoveryUrl));
  processed.add(normalizedDiscovery);

  const rawCandidates = extractCandidatesFromHtml(rawHtml);
  const allCandidates: string[] = [];

  for (const raw of rawCandidates) {
    const normalized = normalizeUrl(unwrapRedirects(raw));
    if (processed.has(normalized)) continue;
    processed.add(normalized);
    allCandidates.push(normalized);
  }

  const filtered = filterCandidates(allCandidates, sourceUrl);
  return findBestOrigin(filtered);
}
