import { useState, useEffect, useCallback } from 'react';
import { Star, ExternalLink } from 'lucide-react';
import dayjs from 'dayjs';
import { logger } from '@/lib/logger';
import { getGithubTrending } from '@/api/hotlist';
import type { GithubTrendingItem, HotlistResponse } from '@shared/api.interface';
import { UniversalLink } from '@/components/UniversalLink';

const LANGUAGE_COLORS: Record<string, string> = {
  TypeScript: 'hsl(220,75%,45%)',
  JavaScript: 'hsl(45,55%,52%)',
  Python: 'hsl(195,50%,50%)',
  Rust: 'hsl(5,70%,50%)',
  Go: 'hsl(170,45%,48%)',
  Java: 'hsl(35,85%,45%)',
  'C++': 'hsl(265,48%,60%)',
  C: 'hsl(220,50%,58%)',
  Swift: 'hsl(0,48%,58%)',
  Kotlin: 'hsl(310,42%,58%)',
};

function getLanguageColor(lang: string): string {
  return LANGUAGE_COLORS[lang] ?? 'hsl(220,12%,50%)';
}

interface GithubTrendingCardProps {
  forceRefresh: number;
  onDataLoaded?: (data: HotlistResponse<GithubTrendingItem> | null) => void;
}

const GithubTrendingCard = ({ forceRefresh, onDataLoaded }: GithubTrendingCardProps) => {
  const [since, setSince] = useState<'daily' | 'weekly'>('daily');
  const [data, setData] = useState<HotlistResponse<GithubTrendingItem> | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async (s: 'daily' | 'weekly', force: boolean) => {
    setLoading(true);
    setError(null);
    try {
      const result = await getGithubTrending(s, force);
      setData(result);
      if (!result.ok || result.source === 'none') {
        setError(result.reason === 'no_snapshot' ? '数据源不可用，当前没有可用快照' : '数据源暂时不可用，请稍后重试');
      }
      onDataLoaded?.(result);
    } catch (err: unknown) {
      logger.error(`Failed to fetch GitHub trending: ${String(err)}`);
      setError('获取 GitHub Trending 失败');
    } finally {
      setLoading(false);
    }
  }, [onDataLoaded]);

  useEffect(() => {
    fetchData(since, false);
  }, [since, fetchData]);

  useEffect(() => {
    if (forceRefresh > 0) {
      fetchData(since, true);
    }
  }, [forceRefresh, since, fetchData]);

  const handleToggle = (s: 'daily' | 'weekly') => {
    setSince(s);
  };

  return (
    <div
      className="bg-white border rounded-sm flex flex-col"
      style={{ borderColor: 'hsl(220,15%,88%)' }}
    >
      {/* Header */}
      <div className="px-5 pt-5 pb-3 border-b" style={{ borderColor: 'hsl(220,15%,88%)' }}>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-foreground">GitHub Trending</h2>
          <div className="flex items-center gap-2">
            {data?.updatedAt && (
              <span className="text-xs text-muted-foreground">
                {dayjs(data.updatedAt).format('MM-DD HH:mm')}
              </span>
            )}
            {data?.source === 'snapshot' && (
              <span
                className="text-[10px] px-1.5 py-0.5 rounded-sm border"
                style={{
                  color: 'hsl(35,85%,45%)',
                  borderColor: 'hsl(35,85%,45%)',
                }}
              >
                缓存
              </span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-1">
          {(['daily', 'weekly'] as const).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => handleToggle(s)}
              className="px-3 py-1 text-xs rounded-sm transition-colors border"
              style={
                since === s
                  ? { backgroundColor: 'hsl(220,75%,45%)', color: 'white', borderColor: 'hsl(220,75%,45%)' }
                  : { backgroundColor: 'transparent', color: 'hsl(220,12%,50%)', borderColor: 'hsl(220,15%,88%)' }
              }
            >
              {s === 'daily' ? 'Today' : 'This Week'}
            </button>
          ))}
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-5 py-3">
        {loading ? (
          <div className="flex flex-col gap-3">
            {Array.from({ length: 8 }).map((_: unknown, i: number) => (
              <div key={i} className="flex items-start gap-3 py-2">
                <div className="w-6 h-4 rounded-sm shrink-0 mt-0.5" style={{ backgroundColor: 'hsl(220,20%,93%)' }} />
                <div className="flex-1">
                  <div className="h-4 rounded-sm mb-2" style={{ backgroundColor: 'hsl(220,20%,93%)', width: '60%' }} />
                  <div className="h-3 rounded-sm" style={{ backgroundColor: 'hsl(220,20%,93%)', width: '85%' }} />
                </div>
              </div>
            ))}
          </div>
        ) : error ? (
          <div className="flex flex-col items-center justify-center py-12">
            <p className="text-sm text-muted-foreground">{error}</p>
          </div>
        ) : data && data.ok && data.source !== 'none' && data.items.length > 0 ? (
          <div className="flex flex-col">
            {data.items.map((item: GithubTrendingItem) => (
              <UniversalLink
                key={item.rank}
                to={item.url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-start gap-3 py-2.5 px-2 rounded-sm transition-colors hover:bg-accent group"
              >
                <span
                  className="font-mono text-sm w-6 shrink-0 text-right pt-0.5"
                  style={
                    item.rank <= 3
                      ? { color: 'hsl(220,75%,45%)', fontWeight: 700 }
                      : { color: 'hsl(220,12%,50%)' }
                  }
                >
                  {item.rank}
                </span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1">
                    <span className="text-sm font-medium text-foreground truncate group-hover:text-primary transition-colors">
                      {item.repo}
                    </span>
                    <ExternalLink className="size-3 opacity-0 group-hover:opacity-100 shrink-0 transition-opacity text-muted-foreground" />
                  </div>
                  <p className="text-xs text-muted-foreground mt-1 line-clamp-2">
                    {item.descriptionZh || item.description}
                  </p>
                  <div className="flex items-center gap-3 mt-1.5">
                    {item.language && (
                      <span className="flex items-center gap-1 text-xs text-muted-foreground">
                        <span
                          className="w-2 h-2 rounded-full shrink-0"
                          style={{ backgroundColor: getLanguageColor(item.language) }}
                        />
                        {item.language}
                      </span>
                    )}
                    <span className="flex items-center gap-1 text-xs font-mono text-muted-foreground">
                      <Star className="size-3" />
                      +{item.starsToday}
                    </span>
                    <span className="flex items-center gap-1 text-xs font-mono text-muted-foreground">
                      <Star className="size-3" />
                      {item.stars >= 1000
                        ? `${(item.stars / 1000).toFixed(1)}k`
                        : item.stars}
                    </span>
                  </div>
                </div>
              </UniversalLink>
            ))}
          </div>
        ) : data && (!data.ok || data.source === 'none') ? (
          <div className="flex flex-col items-center justify-center py-12">
            <p className="text-sm text-muted-foreground">{error ?? '数据源不可用，请稍后重试'}</p>
          </div>
        ) : (
          <div className="flex items-center justify-center py-12">
            <p className="text-sm text-muted-foreground">暂无数据</p>
          </div>
        )}
      </div>
    </div>
  );
};

export default GithubTrendingCard;
