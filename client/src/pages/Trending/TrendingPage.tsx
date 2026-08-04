import { useState, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import GithubTrendingCard from './GithubTrendingCard';
import WeiboHotCard from './WeiboHotCard';

const TrendingPage = () => {
  const [refreshCount, setRefreshCount] = useState(0);
  const [refreshing, setRefreshing] = useState(false);

  const handleForceRefresh = useCallback(() => {
    setRefreshing(true);
    setRefreshCount((prev) => prev + 1);
    toast.success('正在强制刷新...');
    setTimeout(() => setRefreshing(false), 3000);
  }, []);

  return (
    <div className="min-h-screen" style={{ backgroundColor: 'hsl(220,20%,97%)' }}>
      <div className="max-w-6xl mx-auto px-4 py-6">
        {/* Page Header */}
        <div className="flex items-center justify-between mb-5">
          <h1 className="text-lg font-semibold text-foreground">热榜</h1>
          <Button
            variant="outline"
            size="sm"
            onClick={handleForceRefresh}
            disabled={refreshing}
          >
            <RefreshCw className={`size-4 ${refreshing ? 'animate-spin' : ''}`} />
            强制刷新
          </Button>
        </div>

        {/* Two-column grid */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <GithubTrendingCard forceRefresh={refreshCount} />
          <WeiboHotCard forceRefresh={refreshCount} />
        </div>
      </div>
    </div>
  );
};

export default TrendingPage;
