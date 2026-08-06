import { useState, useEffect, useCallback, Fragment } from 'react';
import { Badge } from '@client/src/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@client/src/components/ui/select';
import {
  Empty,
  EmptyTitle,
  EmptyDescription,
} from '@client/src/components/ui/empty';
import {
  getWorkbenchArticles,
  getArticleScores,
} from '@client/src/api/article';
import { logger } from '@lark-apaas/client-toolkit/logger';
import { toast } from 'sonner';
import dayjs from 'dayjs';
import { ChevronDown, ChevronRight, AlertTriangle } from 'lucide-react';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@client/src/components/ui/tooltip';
import type {
  WorkbenchArticleItem,
  DirectionScoreItem,
  ArticleStatus,
  Direction,
  ExcludeReason,
} from '@shared/api.interface';
import {
  DIMENSION_FULL,
  DIRECTIONS as DIRECTION_META,
} from '@shared/directions';

const DIRECTIONS = DIRECTION_META.map(({ id, label, bg, fg }) => ({
  key: id,
  label,
  bg,
  fg,
}));

const LEGACY_DIMENSIONS = new Set([
  'novelty',
  'depth',
  'impact',
  'authority',
  'timeliness',
]);

const DIMENSION_LABELS: Record<string, string> = {
  novelty: '新颖度',
  depth: '深度',
  impact: '影响力',
  authority: '权威性',
  timeliness: '时效性',
  entity: '实体识别',
  capability: '能力变化',
  availability: '可用性',
  performance: '性能质量',
  cost: '成本效率',
  ecosystem: '生态兼容',
  adoption: '采用影响',
  task_boundary: '任务边界',
  tool_call: '工具调用',
  protocol: '协议生态',
  orchestration: '多步编排',
  observability: '可观测性',
  production: '生产控制',
  benchmark: '评测效果',
  workflow: '企业工作流',
  modality_coverage: '模态覆盖',
  io_capability: '输入输出',
  quality: '生成质量',
  realtime: '实时交互',
  editing: '编辑控制',
  '3d_world': '3D/世界模型',
  safety_copyright: '安全版权',
  product: '产品落地',
  code_gen: '代码生成',
  repo_understanding: '仓库理解',
  engineering: '工程执行',
  ide_integration: 'IDE集成',
  delivery: '交付质量',
  cost_speed: '成本速度',
  security: '安全权限',
  hardware: '算力硬件',
  training: '训练能力',
  software_stack: '软件栈',
  cloud: '云/数据中心',
  edge: '端侧',
  ops: '稳定运维',
  data_asset: '数据资产',
  coverage: '覆盖范围',
  methodology: '方法指标',
  reproducibility: '可复现性',
  governance: '许可治理',
  decision_value: '决策价值',
  risk_type: '风险类型',
  controls: '控制措施',
  verification: '风险验证',
  privacy: '隐私保护',
  copyright: '版权问题',
  regulation: '法规政策',
  framework: '治理框架',
  deployment_impact: '部署影响',
  industry: '行业用户',
  business_problem: '业务问题',
  launch_status: '上线状态',
  scale: '使用规模',
  roi: '效果/ROI',
  workflow_change: '工作流改造',
  replicability: '可复制性',
  risk_responsibility: '风险责任',
  business_fact: '商业事实',
  entity_market: '市场位置',
  strategy: '战略变化',
  business_model: '商业模式',
  market_landscape: '市场格局',
  open_source: '开源社区',
  talent: '人才组织',
  signal: '商业信号',
};

const STATUS_MAP: Record<ArticleStatus, { label: string; className: string }> =
  {
    published: {
      label: '已发布',
      className: 'bg-[hsl(150_60%_40%)] text-white border-transparent',
    },
    draft: {
      label: '草稿',
      className: 'bg-muted text-muted-foreground border-transparent',
    },
    blocked: {
      label: '已拦截',
      className: 'bg-[hsl(5_70%_50%)] text-white border-transparent',
    },
    pending_review: {
      label: '待审核',
      className: 'bg-[hsl(35_85%_55%)] text-white border-transparent',
    },
  };

const EXCLUDE_REASON_MAP: Record<ExcludeReason, string> = {
  source_cap: '源配额满',
  direction_cap: '方向配额满',
  limit_reached: '名额已满',
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
                        style={{
                          width: `${Math.min(
                            100,
                            (value /
                              (LEGACY_DIMENSIONS.has(key)
                                ? 20
                                : DIMENSION_FULL)) *
                              100,
                          )}%`,
                        }}
                      />
                    </div>
                  </div>
                ),
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
      .then((data: { items: WorkbenchArticleItem[] }) =>
        setArticles(data.items),
      )
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
        <Select
          value={dirFilter}
          onValueChange={(v: string) => setDirFilter(v)}
        >
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
        <Select
          value={statusFilter}
          onValueChange={(v: string) => setStatusFilter(v)}
        >
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
                <th className="text-left py-3 px-4 font-medium text-muted-foreground">
                  标题
                </th>
                <th className="text-left py-3 px-4 font-medium text-muted-foreground">
                  主方向
                </th>
                <th className="text-left py-3 px-4 font-medium text-muted-foreground">
                  总分
                </th>
                <th className="text-left py-3 px-4 font-medium text-muted-foreground">
                  状态
                </th>
                <th className="text-left py-3 px-4 font-medium text-muted-foreground">
                  首页
                </th>
                <th className="text-left py-3 px-4 font-medium text-muted-foreground">
                  AI
                </th>
                <th className="text-left py-3 px-4 font-medium text-muted-foreground">
                  采集时间
                </th>
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
                        {article.status === 'published' &&
                        !article.excludeReason ? (
                          <Badge className="bg-[hsl(220_75%_45%)] text-white border-transparent text-[10px]">
                            首页
                          </Badge>
                        ) : article.excludeReason ? (
                          <Badge
                            variant="outline"
                            className="text-[10px] border-[hsl(35_85%_45%)] text-[hsl(35_85%_45%)]"
                          >
                            {EXCLUDE_REASON_MAP[article.excludeReason]}
                          </Badge>
                        ) : (
                          <span className="text-muted-foreground text-xs">
                            -
                          </span>
                        )}
                      </td>
                      <td className="py-3 px-4">
                        {article.aiProcessed ? (
                          <Badge variant="default">AI 精选</Badge>
                        ) : !article.aiDegradeReason ? (
                          <Badge
                            variant="outline"
                            className="border-muted-foreground/40 text-muted-foreground"
                          >
                            规则评分
                          </Badge>
                        ) : (
                          <TooltipProvider>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Badge
                                  variant="secondary"
                                  className="gap-1 cursor-help"
                                >
                                  <AlertTriangle className="size-3" />
                                  AI 降级
                                </Badge>
                              </TooltipTrigger>
                              {article.aiDegradeReason && (
                                <TooltipContent
                                  side="bottom"
                                  className="max-w-xs text-xs"
                                >
                                  <p className="font-medium mb-1">降级原因：</p>
                                  <p className="whitespace-pre-wrap break-words">
                                    {article.aiDegradeReason}
                                  </p>
                                </TooltipContent>
                              )}
                            </Tooltip>
                          </TooltipProvider>
                        )}
                      </td>
                      <td className="py-3 px-4 text-muted-foreground">
                        {dayjs(article.collectedAt).format('MM-DD HH:mm')}
                      </td>
                    </tr>
                    {isExpanded && (
                      <tr>
                        <td colSpan={8} className="bg-accent/10">
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
