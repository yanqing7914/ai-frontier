import { useState, useEffect, useCallback } from 'react';
import { Badge } from '@client/src/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@client/src/components/ui/select';
import { Empty, EmptyTitle, EmptyDescription } from '@client/src/components/ui/empty';
import { getQualityGates } from '@client/src/api/article';
import { logger } from '@/lib/logger';
import { toast } from 'sonner';
import dayjs from 'dayjs';
import type { QualityGateItem, QualityGateReason } from '@shared/api.interface';

const REASON_MAP: Record<QualityGateReason, { label: string; className: string }> = {
  link_dead: {
    label: '链接失效',
    className: 'bg-[hsl(5_70%_50%)] text-white border-transparent',
  },
  content_stale: {
    label: '内容陈旧',
    className: 'bg-[hsl(35_85%_55%)] text-white border-transparent',
  },
  untraceable: {
    label: '无法溯源',
    className: 'bg-[hsl(220_12%_50%)] text-white border-transparent',
  },
  same_url: {
    label: 'URL重复',
    className: 'bg-[hsl(45_55%_52%)] text-white border-transparent',
  },
  same_title: {
    label: '标题重复',
    className: 'bg-[hsl(45_55%_52%)] text-white border-transparent',
  },
  same_batch_url: {
    label: '批次URL重复',
    className: 'bg-[hsl(195_50%_50%)] text-white border-transparent',
  },
  same_batch_title: {
    label: '批次标题重复',
    className: 'bg-[hsl(195_50%_50%)] text-white border-transparent',
  },
  source_unreliable: {
    label: '源不可靠',
    className: 'bg-[hsl(0_48%_58%)] text-white border-transparent',
  },
};

const WorkbenchQualityTab = () => {
  const [items, setItems] = useState<QualityGateItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [reasonFilter, setReasonFilter] = useState<string>('all');

  const fetchData = useCallback(() => {
    setLoading(true);
    const params: Record<string, string> = {};
    if (reasonFilter !== 'all') params.reason = reasonFilter;
    getQualityGates(params)
      .then((data: { items: QualityGateItem[] }) => setItems(data.items))
      .catch((err: unknown) => {
        logger.error(`Failed to load quality gates: ${String(err)}`);
        setItems([]);
        toast.error('加载质量门禁失败');
      })
      .finally(() => setLoading(false));
  }, [reasonFilter]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  return (
    <div>
      <div className="flex items-center gap-3 mb-4">
        <Select value={reasonFilter} onValueChange={(v: string) => setReasonFilter(v)}>
          <SelectTrigger>
            <SelectValue placeholder="拦截原因" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部原因</SelectItem>
            <SelectItem value="link_dead">链接失效</SelectItem>
            <SelectItem value="content_stale">内容陈旧</SelectItem>
            <SelectItem value="same_url">URL重复</SelectItem>
            <SelectItem value="same_title">标题重复</SelectItem>
            <SelectItem value="same_batch_url">批次URL重复</SelectItem>
            <SelectItem value="same_batch_title">批次标题重复</SelectItem>
            <SelectItem value="source_unreliable">源不可靠</SelectItem>
            <SelectItem value="untraceable">无法溯源</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {loading ? (
        <div className="py-12 text-center text-sm text-muted-foreground">
          加载中...
        </div>
      ) : items.length === 0 ? (
        <Empty>
          <EmptyTitle>暂无数据</EmptyTitle>
          <EmptyDescription>当前筛选条件下没有拦截记录</EmptyDescription>
        </Empty>
      ) : (
        <div className="rounded-sm border border-border overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-accent/30">
                <th className="text-left py-3 px-4 font-medium text-muted-foreground">标题</th>
                <th className="text-left py-3 px-4 font-medium text-muted-foreground">来源</th>
                <th className="text-left py-3 px-4 font-medium text-muted-foreground">拦截原因</th>
                <th className="text-left py-3 px-4 font-medium text-muted-foreground">详情</th>
                <th className="text-left py-3 px-4 font-medium text-muted-foreground">拦截时间</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item: QualityGateItem) => {
                const reasonCfg = REASON_MAP[item.reason] ?? {
                  label: item.reason,
                  className: 'bg-[hsl(220_12%_50%)] text-white border-transparent',
                };
                return (
                  <tr
                    key={item.id}
                    className="border-b border-border hover:bg-accent/50"
                  >
                    <td className="py-3 px-4 truncate max-w-[200px]">
                      {item.articleTitle}
                    </td>
                    <td className="py-3 px-4 text-muted-foreground">
                      {item.sourceName}
                    </td>
                    <td className="py-3 px-4">
                      <Badge className={reasonCfg.className}>
                        {reasonCfg.label}
                      </Badge>
                    </td>
                    <td className="py-3 px-4 text-muted-foreground truncate max-w-[250px]">
                      {item.detail}
                    </td>
                    <td className="py-3 px-4 text-muted-foreground">
                      {dayjs(item.blockedAt).format('MM-DD HH:mm')}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};

export default WorkbenchQualityTab;
