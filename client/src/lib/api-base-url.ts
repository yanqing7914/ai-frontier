/** Normalize an optional backend origin so callers can consistently use /api paths. */
export function resolveApiBaseUrl(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') return '/';

  const normalized = value.trim().replace(/\/+$/, '');
  return normalized.endsWith('/api') ? normalized.slice(0, -4) || '/' : normalized;
}
