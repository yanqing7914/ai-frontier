export function validateApiResponse(data: unknown, contentType: unknown): void {
  const mediaType = typeof contentType === 'string' ? contentType : '';
  if (mediaType.includes('text/html') || typeof data === 'string') {
    throw new Error('API returned HTML instead of JSON; check the local API proxy');
  }
}
