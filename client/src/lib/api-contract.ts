import type {
  DailyDigest,
  HotlistResponse,
  PaginatedResponse,
  WorkbenchOverview,
} from '@shared/api.interface';

export class ApiContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApiContractError';
  }
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ApiContractError(`${label} response must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function requireItems(value: Record<string, unknown>, label: string): void {
  if (!Array.isArray(value.items)) {
    throw new ApiContractError(`${label} response.items must be an array`);
  }
}

export function parseHotlistResponse<T>(value: unknown): HotlistResponse<T> {
  const response = asRecord(value, 'Hotlist');
  if (typeof response.ok !== 'boolean') {
    throw new ApiContractError('Hotlist response.ok must be a boolean');
  }
  if (response.kind !== 'github' && response.kind !== 'weibo') {
    throw new ApiContractError('Hotlist response.kind is invalid');
  }
  if (response.source !== 'live' && response.source !== 'snapshot' && response.source !== 'none') {
    throw new ApiContractError('Hotlist response.source is invalid');
  }
  requireItems(response, 'Hotlist');
  return response as unknown as HotlistResponse<T>;
}

export function parsePaginatedResponse<T>(value: unknown, label = 'Paginated'): PaginatedResponse<T> {
  const response = asRecord(value, label);
  requireItems(response, label);
  if (typeof response.total !== 'number' || !Number.isFinite(response.total) || response.total < 0) {
    throw new ApiContractError(`${label} response.total must be a non-negative number`);
  }
  return response as unknown as PaginatedResponse<T>;
}

export function parseDailyDigest(value: unknown): DailyDigest {
  const response = asRecord(value, 'Daily digest');
  if (typeof response.id !== 'string' || typeof response.digestDate !== 'string' ||
      typeof response.summary !== 'string' || typeof response.articleCount !== 'number' ||
      !Array.isArray(response.articles)) {
    throw new ApiContractError('Daily digest response is malformed');
  }
  return response as unknown as DailyDigest;
}

export function parseWorkbenchOverview(value: unknown): WorkbenchOverview {
  const response = asRecord(value, 'Workbench overview');
  const numericFields = ['totalCollected', 'publishedCount', 'draftCount', 'pendingReviewCount', 'aiCallsToday', 'aiDailyLimit'];
  if (numericFields.some((field) => typeof response[field] !== 'number' || !Number.isFinite(response[field] as number))) {
    throw new ApiContractError('Workbench overview response is malformed');
  }
  if (typeof response.aiDegraded !== 'boolean') {
    throw new ApiContractError('Workbench overview response.aiDegraded must be a boolean');
  }
  return response as unknown as WorkbenchOverview;
}

export function parseItemsResponse<T>(value: unknown, label: string): { items: T[] } {
  const response = asRecord(value, label);
  requireItems(response, label);
  return response as { items: T[] };
}
