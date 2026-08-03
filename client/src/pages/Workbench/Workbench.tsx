import { useState, useEffect } from 'react';
import { Badge } from '@client/src/components/ui/badge';
import { getWorkbenchOverview } from '@client/src/api/article';
import { logger } from '@lark-apaas/client-toolkit/logger';
import { toast } from 'sonner';
import {
  Newspaper,
  CheckCircle2,
  FileText,
  Clock,
  Cpu,
} from 'lucide-react';
import type { WorkbenchOverview } from '@shared/api.interface';
import WorkbenchScoreTab from './WorkbenchScoreTab';
import WorkbenchTraceTab from './WorkbenchTraceTab';
import WorkbenchQualityTab from './WorkbenchQualityTab';
import WorkbenchReviewTab from './WorkbenchReviewTab';

type TabKey = 'scores' | 'trace' | 'quality' | 'review';

interface TabDef {
  key: TabKey;
  label: string;
}

const TABS: TabDef[] = [
  { key: 'scores', label: '打分明细' },
  { key: 'trace', label: '溯源链路' },
  { key: 'quality', label: '质量门禁' },
  { key: 'review', label: '审核队列' },
];

interface StatCardProps {
  label: string;
  value: string | number;
  icon: React.ReactNode;
  badge?: React.ReactNode;
}

function StatCard({ label, value, icon, badge }: StatCardProps) {
  return (
    <div className="flex items-center gap-3 rounded-sm border border-border bg-card px-4 py-3">
      <div className="text-muted-foreground shrink-0">{icon}</div>
      <div className="flex flex-col min-w-0">
        <span className="text-xs text-muted-foreground">{label}</span>
        <div className="flex items-center gap-2">
          <span className="font-mono text-lg font-bold text-foreground">
            {value}
          </span>
          {badge}
        </div>
      </div>
    </div>
  );
}

interface OverviewBarProps {
  overview: WorkbenchOverview;
}

function OverviewBar({ overview }: OverviewBarProps) {
  return (
    <div className="flex flex-wrap gap-3">
      <StatCard
        label="今日采集"
        value={overview.totalCollected}
        icon={<Newspaper className="size-4" />}
      />
      <StatCard
        label="已发布"
        value={overview.publishedCount}
        icon={<CheckCircle2 className="size-4" />}
        badge={
          <Badge className="bg-[hsl(150_60%_40%)] text-white border-transparent">
            已发布
          </Badge>
        }
      />
      <StatCard
        label="草稿"
        value={overview.draftCount}
        icon={<FileText className="size-4" />}
        badge={
          <Badge variant="secondary">草稿</Badge>
        }
      />
      <StatCard
        label="待审核"
        value={overview.pendingReviewCount}
        icon={<Clock className="size-4" />}
        badge={
          overview.pendingReviewCount > 0 ? (
            <Badge className="bg-[hsl(35_85%_55%)] text-white border-transparent">
              待审核
            </Badge>
          ) : undefined
        }
      />
      <StatCard
        label="AI 调用"
        value={`${overview.aiCallsToday} / ${overview.aiDailyLimit}`}
        icon={<Cpu className="size-4" />}
        badge={
          overview.aiDegraded ? (
            <Badge className="bg-[hsl(5_70%_50%)] text-white border-transparent">
              AI 已降级
            </Badge>
          ) : undefined
        }
      />
    </div>
  );
}

const TAB_CONTENT: Record<TabKey, React.ReactNode> = {
  scores: <WorkbenchScoreTab />,
  trace: <WorkbenchTraceTab />,
  quality: <WorkbenchQualityTab />,
  review: <WorkbenchReviewTab />,
};

const Workbench = () => {
  const [overview, setOverview] = useState<WorkbenchOverview | null>(null);
  const [overviewLoading, setOverviewLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<TabKey>('scores');

  useEffect(() => {
    getWorkbenchOverview()
      .then((data: WorkbenchOverview) => setOverview(data))
      .catch((err: unknown) => {
        logger.error(`Failed to load overview: ${String(err)}`);
        toast.error('加载概览数据失败');
      })
      .finally(() => setOverviewLoading(false));
  }, []);

  return (
    <div className="mx-auto max-w-6xl px-6 py-6">
      {/* Overview Bar */}
      <div className="mb-6">
        <h1 className="text-lg font-semibold text-foreground mb-4">
          运营工作台
        </h1>
        {overviewLoading ? (
          <div className="flex flex-wrap gap-3">
            {[1, 2, 3, 4, 5].map((i: number) => (
              <div
                key={i}
                className="h-16 w-40 rounded-sm border border-border bg-accent/30 animate-pulse"
              />
            ))}
          </div>
        ) : overview ? (
          <OverviewBar overview={overview} />
        ) : null}
      </div>

      {/* Tab Navigation */}
      <div className="flex border-b border-border mb-5">
        {TABS.map((tab: TabDef) => (
          <button
            key={tab.key}
            type="button"
            className={`relative px-4 py-2.5 text-sm font-medium transition-colors ${
              activeTab === tab.key
                ? 'text-primary'
                : 'text-muted-foreground hover:text-foreground'
            }`}
            onClick={() => setActiveTab(tab.key)}
          >
            {tab.label}
            {tab.key === 'review' && overview && overview.pendingReviewCount > 0 && (
              <span className="ml-1.5 inline-flex items-center justify-center rounded-full bg-[hsl(35_85%_55%)] px-1.5 py-0.5 text-[10px] font-bold text-white leading-none">
                {overview.pendingReviewCount}
              </span>
            )}
            {activeTab === tab.key && (
              <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-primary rounded-full" />
            )}
          </button>
        ))}
      </div>

      {/* Tab Content */}
      <div>{TAB_CONTENT[activeTab]}</div>
    </div>
  );
};

export default Workbench;
