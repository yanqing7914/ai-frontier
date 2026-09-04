import { http } from '@/lib/http';
import type { HotlistResponse, GithubTrendingItem, WeiboHotItem } from '@shared/api.interface';

export async function getGithubTrending(since: 'daily' | 'weekly' = 'daily', force = false) {
  const res = await http.get<HotlistResponse<GithubTrendingItem>>('/api/hotlist/github', { params: { since, force: force ? 'true' : undefined } });
  return res.data;
}

export async function getWeiboHotSearch(force = false) {
  const res = await http.get<HotlistResponse<WeiboHotItem>>('/api/hotlist/weibo', { params: { force: force ? 'true' : undefined } });
  return res.data;
}
