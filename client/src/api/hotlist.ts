import { axiosForBackend } from '@lark-apaas/client-toolkit/utils/getAxiosForBackend';
import type { HotlistResponse, GithubTrendingItem, WeiboHotItem } from '@shared/api.interface';

export async function getGithubTrending(since: 'daily' | 'weekly' = 'daily') {
  const res = await axiosForBackend.get<HotlistResponse<GithubTrendingItem>>('/api/hotlist/github', { params: { since } });
  return res.data;
}

export async function getWeiboHotSearch() {
  const res = await axiosForBackend.get<HotlistResponse<WeiboHotItem>>('/api/hotlist/weibo');
  return res.data;
}
