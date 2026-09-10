import { http } from '@/lib/http';
import { parsePaginatedResponse } from '@/lib/api-contract';
import type {
  FeedSourceListItem,
  FeedSourceHealth,
  CreateFeedSourceRequest,
  UpdateFeedSourceRequest,
  PaginatedResponse,
} from '@shared/api.interface';

export async function getFeedSources(params: {
  page?: number;
  pageSize?: number;
  tier?: string;
  enabled?: string;
}) {
  const res = await http.get('/api/feed-sources', { params });
  return parsePaginatedResponse<FeedSourceListItem>(res.data, 'Feed sources');
}

export async function getFeedSource(id: string) {
  const res = await http.get(`/api/feed-sources/${id}`);
  return res.data as FeedSourceListItem;
}

export async function createFeedSource(data: CreateFeedSourceRequest) {
  const res = await http.post('/api/feed-sources', data);
  return res.data;
}

export async function updateFeedSource(id: string, data: UpdateFeedSourceRequest) {
  const res = await http.patch(`/api/feed-sources/${id}`, data);
  return res.data;
}

export async function deleteFeedSource(id: string) {
  const res = await http.delete(`/api/feed-sources/${id}`);
  return res.data;
}

export async function toggleFeedSource(id: string, enabled: boolean) {
  const res = await http.patch(`/api/feed-sources/${id}/toggle`, { enabled });
  return res.data;
}

export async function getFeedSourceHealth(id: string) {
  const res = await http.get(`/api/feed-sources/${id}/health`);
  return res.data as FeedSourceHealth;
}
