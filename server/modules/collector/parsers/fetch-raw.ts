export const DEFAULT_FETCH_TIMEOUT_MS = 15_000;
export const DEFAULT_MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const USER_AGENT = 'AI-News-Dashboard/1.0';
import { validateSafeUrl } from '../trace-engine';

export interface RawFetchResult {
  content: string;
  contentType: string;
  byteLength: number;
  httpStatus: number;
  finalUrl: string;
}

export interface RawFetchOptions {
  timeoutMs?: number;
  maxBytes?: number;
}

export class FetchHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfterMs: number | null,
  ) {
    super(message);
    this.name = 'FetchHttpError';
  }
}

export class FetchBodyTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`Response body exceeds ${maxBytes} bytes`);
    this.name = 'FetchBodyTooLargeError';
  }
}

export function parseRetryAfter(
  value: string | null,
  nowMs: number = Date.now(),
): number | null {
  if (!value) return null;
  const seconds = Number(value.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;

  const retryAt = Date.parse(value);
  return Number.isFinite(retryAt) ? Math.max(0, retryAt - nowMs) : null;
}

function requirePositiveInteger(
  value: number | undefined,
  fallback: number,
  name: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new RangeError(`${name} must be a positive integer`);
  }
  return resolved;
}

async function readBodyWithinLimit(
  response: Response,
  maxBytes: number,
): Promise<{ content: string; byteLength: number }> {
  const declaredLength = response.headers.get('content-length');
  if (declaredLength !== null) {
    const parsedLength = Number(declaredLength);
    if (Number.isFinite(parsedLength) && parsedLength > maxBytes) {
      await response.body?.cancel();
      throw new FetchBodyTooLargeError(maxBytes);
    }
  }

  if (!response.body) return { content: '', byteLength: 0 };

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let content = '';
  let byteLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > maxBytes) {
        await reader.cancel();
        throw new FetchBodyTooLargeError(maxBytes);
      }
      content += decoder.decode(value, { stream: true });
    }
    content += decoder.decode();
    return { content, byteLength };
  } finally {
    reader.releaseLock();
  }
}

export async function fetchRawContent(
  url: string,
  options: RawFetchOptions = {},
): Promise<RawFetchResult> {
  const timeoutMs = requirePositiveInteger(
    options.timeoutMs,
    DEFAULT_FETCH_TIMEOUT_MS,
    'timeoutMs',
  );
  const maxBytes = requirePositiveInteger(
    options.maxBytes,
    DEFAULT_MAX_RESPONSE_BYTES,
    'maxBytes',
  );
  const safety = await validateSafeUrl(url);
  if (!safety.safe || !safety.url) {
    throw new Error(`Refusing unsafe remote URL: ${safety.reason}`);
  }
  url = safety.url;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'text/xml,application/xml,application/json,text/html,*/*',
      },
      redirect: 'follow',
    });

    if (!response.ok) {
      await response.body?.cancel();
      throw new FetchHttpError(
        `HTTP ${response.status} for ${url}`,
        response.status,
        parseRetryAfter(response.headers.get('retry-after')),
      );
    }

    const { content, byteLength } = await readBodyWithinLimit(response, maxBytes);
    return {
      content,
      contentType: response.headers.get('content-type') || '',
      byteLength,
      httpStatus: response.status,
      finalUrl: response.url || url,
    };
  } catch (error: unknown) {
    if (controller.signal.aborted) {
      throw new Error(`Fetch timed out after ${timeoutMs}ms for ${url}`, {
        cause: error,
      });
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
