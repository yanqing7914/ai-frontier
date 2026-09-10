import { http } from '@/lib/http';
import { parseHotlistResponse } from '@/lib/api-contract';
import type { HotlistResponse, GithubTrendingItem, WeiboHotItem } from '@shared/api.interface';

export async function getGithubTrending(since: 'daily' | 'weekly' = 'daily', force = false) {
  const res = await http.get<HotlistResponse<GithubTrendingItem>>('/api/hotlist/github', { params: { since, force: force ? 'true' : undefined } });
  return parseHotlistResponse<GithubTrendingItem>(res.data);
}

export async function getWeiboHotSearch(force = false) {
  const res = await http.get<HotlistResponse<WeiboHotItem>>('/api/hotlist/weibo', { params: { force: force ? 'true' : undefined } });
  return parseHotlistResponse<WeiboHotItem>(res.data);
}
