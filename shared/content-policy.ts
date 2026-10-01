/** Defaults for the AI Frontier editorial policy. Database settings may override them. */
export const CONTENT_POLICY = {
  version: 'ai-frontier-2026-09',
  selection: {
    publishThreshold: 75,
    dailyFrontPageLimit: 20,
  },
} as const;
