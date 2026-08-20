import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

const TRACKING_PARAMS = new Set([
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term',
  'utm_content', 'utm_id', 'fbclid', 'gclid', 'mc_cid', 'mc_eid',
]);

const REDIRECT_PARAMS = [
  'url', 'u', 'target', 'redirect', 'redirect_uri',
  'redirect_url', 'dest', 'destination', 'link', 'q',
];

const BLOCKED_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53,
  69, 70, 79, 87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115,
  117, 119, 123, 135, 137, 138, 139, 143, 161, 162, 179, 389, 427, 465,
  512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587,
  601, 636, 993, 995, 2049, 2375, 2376, 3306, 3389, 5432, 5900, 5984,
  6379, 6667, 9200, 11211, 27017,
]);

export type TraceCandidateType = 'canonical' | 'og_url' | 'structured' | 'body_link';

export interface TraceCandidate {
  url: string;
  type: TraceCandidateType;
  score: number;
  titleSimilarity: number;
  reason?: string;
}

export interface TraceResult {
  status: 'verified_reference' | 'needs_review';
  originalUrl: string | null;
  reason: string;
  candidate: TraceCandidate | null;
}

export interface UrlSafetyResult {
  safe: boolean;
  url: string | null;
  reason: string;
  address?: string;
  family?: number;
}

export interface LinkProbeResult {
  state: 'alive' | 'dead' | 'needs_review';
  detail: string;
  finalUrl: string | null;
  status: number | null;
}

const METADATA_HOSTS = new Set([
  'metadata', 'metadata.google.internal', 'metadata.internal',
  'instance-data', 'instance-data.ec2.internal',
]);

function isPrivateIpv4(value: string): boolean {
  const octets = value.split('.').map(Number);
  if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = octets;
  return a === 0 || a === 10 || a === 127 || a === 169 && b === 254
    || a === 172 && b >= 16 && b <= 31
    || a === 192 && (b === 0 || b === 168)
    || a === 198 && (b === 18 || b === 19 || b === 51)
    || a === 203 && b === 0
    || a >= 224
    || a === 100 && b >= 64 && b <= 127;
}

function isPrivateIpv6(value: string): boolean {
  const lower = value.toLowerCase().replace(/^\[|\]$/g, '');
  if (lower.startsWith('::ffff:')) {
    const mapped = lower.slice(7);
    if (mapped.includes('.')) return isPrivateIpv4(mapped);
    const groups = mapped.split(':');
    if (groups.length === 2) {
      const hi = Number.parseInt(groups[0], 16);
      const lo = Number.parseInt(groups[1], 16);
      if (Number.isFinite(hi) && Number.isFinite(lo)) {
        const n = (hi << 16) | lo;
        return isPrivateIpv4(`${(n >>> 24) & 255}.${(n >>> 16) & 255}.${(n >>> 8) & 255}.${n & 255}`);
      }
    }
  }
  return lower === '::' || lower === '::1' || lower.startsWith('fc') || lower.startsWith('fd')
    || lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea')
    || lower.startsWith('feb') || lower.startsWith('ff');
}

function isPrivateAddress(value: string, family?: number): boolean {
  const normalized = value.replace(/^\[|\]$/g, '').toLowerCase();
  if ((family ?? isIP(normalized)) === 4) return isPrivateIpv4(normalized);
  if ((family ?? isIP(normalized)) === 6) return isPrivateIpv6(normalized);
  return true;
}

/** Validate URL syntax and literal addresses without performing any network I/O. */
export function validateUrlSyntax(input: string, baseUrl?: string): UrlSafetyResult {
  if (!input || typeof input !== 'string') return { safe: false, url: null, reason: 'empty_url' };
  let parsed: URL;
  try { parsed = new URL(input, baseUrl); } catch { return { safe: false, url: null, reason: 'invalid_url' }; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return { safe: false, url: null, reason: 'unsupported_protocol' };
  if (parsed.username || parsed.password) return { safe: false, url: null, reason: 'userinfo_not_allowed' };
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost') || METADATA_HOSTS.has(hostname)) {
    return { safe: false, url: null, reason: 'local_or_metadata_host' };
  }
  const port = parsed.port ? Number(parsed.port) : (parsed.protocol === 'https:' ? 443 : 80);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || BLOCKED_PORTS.has(port)) {
    return { safe: false, url: null, reason: 'dangerous_port' };
  }
  for (const param of REDIRECT_PARAMS) {
    const nested = parsed.searchParams.get(param);
    if (nested && /^https?:\/\//i.test(nested)) {
      const nestedSafety = validateUrlSyntax(nested);
      if (!nestedSafety.safe) return { safe: false, url: null, reason: `unsafe_redirect_target:${nestedSafety.reason}` };
    }
  }
  const family = isIP(hostname);
  if (family && isPrivateAddress(hostname, family)) return { safe: false, url: null, reason: 'private_address' };
  return { safe: true, url: normalizeUrl(parsed.toString()), reason: 'syntax_ok', address: family ? hostname : undefined, family: family || undefined };
}

/** Validate DNS answers before any request is sent. Any private answer fails closed. */
export async function validateSafeUrl(input: string, baseUrl?: string): Promise<UrlSafetyResult> {
  const syntax = validateUrlSyntax(input, baseUrl);
  if (!syntax.safe || !syntax.url) return syntax;
  const parsed = new URL(syntax.url);
  if (syntax.family) return syntax;
  try {
    const answers = await lookup(parsed.hostname, { all: true, verbatim: true });
    if (!answers.length || answers.some((answer) => isPrivateAddress(answer.address, answer.family))) {
      return { safe: false, url: null, reason: 'dns_private_or_empty' };
    }
    return { ...syntax, address: answers[0].address, family: answers[0].family };
  } catch {
    return { safe: false, url: null, reason: 'dns_lookup_failed' };
  }
}

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

function extractTypedCandidates(html: string, discoveryUrl: string): TraceCandidate[] {
  const entries: TraceCandidate[] = [];
  const add = (raw: string, type: TraceCandidateType, score: number, reason: string) => {
    const syntax = validateUrlSyntax(raw, discoveryUrl);
    if (!syntax.safe || !syntax.url) return;
    entries.push({ url: syntax.url, type, score, titleSimilarity: 0, reason });
  };
  const canonicalRe = /<link[^>]*rel=["'][^"']*canonical[^"']*["'][^>]*href=["']([^"']+)["']/gi;
  const canonicalRe2 = /<link[^>]*href=["']([^"']+)["'][^>]*rel=["'][^"']*canonical[^"']*["']/gi;
  let m: RegExpExecArray | null;
  while ((m = canonicalRe.exec(html)) !== null) add(m[1], 'canonical', 100, 'html canonical');
  while ((m = canonicalRe2.exec(html)) !== null) add(m[1], 'canonical', 100, 'html canonical');
  const ogRe = /<meta[^>]*(?:property|name)=["']og:url["'][^>]*content=["']([^"']+)["']/gi;
  const ogRe2 = /<meta[^>]*content=["']([^"']+)["'][^>]*(?:property|name)=["']og:url["']/gi;
  while ((m = ogRe.exec(html)) !== null) add(m[1], 'og_url', 90, 'og:url');
  while ((m = ogRe2.exec(html)) !== null) add(m[1], 'og_url', 90, 'og:url');
  const jsonLdRe = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  while ((m = jsonLdRe.exec(html)) !== null) {
    try {
      const value: unknown = JSON.parse(m[1]);
      const stack: unknown[] = Array.isArray(value) ? value : [value];
      for (const item of stack) {
        if (item && typeof item === 'object' && typeof (item as { url?: unknown }).url === 'string') {
          add((item as { url: string }).url, 'structured', 80, 'json-ld url');
        }
      }
    } catch { /* malformed structured data is ignored */ }
  }
  const bodyRe = /https?:\/\/[^\s<>"'`]+/gi;
  while ((m = bodyRe.exec(html)) !== null) add(m[0], 'body_link', 10, 'body link; not independently verified');
  const seen = new Set<string>();
  return entries.filter((entry) => {
    if (seen.has(entry.url)) return false;
    seen.add(entry.url);
    return true;
  });
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
  if (!discoveryDomain) return 'aggregator';
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
  // Feed priority is not provenance. Unknown/null policies fail closed and
  // require tracing or manual review instead of being auto-published.
  return 'aggregator';
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
    const syntax = validateUrlSyntax(unwrapRedirects(rawUrl), sourceUrl);
    if (!syntax.safe || !syntax.url) return false;
    const url = syntax.url;

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
  const normalizedDiscovery = normalizeUrl(unwrapRedirects(discoveryUrl));
  const typed = extractTypedCandidates(rawHtml, normalizedDiscovery)
    .filter((candidate) => candidate.type !== 'body_link')
    .map((candidate) => candidate.url)
    .filter((candidate) => candidate !== normalizedDiscovery);
  return findBestOrigin(filterCandidates(typed, sourceUrl));
}

/** Async, fail-closed origin trace used by the collector before persisting a reference. */
export async function traceOriginFromContent(
  discoveryUrl: string,
  rawHtml: string,
  sourceUrl: string,
): Promise<TraceResult> {
  const discovery = await validateSafeUrl(discoveryUrl);
  if (!discovery.safe || !discovery.url) {
    return { status: 'needs_review', originalUrl: null, reason: `unsafe_discovery:${discovery.reason}`, candidate: null };
  }
  const source = validateUrlSyntax(sourceUrl);
  const sourceDomain = source.url ? getDomain(source.url) : '';
  const discoveryNormalized = discovery.url;
  const typed = extractTypedCandidates(rawHtml, discoveryNormalized)
    .filter((candidate) => candidate.url !== discoveryNormalized)
    .filter((candidate) => {
      const domain = getDomain(candidate.url);
      return domain && domain !== sourceDomain
        && !domain.endsWith(`.${sourceDomain}`) && !sourceDomain.endsWith(`.${domain}`)
        && !hasStaticExtension(candidate.url);
    });
  if (!typed.length) return { status: 'needs_review', originalUrl: null, reason: 'no_safe_candidates', candidate: null };
  const safeCandidates: TraceCandidate[] = [];
  for (const candidate of typed) {
    const safe = await validateSafeUrl(candidate.url);
    if (safe.safe && safe.url) safeCandidates.push({ ...candidate, url: safe.url });
  }
  if (!safeCandidates.length) return { status: 'needs_review', originalUrl: null, reason: 'all_candidates_unsafe', candidate: null };
  safeCandidates.sort((a, b) => b.score - a.score);
  const best = safeCandidates[0];
  if (best.type === 'body_link') {
    return { status: 'needs_review', originalUrl: null, reason: 'body_link_requires_review', candidate: best };
  }
  return { status: 'verified_reference', originalUrl: best.url, reason: best.reason || best.type, candidate: best };
}

/** Bounded HEAD/GET probe. Redirect targets are validated before following. */
export async function probeSafeLink(input: string, timeoutMs = 10_000): Promise<LinkProbeResult> {
  let current = input;
  for (let hop = 0; hop < 4; hop++) {
    const safe = await validateSafeUrl(current);
    if (!safe.safe || !safe.url) return { state: 'needs_review', detail: `unsafe_probe:${safe.reason}`, finalUrl: null, status: null };
    current = safe.url;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetch(current, {
        method: hop === 0 ? 'HEAD' : 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AI-News-Bot/1.0)', Range: 'bytes=0-0' },
      });
    } catch (error: unknown) {
      clearTimeout(timer);
      return { state: 'needs_review', detail: `probe_error:${error instanceof Error ? error.message : String(error)}`, finalUrl: null, status: null };
    } finally {
      clearTimeout(timer);
    }
    const location = response.headers.get('location');
    if (response.status >= 300 && response.status < 400 && location) {
      const next = validateUrlSyntax(location, current);
      if (!next.safe || !next.url) return { state: 'needs_review', detail: `unsafe_redirect:${next.reason}`, finalUrl: null, status: response.status };
      current = next.url;
      continue;
    }
    if (hop === 0 && (response.status === 405 || response.status === 501)) {
      // Some origin servers reject HEAD; retry the same validated URL with a
      // one-byte GET while keeping redirects manual and bounded.
      continue;
    }
    if (response.status === 404 || response.status === 410) return { state: 'dead', detail: `HTTP ${response.status} for ${current}`, finalUrl: current, status: response.status };
    if (response.status >= 400) return { state: 'needs_review', detail: `probe_status:${response.status}`, finalUrl: current, status: response.status };
    return { state: 'alive', detail: '', finalUrl: current, status: response.status };
  }
  return { state: 'needs_review', detail: 'redirect_limit', finalUrl: null, status: null };
}
