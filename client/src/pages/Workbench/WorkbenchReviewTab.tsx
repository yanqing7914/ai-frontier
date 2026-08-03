import { useState, useEffect, useCallback } from 'react';
import { Badge } from '@client/src/components/ui/badge';
import { Button } from '@client/src/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@client/src/components/ui/select';
import { Empty, EmptyTitle, EmptyDescription } from '@client/src/components/ui/empty';
import { getReviews, processReview } from '@client/src/api/article';
import { logger } from '@lark-apaas/client-toolkit/logger';
import { toast } from 'sonner';
import dayjs from 'dayjs';
import type { ReviewItem, ReviewStatus } from '@shared/api.interface';

const STATUS_MAP: Record<ReviewStatus, { label: string; className: string }> = {
  pending: {
    label: '待审核',
    className: 'bg-[hsl(35_85%_55%)] text-white border-transparent',
  },
  approved: {
    label: '已通过',
    className: 'bg-[hsl(150_60%_40%)] text-white border-transparent',
  },
  rejected: {
    label: '已拒绝',
    className: 'bg-[hsl(5_70%_50%)] text-white border-transparent',
  },
};

const WorkbenchReviewTab = () => {
  const [items, setItems] = useState<ReviewItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [processingId, setProcessingId] = useState<string | null>(null);

  const fetchData = useCallback(() => {
    setLoading(true);
    const params: Record<string, string> = {};
    if (statusFilter !== 'all') params.status = statusFilter;
    getReviews(params)
      .then((data: { items: ReviewItem[] }) => setItems(data.items))
      .catch((err: unknown) => {
        logger.error(`Failed to load reviews: ${String(err)}`);
        toast.error('加载审核队列失败');
      })
      .finally(() => setLoading(false));
  }, [statusFilter]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const handleAction = async (id: string, action: 'approve' | 'reject') => {
    setProcessingId(id);
    try {
      await processReview(id, { action });
      toast.success(action === 'approve' ? '已放行' : '已丢弃');
      fetchData();
    } catch (err: unknown) {
      logger.error(`Failed to process review: ${String(err)}`);
      toast.error('操作失败');
    } finally {
      setProcessingId(null);
    }
  };

  return (
    <div>
      <div className="flex items-center gap-3 mb-4">
        <Select value={statusFilter} onValueChange={(v: string) => setStatusFilter(v)}>
          <SelectTrigger>
            <SelectValue placeholder="审核状态" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部</SelectItem>
            <SelectItem value="pending">待审核</SelectItem>
            <SelectItem value="approved">已通过</SelectItem>
            <SelectItem value="rejected">已拒绝</SelectItem>
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
          <EmptyDescription>当前筛选条件下没有审核记录</EmptyDescription>
        </Empty>
      ) : (
        <div className="rounded-sm border border-border overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-accent/30">
                <th className="text-left py-3 px-4 font-medium text-muted-foreground">标题</th>
                <th className="text-left py-3 px-4 font-medium text-muted-foreground">来源</th>
                <th className="text-left py-3 px-4 font-medium text-muted-foreground">URL</th>
                <th className="text-left py-3 px-4 font-medium text-muted-foreground">状态</th>
                <th className="text-left py-3 px-4 font-medium text-muted-foreground">采集时间</th>
                <th className="text-left py-3 px-4 font-medium text-muted-foreground">操作</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item: ReviewItem) => {
                const statusCfg = STATUS_MAP[item.status];
                const isProcessing = processingId === item.id;
                return (
                  <tr
                    key={item.id}
                    className="border-b border-border hover:bg-accent/50"
                  >
                    <td className="py-3 px-4 truncate max-w-[180px]">
                      {item.articleTitle}
                    </td>
                    <td className="py-3 px-4 text-muted-foreground">
                      {item.sourceName}
                    </td>
                    <td className="py-3 px-4 truncate max-w-[160px] font-mono text-xs text-muted-foreground">
                      {item.url}
                    </td>
                    <td className="py-3 px-4">
                      <Badge className={statusCfg.className}>
                        {statusCfg.label}
                      </Badge>
                    </td>
                    <td className="py-3 px-4 text-muted-foreground">
                      {dayjs(item.collectedAt).format('MM-DD HH:mm')}
                    </td>
                    <td className="py-3 px-4">
                      {item.status === 'pending' && (
                        <div className="flex items-center gap-2">
                          <Button
                            size="sm"
                            className="bg-[hsl(150_60%_40%)] text-white hover:bg-[hsl(150_60%_35%)] h-7 px-2.5 text-xs"
                            disabled={isProcessing}
                            onClick={() => handleAction(item.id, 'approve')}
                          >
                            放行
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            className="text-[hsl(5_70%_50%)] border-[hsl(5_70%_50%)] hover:bg-[hsl(5_70%_50%)] hover:text-white h-7 px-2.5 text-xs"
                            disabled={isProcessing}
                            onClick={() => handleAction(item.id, 'reject')}
                          >
                            丢弃
                          </Button>
                        </div>
                      )}
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

export default WorkbenchReviewTab;
