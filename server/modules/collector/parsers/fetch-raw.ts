const FETCH_TIMEOUT = 15000;
const USER_AGENT = 'AI-News-Dashboard/1.0';

export interface RawFetchResult {
  content: string;
  contentType: string;
  byteLength: number;
  httpStatus: number;
}

export async function fetchRawContent(url: string): Promise<RawFetchResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
  const response = await fetch(url, {
    signal: controller.signal,
    headers: {
      'User-Agent': USER_AGENT,
      'Accept': 'text/xml,application/xml,application/json,text/html,*/*',
    },
    redirect: 'follow',
  });
  clearTimeout(timer);

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`);
  }

  const content = await response.text();
  const contentType = response.headers.get('content-type') || '';
  return {
    content,
    contentType,
    byteLength: Buffer.byteLength(content, 'utf-8'),
    httpStatus: response.status,
  };
}
