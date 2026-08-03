import { useState, useEffect, useCallback } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { toast } from 'sonner';
import dayjs from 'dayjs';
import { Plus, Pencil, Trash2, ChevronDown, ChevronRight, ExternalLink } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import { Empty, EmptyHeader, EmptyTitle, EmptyDescription } from '@/components/ui/empty';
import { Database } from 'lucide-react';
import { logger } from '@lark-apaas/client-toolkit/logger';
import type { FeedSourceListItem, FeedSourceHealth, Tier, FeedType } from '@shared/api.interface';
import {
  getFeedSources,
  createFeedSource,
  updateFeedSource,
  deleteFeedSource,
  toggleFeedSource,
  getFeedSourceHealth,
} from '@client/src/api/feed-source';
import { UniversalLink } from '@lark-apaas/client-toolkit/components/UniversalLink';

const feedSourceSchema = z.object({
  name: z.string().min(1, '名称不能为空'),
  url: z.string().url('请输入有效的 URL'),
  tier: z.enum(['authoritative', 'validation', 'signal'] as const, { required_error: '请选择层级' }),
  feedType: z.enum(['rss', 'atom', 'web'] as const, { required_error: '请选择类型' }),
});

type FeedSourceFormData = z.infer<typeof feedSourceSchema>;

const TIER_CONFIG: Record<Tier, { label: string; bg: string; fg: string }> = {
  authoritative: { label: '权威', bg: 'hsl(220,75%,45%)', fg: 'hsl(0,0%,100%)' },
  validation: { label: '验证', bg: 'hsl(210,60%,90%)', fg: 'hsl(210,60%,25%)' },
  signal: { label: '信号', bg: 'hsl(220,15%,90%)', fg: 'hsl(220,12%,40%)' },
};

const FEED_TYPE_LABELS: Record<FeedType, string> = {
  rss: 'RSS',
  atom: 'Atom',
  web: '网页',
};

function SourceManage() {
  const [sources, setSources] = useState<FeedSourceListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [tierFilter, setTierFilter] = useState<string>('all');
  const [enabledFilter, setEnabledFilter] = useState<string>('all');
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingSource, setEditingSource] = useState<FeedSourceListItem | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<FeedSourceListItem | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [healthData, setHealthData] = useState<Record<string, FeedSourceHealth>>({});

  const form = useForm<FeedSourceFormData>({
    resolver: zodResolver(feedSourceSchema),
    defaultValues: { name: '', url: '', tier: 'signal', feedType: 'rss' },
  });

  const fetchSources = useCallback(async () => {
    setLoading(true);
    try {
      const params: Record<string, string | number> = { page: 1, pageSize: 50 };
      if (tierFilter !== 'all') params.tier = tierFilter;
      if (enabledFilter !== 'all') params.enabled = enabledFilter;
      const data = await getFeedSources(params);
      setSources(data.items);
      setTotal(data.total);
    } catch (err) {
      logger.error('Failed to fetch sources', err);
      toast.error('加载信息源失败');
    } finally {
      setLoading(false);
    }
  }, [tierFilter, enabledFilter]);

  useEffect(() => { fetchSources(); }, [fetchSources]);

  const openCreateDialog = () => {
    setEditingSource(null);
    form.reset({ name: '', url: '', tier: 'signal', feedType: 'rss' });
    setDialogOpen(true);
  };

  const openEditDialog = (source: FeedSourceListItem) => {
    setEditingSource(source);
    form.reset({ name: source.name, url: source.url, tier: source.tier, feedType: source.feedType });
    setDialogOpen(true);
  };

  const handleSubmit = async (data: FeedSourceFormData) => {
    try {
      if (editingSource) {
        await updateFeedSource(editingSource.id, { name: data.name, url: data.url, tier: data.tier, feedType: data.feedType });
        toast.success('信息源已更新');
      } else {
        await createFeedSource({ name: data.name, url: data.url, tier: data.tier, feedType: data.feedType });
        toast.success('信息源已创建');
      }
      setDialogOpen(false);
      fetchSources();
    } catch (err) {
      logger.error('Failed to save source', err);
      toast.error(editingSource ? '更新失败' : '创建失败');
    }
  };

  const handleDelete = async () => {
    if (!deleteConfirm) return;
    try {
      await deleteFeedSource(deleteConfirm.id);
      toast.success('信息源已删除');
      setDeleteConfirm(null);
      fetchSources();
    } catch (err) {
      logger.error('Failed to delete source', err);
      toast.error('删除失败');
    }
  };

  const handleToggle = async (source: FeedSourceListItem) => {
    try {
      await toggleFeedSource(source.id, !source.enabled);
      toast.success(source.enabled ? '已禁用' : '已启用');
      fetchSources();
    } catch (err) {
      logger.error('Failed to toggle source', err);
      toast.error('操作失败');
    }
  };

  const toggleExpand = async (id: string) => {
    if (expandedId === id) {
      setExpandedId(null);
      return;
    }
    setExpandedId(id);
    if (!healthData[id]) {
      try {
        const health = await getFeedSourceHealth(id);
        setHealthData((prev) => ({ ...prev, [id]: health }));
      } catch (err) {
        logger.error('Failed to fetch health', err);
      }
    }
  };

  const formatSuccessRate = (rate: number): string => `${rate.toFixed(0)}%`;
  const rateColor = (rate: number): string =>
    rate >= 80 ? 'text-[hsl(150_60%_40%)]' : rate >= 50 ? 'text-[hsl(35_85%_55%)]' : 'text-[hsl(5_70%_50%)]';

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Button onClick={openCreateDialog} className="gap-1.5">
          <Plus className="size-4" />
          新增信息源
        </Button>
        <div className="flex items-center gap-2">
          <Select value={tierFilter} onValueChange={setTierFilter}>
            <SelectTrigger className="w-[140px]">
              <SelectValue placeholder="层级筛选" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部层级</SelectItem>
              <SelectItem value="authoritative">权威</SelectItem>
              <SelectItem value="validation">验证</SelectItem>
              <SelectItem value="signal">信号</SelectItem>
            </SelectContent>
          </Select>
          <Select value={enabledFilter} onValueChange={setEnabledFilter}>
            <SelectTrigger className="w-[140px]">
              <SelectValue placeholder="状态筛选" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部状态</SelectItem>
              <SelectItem value="true">已启用</SelectItem>
              <SelectItem value="false">已禁用</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {loading ? (
        <div className="py-12 text-center text-muted-foreground">加载中...</div>
      ) : sources.length === 0 ? (
        <Empty className="py-12">
          <EmptyHeader>
            <EmptyTitle>暂无信息源</EmptyTitle>
            <EmptyDescription>点击「新增信息源」添加第一个 RSS 信息源</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="rounded-sm border border-border overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/30">
                <th className="text-left py-3 px-4 font-medium text-muted-foreground w-6" />
                <th className="text-left py-3 px-4 font-medium text-muted-foreground">名称</th>
                <th className="text-left py-3 px-4 font-medium text-muted-foreground">URL</th>
                <th className="text-left py-3 px-4 font-medium text-muted-foreground">层级</th>
                <th className="text-left py-3 px-4 font-medium text-muted-foreground">类型</th>
                <th className="text-left py-3 px-4 font-medium text-muted-foreground">启用</th>
                <th className="text-right py-3 px-4 font-medium text-muted-foreground">成功率</th>
                <th className="text-left py-3 px-4 font-medium text-muted-foreground">最后成功</th>
                <th className="text-right py-3 px-4 font-medium text-muted-foreground">操作</th>
              </tr>
            </thead>
            <tbody>
              {sources.map((source) => {
                const tierConf = TIER_CONFIG[source.tier];
                const isExpanded = expandedId === source.id;
                const health = healthData[source.id];
                return (
                  <>
                    <tr
                      key={source.id}
                      className="border-b border-border hover:bg-accent/30 cursor-pointer"
                      onClick={() => toggleExpand(source.id)}
                    >
                      <td className="py-3 px-4">
                        {isExpanded
                          ? <ChevronDown className="size-4 text-muted-foreground" />
                          : <ChevronRight className="size-4 text-muted-foreground" />}
                      </td>
                      <td className="py-3 px-4 font-medium">{source.name}</td>
                      <td className="py-3 px-4 max-w-[200px] truncate text-muted-foreground">
                        <UniversalLink to={source.url} target="_blank" rel="noopener noreferrer" className="hover:text-primary flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                          {source.url}
                          <ExternalLink className="size-3 shrink-0" />
                        </UniversalLink>
                      </td>
                      <td className="py-3 px-4">
                        <span
                          className="inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium"
                          style={{ backgroundColor: tierConf.bg, color: tierConf.fg }}
                        >
                          {tierConf.label}
                        </span>
                      </td>
                      <td className="py-3 px-4 text-muted-foreground">{FEED_TYPE_LABELS[source.feedType]}</td>
                      <td className="py-3 px-4" onClick={(e) => e.stopPropagation()}>
                        <Switch checked={source.enabled} onCheckedChange={() => handleToggle(source)} />
                      </td>
                      <td className={`py-3 px-4 text-right font-mono ${rateColor(source.successRate)}`}>
                        {formatSuccessRate(source.successRate)}
                      </td>
                      <td className="py-3 px-4 text-muted-foreground text-xs">
                        {source.lastSuccessAt ? dayjs(source.lastSuccessAt).format('MM/DD HH:mm') : '从未'}
                      </td>
                      <td className="py-3 px-4 text-right" onClick={(e) => e.stopPropagation()}>
                        <div className="flex items-center justify-end gap-1">
                          <Button variant="ghost" size="icon" className="size-7" onClick={() => openEditDialog(source)}>
                            <Pencil className="size-3.5" />
                          </Button>
                          <Button variant="ghost" size="icon" className="size-7 text-destructive" onClick={() => setDeleteConfirm(source)}>
                            <Trash2 className="size-3.5" />
                          </Button>
                        </div>
                      </td>
                    </tr>
                    {isExpanded && (
                      <tr key={`${source.id}-health`}>
                        <td colSpan={9} className="bg-muted/20 px-4 py-3">
                          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                            <div>
                              <span className="text-muted-foreground">总抓取次数</span>
                              <p className="font-mono font-medium">{health?.totalFetches ?? '-'}</p>
                            </div>
                            <div>
                              <span className="text-muted-foreground">成功次数</span>
                              <p className="font-mono font-medium">{health?.successFetches ?? '-'}</p>
                            </div>
                            <div>
                              <span className="text-muted-foreground">连续失败</span>
                              <p className={`font-mono font-medium ${health && health.consecutiveFailures > 0 ? 'text-destructive' : ''}`}>
                                {health?.consecutiveFailures ?? '-'}
                              </p>
                            </div>
                            <div>
                              <span className="text-muted-foreground">最近错误</span>
                              <p className="text-xs text-muted-foreground truncate max-w-[200px]" title={health?.lastError ?? ''}>
                                {health?.lastError || '无'}
                              </p>
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </>
                );
              })}
            </tbody>
          </table>
          <div className="px-4 py-2 text-xs text-muted-foreground border-t border-border">
            共 {total} 个信息源
          </div>
        </div>
      )}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editingSource ? '编辑信息源' : '新增信息源'}</DialogTitle>
          </DialogHeader>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(handleSubmit)} className="space-y-4">
              <FormField
                control={form.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>名称 <span className="text-destructive">*</span></FormLabel>
                    <FormControl><Input placeholder="如 OpenAI Blog" {...field} /></FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="url"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>URL <span className="text-destructive">*</span></FormLabel>
                    <FormControl><Input placeholder="https://..." {...field} /></FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <div className="flex gap-4">
                <FormField
                  control={form.control}
                  name="tier"
                  render={({ field }) => (
                    <FormItem className="flex-1">
                      <FormLabel>层级 <span className="text-destructive">*</span></FormLabel>
                      <Select onValueChange={field.onChange} value={field.value}>
                        <FormControl><SelectTrigger><SelectValue placeholder="选择层级" /></SelectTrigger></FormControl>
                        <SelectContent>
                          <SelectItem value="authoritative">权威</SelectItem>
                          <SelectItem value="validation">验证</SelectItem>
                          <SelectItem value="signal">信号</SelectItem>
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="feedType"
                  render={({ field }) => (
                    <FormItem className="flex-1">
                      <FormLabel>类型 <span className="text-destructive">*</span></FormLabel>
                      <Select onValueChange={field.onChange} value={field.value}>
                        <FormControl><SelectTrigger><SelectValue placeholder="选择类型" /></SelectTrigger></FormControl>
                        <SelectContent>
                          <SelectItem value="rss">RSS</SelectItem>
                          <SelectItem value="atom">Atom</SelectItem>
                          <SelectItem value="web">网页</SelectItem>
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <Button type="button" variant="outline" onClick={() => setDialogOpen(false)}>取消</Button>
                <Button type="submit">{editingSource ? '保存' : '创建'}</Button>
              </div>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      <Dialog open={!!deleteConfirm} onOpenChange={(open) => !open && setDeleteConfirm(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>确认删除</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            确定要删除「{deleteConfirm?.name}」吗？此操作不可撤销。
          </p>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => setDeleteConfirm(null)}>取消</Button>
            <Button variant="destructive" onClick={handleDelete}>删除</Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export default SourceManage;
