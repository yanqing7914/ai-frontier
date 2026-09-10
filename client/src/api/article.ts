import { http } from '@/lib/http';
import { parseDailyDigest, parseItemsResponse, parsePaginatedResponse, parseWorkbenchOverview } from '@/lib/api-contract';
import type {
  HotArticleItem,
  PaginatedResponse,
  DailyDigest,
  WorkbenchOverview,
  WorkbenchArticleItem,
  DirectionScoreItem,
  QualityGateItem,
  ReviewItem,
  ArticleTrace,
} from '@shared/api.interface';

export async function getHotArticles(params: {
  page?: number;
  pageSize?: number;
  directions?: string;
}): Promise<PaginatedResponse<HotArticleItem>> {
  const res = await http.get('/api/hot-articles', { params });
  return parsePaginatedResponse<HotArticleItem>(res.data, 'Hot articles');
}

export async function getDailyDigest(
  date: string,
): Promise<DailyDigest> {
  const res = await http.get(`/api/daily-digests/${date}`);
  return parseDailyDigest(res.data);
}

export async function getWorkbenchOverview(): Promise<WorkbenchOverview> {
  const res = await http.get('/api/workbench/overview');
  return parseWorkbenchOverview(res.data);
}

export async function getWorkbenchArticles(params: {
  page?: number;
  pageSize?: number;
  status?: string;
  direction?: string;
  sortBy?: string;
}): Promise<PaginatedResponse<WorkbenchArticleItem>> {
  const res = await http.get('/api/workbench/articles', {
    params,
  });
  return parsePaginatedResponse<WorkbenchArticleItem>(res.data, 'Workbench articles');
}

export async function getArticleScores(
  id: string,
): Promise<{ items: DirectionScoreItem[] }> {
  const res = await http.get(`/api/articles/${id}/scores`);
  return parseItemsResponse<DirectionScoreItem>(res.data, 'Article scores');
}

export async function getQualityGates(params: {
  page?: number;
  pageSize?: number;
  reason?: string;
}): Promise<PaginatedResponse<QualityGateItem>> {
  const res = await http.get('/api/workbench/quality-gates', {
    params,
  });
  return parsePaginatedResponse<QualityGateItem>(res.data, 'Quality gates');
}

export async function getTraceList(params: {
  page?: number;
  pageSize?: number;
  traceStatus?: string;
}): Promise<PaginatedResponse<ArticleTrace>> {
  const res = await http.get('/api/workbench/trace', { params });
  return parsePaginatedResponse<ArticleTrace>(res.data, 'Article trace');
}

export async function getReviews(params: {
  page?: number;
  pageSize?: number;
  status?: string;
}): Promise<PaginatedResponse<ReviewItem>> {
  const res = await http.get('/api/workbench/reviews', {
    params,
  });
  return parsePaginatedResponse<ReviewItem>(res.data, 'Reviews');
}

export async function processReview(
  id: string,
  data: { action: 'approve' | 'reject'; note?: string },
): Promise<{ id: string; status: string }> {
  const res = await http.patch(
    `/api/workbench/reviews/${id}`,
    data,
  );
  return res.data as { id: string; status: string };
}
