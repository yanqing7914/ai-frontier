export type AiProviderProtocol =
  | 'missing'
  | 'legacy'
  | 'openai'
  | 'unsupported';

export type AiScoringBlockReason =
  | 'missing_endpoint'
  | 'missing_api_key'
  | 'legacy_protocol'
  | 'unsupported_protocol';

export type AiProviderEndpointSource = 'capability' | 'global' | 'missing';

export const AI_SCORING_CAPABILITY_ID = 'ai_article_scoring_1';

export interface AiProviderStatus {
  protocol: AiProviderProtocol;
  endpointConfigured: boolean;
  endpointSource: AiProviderEndpointSource;
  endpointVariable: string | null;
  apiKeyConfigured: boolean;
  modelConfigured: boolean;
  providerConfigured: boolean;
  scoringAgent: {
    enabled: boolean;
    invocation: 'available' | 'not_configured';
    blockReason: AiScoringBlockReason | null;
  };
}

const OPENAI_PROVIDER_PROTOCOLS = new Set([
  'openai',
  'openai-compatible',
  'openai_compatible',
]);

export function capabilityEndpointVariable(capabilityId: string): string {
  return `${capabilityId.toUpperCase()}_URL`;
}

export function resolveAiProviderEndpoint(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  capabilityId: string = AI_SCORING_CAPABILITY_ID,
): {
  value: string | undefined;
  source: AiProviderEndpointSource;
  variable: string | null;
} {
  const capabilityVariable = capabilityEndpointVariable(capabilityId);
  const capabilityValue = environment[capabilityVariable]?.trim();
  if (capabilityValue) {
    return {
      value: capabilityValue,
      source: 'capability',
      variable: capabilityVariable,
    };
  }

  const globalValue = environment.AI_PROVIDER_URL?.trim();
  if (globalValue) {
    return {
      value: globalValue,
      source: 'global',
      variable: 'AI_PROVIDER_URL',
    };
  }

  return { value: undefined, source: 'missing', variable: null };
}

export function normalizeAiProviderProtocol(
  value: string | undefined,
): AiProviderProtocol {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return 'missing';
  if (normalized === 'legacy') return 'legacy';
  if (OPENAI_PROVIDER_PROTOCOLS.has(normalized)) return 'openai';
  return 'unsupported';
}

export function getAiProviderStatus(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  capabilityId: string = AI_SCORING_CAPABILITY_ID,
): AiProviderStatus {
  const endpoint = resolveAiProviderEndpoint(environment, capabilityId);
  const protocol = normalizeAiProviderProtocol(
    environment.AI_PROVIDER_PROTOCOL,
  );
  const endpointConfigured = Boolean(endpoint.value);
  const apiKeyConfigured = Boolean(environment.AI_PROVIDER_API_KEY?.trim());
  const modelConfigured = Boolean(environment.AI_PROVIDER_MODEL?.trim());
  const providerConfigured =
    endpointConfigured &&
    protocol !== 'unsupported' &&
    (protocol === 'legacy' || protocol === 'missing' || apiKeyConfigured);

  let blockReason: AiScoringBlockReason | null = null;
  if (!endpointConfigured) blockReason = 'missing_endpoint';
  else if (protocol === 'openai' && !apiKeyConfigured) {
    blockReason = 'missing_api_key';
  } else if (protocol === 'legacy' || protocol === 'missing') {
    blockReason = 'legacy_protocol';
  } else if (protocol === 'unsupported') {
    blockReason = 'unsupported_protocol';
  }

  const scoringEnabled =
    endpointConfigured && apiKeyConfigured && protocol === 'openai';

  return {
    protocol,
    endpointConfigured,
    endpointSource: endpoint.source,
    endpointVariable: endpoint.variable,
    apiKeyConfigured,
    modelConfigured,
    providerConfigured,
    scoringAgent: {
      enabled: scoringEnabled,
      invocation: scoringEnabled ? 'available' : 'not_configured',
      blockReason: scoringEnabled ? null : blockReason,
    },
  };
}
