import { useState, useEffect, useCallback } from 'react';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Star, RefreshCw, ExternalLink } from 'lucide-react';
import dayjs from 'dayjs';
import { logger } from '@lark-apaas/client-toolkit/logger';
import { getGithubTrending, getWeiboHotSearch } from '@/api/hotlist';
import type { GithubTrendingItem, WeiboHotItem, HotlistResponse } from '@shared/api.interface';
import { UniversalLink } from '@lark-apaas/client-toolkit/components/UniversalLink';

interface TodayHotTrendingDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type TabKey = 'github' | 'weibo';

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

function formatHotValue(value: number): string {
  if (value >= 10000) {
    return `${(value / 10000).toFixed(1)}万`;
  }
  return String(value);
}

function getLanguageColor(lang: string): string {
  return LANGUAGE_COLORS[lang] ?? 'hsl(220,12%,50%)';
}

const TodayHotTrendingDrawer = ({ open, onOpenChange }: TodayHotTrendingDrawerProps) => {
  const [activeTab, setActiveTab] = useState<TabKey>('github');
  const [githubData, setGithubData] = useState<HotlistResponse<GithubTrendingItem> | null>(null);
  const [weiboData, setWeiboData] = useState<HotlistResponse<WeiboHotItem> | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [github, weibo] = await Promise.all([
        getGithubTrending('daily'),
        getWeiboHotSearch(),
      ]);
      setGithubData(github);
      setWeiboData(weibo);
    } catch (err: unknown) {
      logger.error(`Failed to fetch hotlist: ${String(err)}`);
      setError('获取热榜数据失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open && !githubData && !weiboData) {
      fetchData();
    }
  }, [open, githubData, weiboData, fetchData]);

  const handleRetry = useCallback(() => {
    fetchData();
  }, [fetchData]);

  const currentUpdatedAt = activeTab === 'github' ? githubData?.updatedAt : weiboData?.updatedAt;
  const currentSource = activeTab === 'github' ? githubData?.source : weiboData?.source;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="sm:max-w-md w-full p-0 gap-0">
        <div className="flex flex-col h-full">
          <SheetHeader className="px-6 pt-6 pb-4 border-b" style={{ borderColor: 'hsl(220,15%,88%)' }}>
            <SheetTitle className="text-base">热榜</SheetTitle>
          </SheetHeader>

          <div className="flex items-center gap-1 px-6 pt-4 pb-2">
            <button
              type="button"
              onClick={() => setActiveTab('github')}
              className="px-3 py-1.5 text-sm rounded-sm transition-colors border"
              style={
                activeTab === 'github'
                  ? { backgroundColor: 'hsl(220,75%,45%)', color: 'white', borderColor: 'hsl(220,75%,45%)' }
                  : { backgroundColor: 'transparent', color: 'hsl(220,12%,50%)', borderColor: 'hsl(220,15%,88%)' }
              }
            >
              GitHub Trending
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('weibo')}
              className="px-3 py-1.5 text-sm rounded-sm transition-colors border"
              style={
                activeTab === 'weibo'
                  ? { backgroundColor: 'hsl(220,75%,45%)', color: 'white', borderColor: 'hsl(220,75%,45%)' }
                  : { backgroundColor: 'transparent', color: 'hsl(220,12%,50%)', borderColor: 'hsl(220,15%,88%)' }
              }
            >
              微博热搜
            </button>
          </div>

          <div className="flex items-center justify-between px-6 py-2">
            <div className="flex items-center gap-2">
              {currentUpdatedAt && (
                <span className="text-xs text-muted-foreground">
                  更新于 {dayjs(currentUpdatedAt).format('MM-DD HH:mm')}
                </span>
              )}
              {currentSource === 'snapshot' && (
                <span className="text-xs text-muted-foreground opacity-60">
                  缓存数据
                </span>
              )}
            </div>
          </div>

          <div className="flex-1 overflow-y-auto px-6 pb-6">
            {loading ? (
              <div className="flex flex-col gap-3 pt-2">
                {Array.from({ length: 8 }).map((_: unknown, i: number) => (
                  <div key={i} className="flex items-center gap-3 py-2">
                    <div className="w-6 h-4 rounded-sm" style={{ backgroundColor: 'hsl(220,20%,93%)' }} />
                    <div className="flex-1">
                      <div className="h-4 rounded-sm mb-2" style={{ backgroundColor: 'hsl(220,20%,93%)', width: '70%' }} />
                      <div className="h-3 rounded-sm" style={{ backgroundColor: 'hsl(220,20%,93%)', width: '90%' }} />
                    </div>
                  </div>
                ))}
              </div>
            ) : error ? (
              <div className="flex flex-col items-center justify-center py-12 gap-3">
                <p className="text-sm text-muted-foreground">{error}</p>
                <Button variant="outline" size="sm" onClick={handleRetry}>
                  <RefreshCw className="size-4" />
                  重试
                </Button>
              </div>
            ) : activeTab === 'github' && githubData ? (
              <div className="flex flex-col">
                {githubData.items.map((item: GithubTrendingItem) => (
                  <UniversalLink
                    key={item.rank}
                    to={item.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-start gap-3 py-2 px-3 rounded-sm transition-colors hover:bg-accent group"
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
                          {item.starsToday}
                        </span>
                      </div>
                    </div>
                  </UniversalLink>
                ))}
              </div>
            ) : activeTab === 'weibo' && weiboData ? (
              <div className="flex flex-col">
                {weiboData.items.map((item: WeiboHotItem) => (
                  <UniversalLink
                    key={item.rank}
                    to={item.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-3 py-2 px-3 rounded-sm transition-colors hover:bg-accent group"
                  >
                    <span
                      className="font-mono text-sm w-6 shrink-0 text-right"
                      style={
                        item.rank <= 3
                          ? { color: 'hsl(5,70%,50%)', fontWeight: 700 }
                          : { color: 'hsl(220,12%,50%)' }
                      }
                    >
                      {item.rank}
                    </span>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1">
                        <span className="text-sm font-medium text-foreground truncate group-hover:text-primary transition-colors">
                          {item.title}
                        </span>
                        <ExternalLink className="size-3 opacity-0 group-hover:opacity-100 shrink-0 transition-opacity text-muted-foreground" />
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      {item.tag && (
                        <Badge
                          variant="outline"
                          className="rounded-full text-[10px] px-1.5 py-0 font-medium"
                          style={{ color: 'hsl(5,70%,50%)', borderColor: 'hsl(5,70%,50%)' }}
                        >
                          {item.tag}
                        </Badge>
                      )}
                      <span className="font-mono text-xs text-muted-foreground">
                        {formatHotValue(item.hot)}
                      </span>
                    </div>
                  </UniversalLink>
                ))}
              </div>
            ) : null}
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
};

export { TodayHotTrendingDrawer };
