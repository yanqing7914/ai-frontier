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
import {
  Flame,
  Calendar,
  ExternalLink,
  FileText,
  RefreshCw,
} from 'lucide-react';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import 'dayjs/locale/zh-cn';
import { toast } from 'sonner';
import { logger } from '@/lib/logger';
import { getHotArticles } from '@/api/article';
import { DigestDialog } from './TodayHotDigestDialog';
import type { HotArticleItem, Direction } from '@shared/api.interface';
import { DIRECTIONS as DIRECTION_META } from '@shared/directions';
import { UniversalLink } from '@/components/UniversalLink';

dayjs.extend(relativeTime);
dayjs.locale('zh-cn');

const DIRECTIONS = DIRECTION_META.map(({ id, label, bg, fg }) => ({
  key: id,
  label,
  bg,
  fg,
}));

const TodayHot = () => {
  const [articles, setArticles] = useState<HotArticleItem[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [total, setTotal] = useState<number>(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [digestOpen, setDigestOpen] = useState<boolean>(false);

  const fetchArticles = useCallback((): void => {
    setLoading(true);
    setError(null);
    getHotArticles({ page: 1, pageSize: 50 })
      .then((data) => {
        setArticles(Array.isArray(data.items) ? data.items : []);
        setTotal(Number.isFinite(data.total) ? data.total : 0);
      })
      .catch((err: unknown) => {
        logger.error(`Failed to fetch hot articles: ${String(err)}`);
        setArticles([]);
        setTotal(0);
        setError('热点文章暂时无法加载，请稍后重试');
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

  const filtered =
    selected.size === 0 || selected.size === DIRECTIONS.length
      ? articles
      : articles.filter((a: HotArticleItem) =>
          selected.has(a.primaryDirection),
        );

  const directionOf = useCallback(
    (dir: Direction) => DIRECTIONS.find((d) => d.key === dir),
    [],
  );

  return (
    <div
      className="min-h-screen"
      style={{ backgroundColor: 'hsl(220,20%,97%)' }}
    >
      <div className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-6">
        {/* Status Bar */}
        <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex shrink-0 items-center gap-2">
            <Calendar className="size-4 text-muted-foreground" />
            <span className="text-sm text-muted-foreground">
              {dayjs().format('YYYY年MM月DD日')}
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-2 sm:justify-end">
            <Button
              variant="outline"
              size="sm"
              className="shrink-0"
              onClick={() => setDigestOpen(true)}
            >
              <FileText className="size-4" />
              查看今日简报
            </Button>
            <Badge variant="secondary" className="shrink-0 rounded-full">
              今日 {total} 条热点
            </Badge>
          </div>
        </div>

        {/* Direction Filter Bar */}
        <div className="-mx-1 flex items-center gap-2 overflow-x-auto px-1 pb-2">
          {DIRECTIONS.map((dir) => {
            const isSelected = selected.has(dir.key);
            return (
              <button
                key={dir.key}
                type="button"
                onClick={() => toggleDirection(dir.key)}
                aria-pressed={isSelected}
                className="shrink-0 rounded-full px-3 py-1 text-xs font-medium transition-colors border"
                style={
                  isSelected
                    ? {
                        backgroundColor: dir.bg,
                        color: dir.fg,
                        borderColor: dir.bg,
                      }
                    : {
                        backgroundColor: 'transparent',
                        color: 'hsl(220,12%,50%)',
                        borderColor: 'hsl(220,15%,88%)',
                      }
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
        ) : error ? (
          <Empty className="border-dashed py-20">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Flame className="size-5" />
              </EmptyMedia>
              <EmptyTitle>无法加载今日热点</EmptyTitle>
              <EmptyDescription>{error}</EmptyDescription>
              <Button variant="outline" size="sm" onClick={fetchArticles}>
                <RefreshCw className="size-4" />
                重试
              </Button>
            </EmptyHeader>
          </Empty>
        ) : filtered.length === 0 ? (
          <Empty className="min-h-[360px] border-dashed bg-white/70 py-16">
            <EmptyHeader className="max-w-md">
              <EmptyMedia variant="icon" className="mb-2 size-12 rounded-2xl bg-primary/10 text-primary">
                <Flame className="size-6" />
              </EmptyMedia>
              <EmptyTitle className="text-base">
                {articles.length === 0 ? '今天还没有可展示的热点' : '当前筛选下暂无热点'}
              </EmptyTitle>
              <EmptyDescription className="text-sm leading-6">
                {articles.length === 0
                  ? '采集内容会经过分类、评分和质量门禁后发布；你可以稍后刷新查看。'
                  : '已加载热点，但当前方向筛选没有匹配项；可以清除筛选或换一个方向。'}
              </EmptyDescription>
              <div className="mt-3 flex flex-wrap justify-center gap-2">
                {articles.length > 0 && filtered.length === 0 && (
                  <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())}>
                    清除筛选
                  </Button>
                )}
                <Button variant="outline" size="sm" onClick={fetchArticles}>
                  <RefreshCw className="size-4" />
                  刷新热点
                </Button>
              </div>
            </EmptyHeader>
          </Empty>
        ) : (
          <div className="flex flex-col gap-4">
            {filtered.map((article: HotArticleItem) => {
              const dirConf = directionOf(article.primaryDirection);
              // Keep the preview compatible with articles written before the
              // editorial presentation fields were added to the API.
              const articleLink = article.originalUrl || article.url;
              const readableTitle = article.displayTitle || article.title;
              const readableSummary = article.summary?.trim() || '原文暂未提供可读摘要，请查看原文。';
              return (
                <div
                  key={article.id}
                  className="group flex items-start gap-4 rounded-xl border bg-white p-4 shadow-sm transition-shadow hover:shadow-md sm:p-5"
                  style={{ borderColor: 'hsl(220,15%,88%)' }}
                >
                  {/* Left: Content */}
                  <div className="flex-1 min-w-0">
                    <UniversalLink
                      to={articleLink}
                      target="_blank"
                      rel="noopener noreferrer"
                      title={`原始标题：${article.title}`}
                      aria-label={`打开原文：${readableTitle}`}
                      className="inline-flex max-w-full items-start gap-1.5 text-[15px] font-semibold leading-6 text-foreground underline-offset-4 transition-colors hover:text-primary hover:underline"
                    >
                      <span className="line-clamp-2 break-words">{readableTitle}</span>
                      <ExternalLink className="mt-1 size-3.5 shrink-0 text-primary/70 transition-colors group-hover:text-primary" />
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
                        <Badge
                          variant="outline"
                          className="rounded-full text-[10px] px-1.5 py-0"
                        >
                          {article.clusterCount} 家报道
                        </Badge>
                      )}
                    </div>

                    <div className="mt-3 border-l-2 border-primary/25 pl-3">
                      <p className="mb-1 text-[11px] font-medium tracking-wide text-primary">
                        这条信息说明什么
                      </p>
                      <p className="line-clamp-3 text-sm leading-6 text-muted-foreground">
                        {readableSummary}
                      </p>
                    </div>

                    <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                      <span>{dayjs(article.publishedAt).fromNow()}</span>
                      <UniversalLink
                        to={articleLink}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="font-medium text-primary hover:underline"
                      >
                        查看原文
                      </UniversalLink>
                    </div>
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
    </div>
  );
};

export default TodayHot;
