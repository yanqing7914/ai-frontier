export const logger = {
  info: (...args: unknown[]) => console.info('[AI Frontier]', ...args),
  warn: (...args: unknown[]) => console.warn('[AI Frontier]', ...args),
  error: (...args: unknown[]) => console.error('[AI Frontier]', ...args),
};
