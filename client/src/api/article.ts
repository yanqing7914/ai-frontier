import { axiosForBackend } from '@lark-apaas/client-toolkit/utils/getAxiosForBackend';
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
  const res = await axiosForBackend.get('/api/hot-articles', { params });
  return res.data as PaginatedResponse<HotArticleItem>;
}

export async function getDailyDigest(
  date: string,
): Promise<DailyDigest> {
  const res = await axiosForBackend.get(`/api/daily-digests/${date}`);
  return res.data as DailyDigest;
}

export async function getWorkbenchOverview(): Promise<WorkbenchOverview> {
  const res = await axiosForBackend.get('/api/workbench/overview');
  return res.data as WorkbenchOverview;
}

export async function getWorkbenchArticles(params: {
  page?: number;
  pageSize?: number;
  status?: string;
  direction?: string;
  sortBy?: string;
}): Promise<PaginatedResponse<WorkbenchArticleItem>> {
  const res = await axiosForBackend.get('/api/workbench/articles', {
    params,
  });
  return res.data as PaginatedResponse<WorkbenchArticleItem>;
}

export async function getArticleScores(
  id: string,
): Promise<{ items: DirectionScoreItem[] }> {
  const res = await axiosForBackend.get(`/api/articles/${id}/scores`);
  return res.data as { items: DirectionScoreItem[] };
}

export async function getQualityGates(params: {
  page?: number;
  pageSize?: number;
  reason?: string;
}): Promise<PaginatedResponse<QualityGateItem>> {
  const res = await axiosForBackend.get('/api/workbench/quality-gates', {
    params,
  });
  return res.data as PaginatedResponse<QualityGateItem>;
}

export async function getTraceList(params: {
  page?: number;
  pageSize?: number;
  traceStatus?: string;
}): Promise<PaginatedResponse<ArticleTrace>> {
  const res = await axiosForBackend.get('/api/workbench/trace', { params });
  return res.data as PaginatedResponse<ArticleTrace>;
}

export async function getReviews(params: {
  page?: number;
  pageSize?: number;
  status?: string;
}): Promise<PaginatedResponse<ReviewItem>> {
  const res = await axiosForBackend.get('/api/workbench/reviews', {
    params,
  });
  return res.data as PaginatedResponse<ReviewItem>;
}

export async function processReview(
  id: string,
  data: { action: 'approve' | 'reject'; note?: string },
): Promise<{ id: string; status: string }> {
  const res = await axiosForBackend.patch(
    `/api/workbench/reviews/${id}`,
    data,
  );
  return res.data as { id: string; status: string };
}
