/**
 * Vite embeds VITE_* values in browser assets. Keep admin credentials limited
 * to an explicitly opted-in local development build.
 */
export function getDevelopmentAdminHeaders(
  isDev: boolean,
  localDevEnabled: boolean,
  token: unknown,
): Record<string, string> {
  if (!isDev || !localDevEnabled || typeof token !== 'string' || token.trim() === '') {
    return {};
  }
  return { 'x-admin-token': token.trim() };
}
