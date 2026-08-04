import { axiosForBackend } from '@lark-apaas/client-toolkit/utils/getAxiosForBackend';
import type { HotlistResponse, GithubTrendingItem, WeiboHotItem } from '@shared/api.interface';

export async function getGithubTrending(since: 'daily' | 'weekly' = 'daily', force = false) {
  const res = await axiosForBackend.get<HotlistResponse<GithubTrendingItem>>('/api/hotlist/github', { params: { since, force: force ? 'true' : undefined } });
  return res.data;
}

export async function getWeiboHotSearch(force = false) {
  const res = await axiosForBackend.get<HotlistResponse<WeiboHotItem>>('/api/hotlist/weibo', { params: { force: force ? 'true' : undefined } });
  return res.data;
}
