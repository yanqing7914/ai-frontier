import { useState, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import WeiboHotCard from './WeiboHotCard';

const WeiboHotPage = () => {
  const [refreshCount, setRefreshCount] = useState(0);
  const [refreshing, setRefreshing] = useState(false);

  const handleForceRefresh = useCallback(() => {
    setRefreshing(true);
    setRefreshCount((prev) => prev + 1);
    toast.success('正在强制刷新...');
    setTimeout(() => setRefreshing(false), 3000);
  }, []);

  return (
    <div className="py-2">
      <div className="flex items-center justify-between mb-5">
        <h1 className="text-lg font-semibold text-foreground">微博热搜</h1>
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
      <WeiboHotCard forceRefresh={refreshCount} />
    </div>
  );
};

export default WeiboHotPage;
