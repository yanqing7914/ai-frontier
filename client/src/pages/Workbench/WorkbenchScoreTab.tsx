import { useState, useEffect, useCallback, Fragment } from 'react';
import { Badge } from '@client/src/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@client/src/components/ui/select';
import { Empty, EmptyTitle, EmptyDescription } from '@client/src/components/ui/empty';
import { getWorkbenchArticles, getArticleScores } from '@client/src/api/article';
import { logger } from '@lark-apaas/client-toolkit/logger';
import { toast } from 'sonner';
import dayjs from 'dayjs';
import { ChevronDown, ChevronRight } from 'lucide-react';
import type {
  WorkbenchArticleItem,
  DirectionScoreItem,
  ArticleStatus,
  Direction,
} from '@shared/api.interface';

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

const DIMENSION_LABELS: Record<string, string> = {
  novelty: '新颖度',
  depth: '深度',
  impact: '影响力',
  authority: '权威性',
  timeliness: '时效性',
};

const STATUS_MAP: Record<ArticleStatus, { label: string; className: string }> = {
  published: { label: '已发布', className: 'bg-[hsl(150_60%_40%)] text-white border-transparent' },
  draft: { label: '草稿', className: 'bg-muted text-muted-foreground border-transparent' },
  blocked: { label: '已拦截', className: 'bg-[hsl(5_70%_50%)] text-white border-transparent' },
  pending_review: { label: '待审核', className: 'bg-[hsl(35_85%_55%)] text-white border-transparent' },
};

function getDirectionConfig(key: Direction) {
  return DIRECTIONS.find((d) => d.key === key);
}

interface ScorePanelProps {
  articleId: string;
}

function ScorePanel({ articleId }: ScorePanelProps) {
  const [scores, setScores] = useState<DirectionScoreItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getArticleScores(articleId)
      .then((data: { items: DirectionScoreItem[] }) => {
        if (!cancelled) setScores(data.items);
      })
      .catch((err: unknown) => {
        logger.error(`Failed to load scores: ${String(err)}`);
        if (!cancelled) toast.error('加载打分明细失败');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [articleId]);

  if (loading) {
    return (
      <div className="py-6 text-center text-sm text-muted-foreground">
        加载中...
      </div>
    );
  }

  if (scores.length === 0) {
    return (
      <div className="py-6 text-center text-sm text-muted-foreground">
        暂无打分数据
      </div>
    );
  }

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3 p-4">
      {scores.map((score: DirectionScoreItem) => {
        const dir = getDirectionConfig(score.direction);
        return (
          <div
            key={score.direction}
            className="rounded-sm border border-border p-3"
          >
            <div className="flex items-center justify-between mb-2">
              {dir && (
                <span
                  className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium"
                  style={{ backgroundColor: dir.bg, color: dir.fg }}
                >
                  {dir.label}
                </span>
              )}
              <span className="font-mono text-lg font-bold text-primary">
                {score.totalScore}
              </span>
            </div>
            <div className="space-y-1.5">
              {Object.entries(score.dimensionScores).map(
                ([key, value]: [string, number]) => (
                  <div key={key} className="flex items-center gap-2">
                    <span className="text-xs text-muted-foreground w-12 shrink-0">
                      {DIMENSION_LABELS[key] ?? key}
                    </span>
                    <span className="font-mono text-xs w-5 text-right shrink-0">
                      {value}
                    </span>
                    <div className="flex-1 h-1.5 bg-accent rounded-full overflow-hidden">
                      <div
                        className="h-full bg-primary rounded-full"
                        style={{ width: `${(value / 20) * 100}%` }}
                      />
                    </div>
                  </div>
                )
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

const WorkbenchScoreTab = () => {
  const [articles, setArticles] = useState<WorkbenchArticleItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [dirFilter, setDirFilter] = useState<string>('all');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const fetchArticles = useCallback(() => {
    setLoading(true);
    const params: Record<string, string> = {};
    if (dirFilter !== 'all') params.direction = dirFilter;
    if (statusFilter !== 'all') params.status = statusFilter;
    getWorkbenchArticles(params)
      .then((data: { items: WorkbenchArticleItem[] }) => setArticles(data.items))
      .catch((err: unknown) => {
        logger.error(`Failed to load articles: ${String(err)}`);
        toast.error('加载文章列表失败');
      })
      .finally(() => setLoading(false));
  }, [dirFilter, statusFilter]);

  useEffect(() => {
    fetchArticles();
  }, [fetchArticles]);

  const handleRowClick = (id: string) => {
    setExpandedId(expandedId === id ? null : id);
  };

  return (
    <div>
      <div className="flex items-center gap-3 mb-4">
        <Select value={dirFilter} onValueChange={(v: string) => setDirFilter(v)}>
          <SelectTrigger>
            <SelectValue placeholder="方向" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部方向</SelectItem>
            {DIRECTIONS.map((d) => (
              <SelectItem key={d.key} value={d.key}>
                {d.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={statusFilter} onValueChange={(v: string) => setStatusFilter(v)}>
          <SelectTrigger>
            <SelectValue placeholder="状态" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部状态</SelectItem>
            <SelectItem value="published">已发布</SelectItem>
            <SelectItem value="draft">草稿</SelectItem>
            <SelectItem value="blocked">已拦截</SelectItem>
            <SelectItem value="pending_review">待审核</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {loading ? (
        <div className="py-12 text-center text-sm text-muted-foreground">
          加载中...
        </div>
      ) : articles.length === 0 ? (
        <Empty>
          <EmptyTitle>暂无数据</EmptyTitle>
          <EmptyDescription>当前筛选条件下没有文章</EmptyDescription>
        </Empty>
      ) : (
        <div className="rounded-sm border border-border overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-accent/30">
                <th className="text-left py-3 px-4 font-medium text-muted-foreground w-8" />
                <th className="text-left py-3 px-4 font-medium text-muted-foreground">标题</th>
                <th className="text-left py-3 px-4 font-medium text-muted-foreground">主方向</th>
                <th className="text-left py-3 px-4 font-medium text-muted-foreground">总分</th>
                <th className="text-left py-3 px-4 font-medium text-muted-foreground">状态</th>
                <th className="text-left py-3 px-4 font-medium text-muted-foreground">AI</th>
                <th className="text-left py-3 px-4 font-medium text-muted-foreground">采集时间</th>
              </tr>
            </thead>
            <tbody>
              {articles.map((article: WorkbenchArticleItem) => {
                const dir = article.primaryDirection
                  ? getDirectionConfig(article.primaryDirection)
                  : null;
                const statusCfg = STATUS_MAP[article.status];
                const isExpanded = expandedId === article.id;
                return (
                  <Fragment key={article.id}>
                    <tr
                      className="border-b border-border hover:bg-accent/50 cursor-pointer"
                      onClick={() => handleRowClick(article.id)}
                    >
                      <td className="py-3 px-4">
                        {isExpanded ? (
                          <ChevronDown className="size-4 text-muted-foreground" />
                        ) : (
                          <ChevronRight className="size-4 text-muted-foreground" />
                        )}
                      </td>
                      <td className="py-3 px-4 truncate max-w-[240px]">
                        {article.title}
                      </td>
                      <td className="py-3 px-4">
                        {dir ? (
                          <span
                            className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium"
                            style={{ backgroundColor: dir.bg, color: dir.fg }}
                          >
                            {dir.label}
                          </span>
                        ) : (
                          <span className="text-muted-foreground">-</span>
                        )}
                      </td>
                      <td className="py-3 px-4 font-mono">
                        {article.primaryScore ?? '-'}
                      </td>
                      <td className="py-3 px-4">
                        <Badge className={statusCfg.className}>
                          {statusCfg.label}
                        </Badge>
                      </td>
                      <td className="py-3 px-4">
                        <Badge
                          variant={article.aiProcessed ? 'default' : 'secondary'}
                        >
                          {article.aiProcessed ? '已处理' : '未处理'}
                        </Badge>
                      </td>
                      <td className="py-3 px-4 text-muted-foreground">
                        {dayjs(article.collectedAt).format('MM-DD HH:mm')}
                      </td>
                    </tr>
                    {isExpanded && (
                      <tr>
                        <td colSpan={7} className="bg-accent/10">
                          <ScorePanel articleId={article.id} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};

export default WorkbenchScoreTab;
