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
import { getTraceList } from '@client/src/api/article';
import { logger } from '@lark-apaas/client-toolkit/logger';
import { toast } from 'sonner';
import type { ArticleTrace, TraceStatus } from '@shared/api.interface';

const STATUS_MAP: Record<TraceStatus, { label: string; className: string }> = {
  first_party: {
    label: '一手发布',
    className: 'bg-[hsl(150_60%_40%)] text-white border-transparent',
  },
  editorial: {
    label: '编辑采编',
    className: 'bg-[hsl(220_75%_45%)] text-white border-transparent',
  },
  verified_reference: {
    label: '已验证引用',
    className: 'bg-[hsl(150_60%_40%)] text-white border-transparent',
  },
  needs_review: {
    label: '来源待核验',
    className: 'bg-[hsl(5_70%_50%)] text-white border-transparent',
  },
  unknown: {
    label: '来源不明',
    className: 'bg-[hsl(220_12%_50%)] text-white border-transparent',
  },
};

const WorkbenchTraceTab = () => {
  const [items, setItems] = useState<ArticleTrace[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<string>('all');

  const fetchData = useCallback(() => {
    setLoading(true);
    const params: Record<string, string> = {};
    if (filter !== 'all') params.traceStatus = filter;
    getTraceList(params)
      .then((data: { items: ArticleTrace[] }) => setItems(data.items))
      .catch((err: unknown) => {
        logger.error(`Failed to load traces: ${String(err)}`);
        toast.error('加载溯源数据失败');
      })
      .finally(() => setLoading(false));
  }, [filter]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  return (
    <div>
      <div className="flex items-center gap-3 mb-4">
        <Select value={filter} onValueChange={(v: string) => setFilter(v)}>
          <SelectTrigger>
            <SelectValue placeholder="来源状态" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部</SelectItem>
            <SelectItem value="first_party">一手发布</SelectItem>
            <SelectItem value="editorial">编辑采编</SelectItem>
            <SelectItem value="verified_reference">已验证引用</SelectItem>
            <SelectItem value="needs_review">来源待核验</SelectItem>
            <SelectItem value="unknown">来源不明</SelectItem>
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
          <EmptyDescription>当前筛选条件下没有来源与证据记录</EmptyDescription>
        </Empty>
      ) : (
        <div className="rounded-sm border border-border overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-accent/30">
                <th className="text-left py-3 px-4 font-medium text-muted-foreground">标题</th>
                <th className="text-left py-3 px-4 font-medium text-muted-foreground">发现地址</th>
                <th className="text-left py-3 px-4 font-medium text-muted-foreground">关联原始出处</th>
                <th className="text-left py-3 px-4 font-medium text-muted-foreground">来源状态</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item: ArticleTrace) => {
                const statusCfg = STATUS_MAP[item.traceStatus];
                return (
                  <tr
                    key={item.articleId}
                    className="border-b border-border hover:bg-accent/50"
                  >
                    <td className="py-3 px-4 truncate max-w-[200px]">
                      {item.title}
                    </td>
                    <td className="py-3 px-4 truncate max-w-[200px] font-mono text-xs text-muted-foreground">
                      {item.url}
                    </td>
                    <td className="py-3 px-4 truncate max-w-[200px] font-mono text-xs text-muted-foreground">
                      {item.originalUrl && item.originalUrl !== item.url
                        ? item.originalUrl
                        : '-'}
                    </td>
                    <td className="py-3 px-4">
                      <Badge className={statusCfg.className} title={item.originEvidence ?? undefined}>
                        {statusCfg.label}
                      </Badge>
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

export default WorkbenchTraceTab;
