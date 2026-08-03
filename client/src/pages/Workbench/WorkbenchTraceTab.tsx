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
import type { ArticleTrace } from '@shared/api.interface';

const WorkbenchTraceTab = () => {
  const [items, setItems] = useState<ArticleTrace[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<string>('all');

  const fetchData = useCallback(() => {
    setLoading(true);
    const params: Record<string, string> = {};
    if (filter !== 'all') params.traced = filter === 'traced' ? 'true' : 'false';
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
            <SelectValue placeholder="溯源状态" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部</SelectItem>
            <SelectItem value="traced">已溯源</SelectItem>
            <SelectItem value="untraced">未溯源</SelectItem>
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
          <EmptyDescription>当前筛选条件下没有溯源记录</EmptyDescription>
        </Empty>
      ) : (
        <div className="rounded-sm border border-border overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-accent/30">
                <th className="text-left py-3 px-4 font-medium text-muted-foreground">标题</th>
                <th className="text-left py-3 px-4 font-medium text-muted-foreground">来源URL</th>
                <th className="text-left py-3 px-4 font-medium text-muted-foreground">原始出处</th>
                <th className="text-left py-3 px-4 font-medium text-muted-foreground">溯源状态</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item: ArticleTrace) => (
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
                    {item.originalUrl ?? '-'}
                  </td>
                  <td className="py-3 px-4">
                    {item.traced ? (
                      <Badge className="bg-[hsl(150_60%_40%)] text-white border-transparent">
                        已溯源
                      </Badge>
                    ) : (
                      <Badge className="bg-[hsl(35_85%_55%)] text-white border-transparent">
                        未溯源
                      </Badge>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};

export default WorkbenchTraceTab;
