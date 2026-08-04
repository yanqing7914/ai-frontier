import { useState, useEffect, useCallback } from 'react';
import { Badge } from '@/components/ui/badge';
import { ExternalLink } from 'lucide-react';
import dayjs from 'dayjs';
import { logger } from '@lark-apaas/client-toolkit/logger';
import { getWeiboHotSearch } from '@/api/hotlist';
import type { WeiboHotItem, HotlistResponse } from '@shared/api.interface';
import { UniversalLink } from '@lark-apaas/client-toolkit/components/UniversalLink';

function formatHotValue(value: number): string {
  if (value >= 10000) {
    return `${(value / 10000).toFixed(1)}万`;
  }
  return String(value);
}

interface WeiboHotCardProps {
  forceRefresh: number;
  onDataLoaded?: (data: HotlistResponse<WeiboHotItem> | null) => void;
}

const WeiboHotCard = ({ forceRefresh, onDataLoaded }: WeiboHotCardProps) => {
  const [data, setData] = useState<HotlistResponse<WeiboHotItem> | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async (force: boolean) => {
    setLoading(true);
    setError(null);
    try {
      const result = await getWeiboHotSearch(force);
      setData(result);
      onDataLoaded?.(result);
    } catch (err: unknown) {
      logger.error(`Failed to fetch Weibo hot search: ${String(err)}`);
      setError('获取微博热搜失败');
    } finally {
      setLoading(false);
    }
  }, [onDataLoaded]);

  useEffect(() => {
    fetchData(false);
  }, [fetchData]);

  useEffect(() => {
    if (forceRefresh > 0) {
      fetchData(true);
    }
  }, [forceRefresh, fetchData]);

  return (
    <div
      className="bg-white border rounded-sm flex flex-col"
      style={{ borderColor: 'hsl(220,15%,88%)' }}
    >
      {/* Header */}
      <div className="px-5 pt-5 pb-3 border-b" style={{ borderColor: 'hsl(220,15%,88%)' }}>
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-foreground">微博热搜</h2>
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
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-5 py-3">
        {loading ? (
          <div className="flex flex-col gap-3">
            {Array.from({ length: 8 }).map((_: unknown, i: number) => (
              <div key={i} className="flex items-center gap-3 py-2">
                <div className="w-6 h-4 rounded-sm shrink-0" style={{ backgroundColor: 'hsl(220,20%,93%)' }} />
                <div className="flex-1">
                  <div className="h-4 rounded-sm" style={{ backgroundColor: 'hsl(220,20%,93%)', width: '70%' }} />
                </div>
              </div>
            ))}
          </div>
        ) : error ? (
          <div className="flex flex-col items-center justify-center py-12">
            <p className="text-sm text-muted-foreground">{error}</p>
          </div>
        ) : data && data.items.length > 0 ? (
          <div className="flex flex-col">
            {data.items.map((item: WeiboHotItem) => (
              <UniversalLink
                key={item.rank}
                to={item.url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-3 py-2.5 px-2 rounded-sm transition-colors hover:bg-accent group"
              >
                <span
                  className="font-mono text-sm w-6 shrink-0 text-right"
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
        ) : (
          <div className="flex items-center justify-center py-12">
            <p className="text-sm text-muted-foreground">暂无数据</p>
          </div>
        )}
      </div>
    </div>
  );
};

export default WeiboHotCard;
