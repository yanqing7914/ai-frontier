import { useState, useEffect, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Empty,
  EmptyHeader,
  EmptyTitle,
  EmptyDescription,
  EmptyMedia,
} from '@/components/ui/empty';
import { Flame, Calendar, ExternalLink, FileText, TrendingUp } from 'lucide-react';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import 'dayjs/locale/zh-cn';
import { toast } from 'sonner';
import { logger } from '@lark-apaas/client-toolkit/logger';
import { getHotArticles } from '@/api/article';
import { DigestDialog } from './TodayHotDigestDialog';
import { TodayHotTrendingDrawer } from './TodayHotTrendingDrawer';
import type { HotArticleItem, Direction } from '@shared/api.interface';
import { UniversalLink } from '@lark-apaas/client-toolkit/components/UniversalLink';

dayjs.extend(relativeTime);
dayjs.locale('zh-cn');

const DIRECTIONS = [
  { key: 'agent', label: '智能体', bg: 'hsl(220,50%,58%)', fg: 'hsl(220,60%,25%)' },
  { key: 'model', label: '模型', bg: 'hsl(265,48%,60%)', fg: 'hsl(265,55%,28%)' },
  { key: 'coding', label: '编程', bg: 'hsl(170,45%,48%)', fg: 'hsl(170,55%,22%)' },
  { key: 'multi', label: '多模态', bg: 'hsl(310,42%,58%)', fg: 'hsl(310,50%,28%)' },
  { key: 'eval', label: '评测', bg: 'hsl(45,55%,52%)', fg: 'hsl(45,65%,25%)' },
  { key: 'infra', label: '基础设施', bg: 'hsl(195,50%,50%)', fg: 'hsl(195,60%,22%)' },
  { key: 'data', label: '数据', bg: 'hsl(130,45%,50%)', fg: 'hsl(130,55%,22%)' },
  { key: 'security', label: '安全', bg: 'hsl(0,48%,58%)', fg: 'hsl(0,58%,28%)' },
] as const;

const TodayHot = () => {
  const [articles, setArticles] = useState<HotArticleItem[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [total, setTotal] = useState<number>(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [digestOpen, setDigestOpen] = useState<boolean>(false);
  const [drawerOpen, setDrawerOpen] = useState<boolean>(false);

  const fetchArticles = useCallback((): void => {
    setLoading(true);
    getHotArticles({ page: 1, pageSize: 50 })
      .then((data) => {
        setArticles(data.items);
        setTotal(data.total);
      })
      .catch((err: unknown) => {
        logger.error(`Failed to fetch hot articles: ${String(err)}`);
        toast.error('获取热点文章失败');
      })
      .finally(() => {
        setLoading(false);
      });
  }, []);

  useEffect(() => {
    fetchArticles();
  }, [fetchArticles]);

  const toggleDirection = useCallback((key: string): void => {
    setSelected((prev: Set<string>) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }, []);

  const filtered = selected.size === 0 || selected.size === DIRECTIONS.length
    ? articles
    : articles.filter((a: HotArticleItem) => selected.has(a.primaryDirection));

  const directionOf = useCallback(
    (dir: Direction) => DIRECTIONS.find((d) => d.key === dir),
    [],
  );

  return (
    <div className="min-h-screen" style={{ backgroundColor: 'hsl(220,20%,97%)' }}>
      <div className="max-w-4xl mx-auto px-4 py-6">
        {/* Status Bar */}
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <Calendar className="size-4 text-muted-foreground" />
            <span className="text-sm text-muted-foreground">
              {dayjs().format('YYYY年MM月DD日')}
            </span>
          </div>
          <div className="flex items-center gap-3">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setDrawerOpen(true)}
            >
              <TrendingUp className="size-4" />
              热榜
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setDigestOpen(true)}
            >
              <FileText className="size-4" />
              查看今日简报
            </Button>
            <Badge variant="secondary" className="rounded-full">
              今日 {total} 条热点
            </Badge>
          </div>
        </div>

        {/* Direction Filter Bar */}
        <div className="flex items-center gap-2 mb-4 overflow-x-auto pb-1">
          {DIRECTIONS.map((dir) => {
            const isSelected = selected.has(dir.key);
            return (
              <button
                key={dir.key}
                type="button"
                onClick={() => toggleDirection(dir.key)}
                className="shrink-0 rounded-full px-3 py-1 text-xs font-medium transition-colors border"
                style={
                  isSelected
                    ? { backgroundColor: dir.bg, color: dir.fg, borderColor: dir.bg }
                    : { backgroundColor: 'transparent', color: 'hsl(220,12%,50%)', borderColor: 'hsl(220,15%,88%)' }
                }
              >
                {dir.label}
              </button>
            );
          })}
        </div>

        {/* Article List */}
        {loading ? (
          <div className="flex items-center justify-center py-20">
            <p className="text-sm text-muted-foreground">加载中...</p>
          </div>
        ) : filtered.length === 0 ? (
          <Empty className="py-20 border-dashed">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Flame className="size-5" />
              </EmptyMedia>
              <EmptyTitle>暂无符合条件的热点内容</EmptyTitle>
              <EmptyDescription>
                尝试调整方向筛选条件或稍后再来查看
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <div className="flex flex-col gap-3">
            {filtered.map((article: HotArticleItem) => {
              const dirConf = directionOf(article.primaryDirection);
              return (
                <div
                  key={article.id}
                  className="bg-white border rounded-sm p-5 flex items-start gap-4"
                  style={{ borderColor: 'hsl(220,15%,88%)' }}
                >
                  {/* Left: Content */}
                  <div className="flex-1 min-w-0">
                    <UniversalLink
                      to={article.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-sm font-semibold text-foreground hover:text-primary transition-colors inline-flex items-center gap-1 group"
                    >
                      <span className="line-clamp-2">{article.title}</span>
                      <ExternalLink className="size-3 opacity-0 group-hover:opacity-100 shrink-0 transition-opacity" />
                    </UniversalLink>

                    <div className="flex items-center gap-2 mt-2">
                      {dirConf && (
                        <span
                          className="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium"
                          style={{
                            backgroundColor: dirConf.bg,
                            color: dirConf.fg,
                          }}
                        >
                          {dirConf.label}
                        </span>
                      )}
                      <span className="text-xs text-muted-foreground">
                        {article.sourceName}
                      </span>
                      {article.clusterCount > 1 && (
                        <Badge variant="outline" className="rounded-full text-[10px] px-1.5 py-0">
                          {article.clusterCount} 家报道
                        </Badge>
                      )}
                    </div>

                    <p className="text-sm text-muted-foreground mt-2 line-clamp-2">
                      {article.summary}
                    </p>

                    <p className="text-xs text-muted-foreground mt-2">
                      {dayjs(article.publishedAt).fromNow()}
                    </p>
                  </div>

                  {/* Right: Score */}
                  <div className="shrink-0 flex flex-col items-center">
                    <span className="font-mono text-3xl font-bold text-primary leading-none">
                      {article.primaryScore}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Daily Digest Dialog */}
      <DigestDialog
        open={digestOpen}
        onOpenChange={setDigestOpen}
        directions={DIRECTIONS}
      />

      <TodayHotTrendingDrawer
        open={drawerOpen}
        onOpenChange={setDrawerOpen}
      />
    </div>
  );
};

export default TodayHot;
