import { Injectable, Inject, Logger } from '@nestjs/common';
import { DRIZZLE_DATABASE } from '../../infrastructure/database';
import type { PostgresJsDatabase } from '../../infrastructure/database';
import { CapabilityService } from '../../infrastructure/capability.service';
import { eq } from 'drizzle-orm';
import { hotlistSnapshot } from '@server/database/schema';
import type {
  GithubTrendingItem,
  WeiboHotItem,
  HotlistResponse,
} from '@shared/api.interface';

interface CacheEntry {
  data: unknown;
  expiresAt: number;
}

interface RawGithubItem {
  rank: number;
  repo: string;
  description: string;
  language: string;
  stars: number;
  starsToday: number;
}

interface WeiboRawItem {
  is_ad?: boolean;
  word?: string;
  note?: string;
  num?: number;
  label_name?: string;
}

const GITHUB_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
  'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

const WEIBO_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
  'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

const FETCH_TIMEOUT = 10_000;
const CACHE_TTL = 15 * 60 * 1000; // 15 minutes

@Injectable()
export class HotlistService {
  private readonly logger = new Logger(HotlistService.name);
  private readonly cache = new Map<string, CacheEntry>();
  private readonly translationCache = new Map<string, string>();

  constructor(
    @Inject(DRIZZLE_DATABASE)
    private readonly db: PostgresJsDatabase,
    private readonly capabilityService: CapabilityService,
  ) {}

  // ─── Cache helpers ───────────────────────────────────────────

  private getCached<T>(key: string): T | null {
    const entry = this.cache.get(key);
    if (!entry || Date.now() > entry.expiresAt) return null;
    return entry.data as T;
  }

  private setCache(key: string, data: unknown): void {
    this.cache.set(key, {
      data,
      expiresAt: Date.now() + CACHE_TTL,
    });
  }

  clearCache(key: string): void {
    this.cache.delete(key);
  }

  // ─── DB snapshot helpers ─────────────────────────────────────

  private async saveSnapshot(
    kind: string,
    items: unknown[],
  ): Promise<void> {
    try {
      const [existing] = await this.db
        .select({ id: hotlistSnapshot.id })
        .from(hotlistSnapshot)
        .where(eq(hotlistSnapshot.kind, kind));

      if (existing) {
        await this.db
          .update(hotlistSnapshot)
          .set({
            items,
            snapshotAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(hotlistSnapshot.kind, kind));
      } else {
        await this.db.insert(hotlistSnapshot).values({
          kind,
          items,
          snapshotAt: new Date(),
        });
      }
    } catch (err: unknown) {
      this.logger.warn(
        `Failed to save snapshot for ${kind}: ${String(err)}`,
      );
    }
  }

  private async loadSnapshot(
    kind: string,
  ): Promise<{ items: unknown[]; updatedAt: string; unavailable?: boolean } | null> {
    try {
      const [row] = await this.db
        .select()
        .from(hotlistSnapshot)
        .where(eq(hotlistSnapshot.kind, kind));
      if (!row) return null;
      return {
        items: row.items as unknown[],
        updatedAt: row.snapshotAt.toISOString(),
      };
    } catch (err: unknown) {
      this.logger.warn(
        `Failed to load snapshot for ${kind}: ${String(err)}`,
      );
      return { items: [], updatedAt: new Date().toISOString(), unavailable: true };
    }
  }

  // ─── HTTP fetch with timeout ─────────────────────────────────

  private async fetchWithTimeout(
    url: string,
    init: RequestInit,
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
    try {
      return await fetch(url, {
        ...init,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  // ─── GitHub Trending ─────────────────────────────────────────

  async getGithubTrending(
    since: 'daily' | 'weekly',
  ): Promise<HotlistResponse<GithubTrendingItem>> {
    const cacheKey = `github:${since}`;
    const cached = this.getCached<HotlistResponse<GithubTrendingItem>>(
      cacheKey,
    );
    if (cached) return cached;

    try {
      const url = `https://github.com/trending?since=${since}`;
      const res = await this.fetchWithTimeout(url, {
        headers: {
          'User-Agent': GITHUB_USER_AGENT,
          Accept: 'text/html',
        },
      });

      if (!res.ok) {
        throw new Error(
          `GitHub trending returned ${res.status}`,
        );
      }

      const html = await res.text();
      const rawItems = this.parseGithubTrendingHtml(html);

      if (rawItems.length === 0) {
        throw new Error('Parsed 0 items from GitHub trending HTML');
      }

      // Translate descriptions sequentially
      const items: GithubTrendingItem[] = [];
      for (const raw of rawItems) {
        const descriptionZh = await this.translateDescription(
          raw.repo,
          raw.description,
        );
        items.push({
          rank: raw.rank,
          repo: raw.repo,
          url: `https://github.com/${raw.repo}`,
          description: raw.description,
          descriptionZh,
          language: raw.language,
          stars: raw.stars,
          starsToday: raw.starsToday,
        });
      }

      const now = new Date().toISOString();
      const response: HotlistResponse<GithubTrendingItem> = {
        ok: true,
        kind: 'github',
        updatedAt: now,
        source: 'live',
        items,
      };

      this.setCache(cacheKey, response);
      await this.saveSnapshot('github', items);

      return response;
    } catch (err: unknown) {
      this.logger.warn(
        `GitHub trending fetch/parse failed: ${String(err)}`,
      );
      return this.fallbackToSnapshot<GithubTrendingItem>('github');
    }
  }

  private parseGithubTrendingHtml(html: string): RawGithubItem[] {
    const items: RawGithubItem[] = [];
    const articleBlocks = html.split(/<article\s+class="Box-row"/);

    for (let i = 1; i < articleBlocks.length; i++) {
      const block = articleBlocks[i];

      // Extract repo name from h2 > a href like "/owner/name"
      const repoMatch = block.match(
        /<h2[^>]*>[\s\S]*?<a[^>]*href="\/([^"]+)"[\s\S]*?<\/a>/,
      );
      if (!repoMatch) continue;
      const repo = repoMatch[1].trim().replace(/\s+/g, '');

      // Extract description from <p class="col-9...">
      const descMatch = block.match(
        /<p\s+class="col-9[^"]*"[^>]*>([\s\S]*?)<\/p>/,
      );
      const description = descMatch
        ? descMatch[1]
            .replace(/<[^>]*>/g, '')
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'")
            .replace(/&apos;/g, "'")
            .replace(/&#(\d+);/g, (_, code: string) =>
              String.fromCharCode(parseInt(code, 10)),
            )
            .trim()
        : '';

      // Extract language
      const langMatch = block.match(
        /itemprop="programmingLanguage"[^>]*>([^<]+)</,
      );
      const language = langMatch ? langMatch[1].trim() : '';

      // Extract total stars (capture full <a> inner content, strip tags, extract number)
      const starsMatch = block.match(
        /href="\/[^"]*\/stargazers"[^>]*>([\s\S]*?)<\/a>/,
      );
      const stars = starsMatch
        ? parseInt(
            starsMatch[1]
              .replace(/<[^>]*>/g, '')
              .replace(/,/g, '')
              .trim(),
            10,
          ) || 0
        : 0;

      // Extract stars today/this week
      const todayMatch = block.match(
        /([\d,]+)\s+stars?\s+(?:today|this week|this month)/i,
      );
      const starsToday = todayMatch
        ? parseInt(todayMatch[1].replace(/,/g, ''), 10) || 0
        : 0;

      items.push({
        rank: i,
        repo,
        description,
        language,
        stars,
        starsToday,
      });
    }

    return items;
  }

  private async translateDescription(
    repoFullName: string,
    description: string,
  ): Promise<string> {
    if (!description) return '';

    // Check translation cache
    const cached = this.translationCache.get(repoFullName);
    if (cached) return cached;

    try {
      const result = await this.capabilityService
        .load('github_repo_desc_translate_1')
        .call('textToJson', { repo_desc_en: description });

      const zh =
        (result as Record<string, string>)?.description_zh
        || description;
      this.translationCache.set(repoFullName, zh);
      return zh;
    } catch (err: unknown) {
      this.logger.warn(
        `Translation failed for ${repoFullName}: ${String(err)}`,
      );
      // Fallback: return original English description
      return description;
    }
  }

  // ─── Weibo Hot Search ────────────────────────────────────────

  async getWeiboHotSearch(): Promise<HotlistResponse<WeiboHotItem>> {
    const cacheKey = 'weibo:hot';
    const cached = this.getCached<HotlistResponse<WeiboHotItem>>(
      cacheKey,
    );
    if (cached) return cached;

    try {
      const res = await this.fetchWithTimeout(
        'https://weibo.com/ajax/side/hotSearch',
        {
          headers: {
            'User-Agent': WEIBO_USER_AGENT,
            Referer: 'https://weibo.com/',
            Accept: 'application/json',
          },
        },
      );

      if (!res.ok) {
        throw new Error(
          `Weibo hot search returned ${res.status}`,
        );
      }

      const json = (await res.json()) as {
        data?: { realtime?: WeiboRawItem[] };
      };
      const realtime = json?.data?.realtime;

      if (!Array.isArray(realtime) || realtime.length === 0) {
        throw new Error(
          'Weibo response has no realtime data',
        );
      }

      // Filter out ads and empty items
      const filtered = realtime.filter(
        (item: WeiboRawItem) =>
          !item.is_ad && (item.word || item.note),
      );

      const items: WeiboHotItem[] = filtered.map(
        (item: WeiboRawItem, index: number) => {
          const title = item.word || item.note || '';
          return {
            rank: index + 1,
            title,
            url: `https://s.weibo.com/weibo?q=${encodeURIComponent(
              '#' + title + '#',
            )}`,
            hot: item.num || 0,
            tag: item.label_name || '',
          };
        },
      );

      const now = new Date().toISOString();
      const response: HotlistResponse<WeiboHotItem> = {
        ok: true,
        kind: 'weibo',
        updatedAt: now,
        source: 'live',
        items,
      };

      this.setCache(cacheKey, response);
      await this.saveSnapshot('weibo', items);

      return response;
    } catch (err: unknown) {
      this.logger.warn(
        `Weibo hot search fetch/parse failed: ${String(err)}`,
      );
      return this.fallbackToSnapshot<WeiboHotItem>('weibo');
    }
  }

  // ─── Shared fallback ─────────────────────────────────────────

  private async fallbackToSnapshot<
    T = GithubTrendingItem | WeiboHotItem,
  >(
    kind: 'github' | 'weibo',
  ): Promise<HotlistResponse<T>> {
    const snapshot = await this.loadSnapshot(kind);
    if (snapshot?.unavailable) {
      return {
        ok: false,
        kind,
        updatedAt: snapshot.updatedAt,
        source: 'none',
        reason: 'snapshot_unavailable',
        items: [],
      };
    }
    if (snapshot) {
      return {
        ok: true,
        kind,
        updatedAt: snapshot.updatedAt,
        source: 'snapshot',
        items: snapshot.items as T[],
      };
    }

    return {
      ok: false,
      kind,
      updatedAt: new Date().toISOString(),
      source: 'none',
      reason: 'no_snapshot',
      items: [],
    };
  }
}
