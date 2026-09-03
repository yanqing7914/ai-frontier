import {
  AGENT_ROLES,
  contractMetadata,
  ENV_SECRET_NAME_PATTERN,
  SECRET_COMPONENT_PATTERN,
  SECRET_MANAGER_NAME_PATTERN,
  type AgentCapabilityAdapters,
  type AgentConfigDiagnostic,
  type AgentConfigValidation,
  type AgentInvocationGates,
  type AgentRegistry,
  type AgentRole,
  type AgentRuntimeConfig,
  type AgentStatus,
  type AgentVerification,
  type AgentVerificationStatus,
  type CapabilityBinding,
  type SecretManagerRef,
  type SecretRef,
  type SecretResolution,
  type SecretResolverOptions,
} from './types';
import {
  ROLE_CONTRACTS,
  isPostProcessingRole,
} from '../architecture/contracts';

export interface AgentRegistryOptions extends SecretResolverOptions {
  now?: string | Date;
  overrides?: Partial<Record<AgentRole, Partial<AgentRuntimeConfig>>>;
  environment?: Record<string, string | undefined>;
}

export interface AgentInvocationOptions extends SecretResolverOptions {
  /** Either form is accepted so hosts can pass their adapter container. */
  adapters?: AgentCapabilityAdapters;
  miaoda?: AgentCapabilityAdapters['miaoda'];
  external?: AgentCapabilityAdapters['external'];
}

export const REGISTRY_LIMITS = Object.freeze({
  id: 128,
  name: 128,
  provider: 128,
  model: 128,
  promptVersion: 32,
  timeoutMs: 10 * 60 * 1000,
  retryAttempts: 10,
  retryBackoffMs: 5 * 60 * 1000,
  dailyQuota: 10_000_000,
  perMinuteQuota: 1_000_000,
  concurrentQuota: 100_000,
});

const envKey = (role: AgentRole) => `AI_FRONTIER_${role.toUpperCase()}_API_KEY`;
const envName = (role: AgentRole, field: string) =>
  `AI_FRONTIER_AGENT_${role.toUpperCase()}_${field}`;
const AGENT_STATUS_VALUES: readonly AgentStatus[] = [
  'active',
  'disabled',
  'degraded',
  'unverified',
  'pending_verification',
  'failed',
  'blocked',
];
const VERIFICATION_STATUS_VALUES: readonly AgentVerificationStatus[] = [
  'verified',
  'pending',
  'not_run',
  'failed',
];
const SENSITIVE_KEY_PATTERN =
  /(?:secret|token|password|credential|authorization|api[_.-]?key)/i;
const SAFE_COMPONENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@+~-]*$/;
const PROMPT_VERSION_PATTERN = /^v[1-9][0-9]*(?:\.[0-9]+){0,2}$/;
const ID_PATTERN = /^agent_[a-z][a-z0-9_]*$/;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nowIso(value?: string | Date): string {
  const date = value instanceof Date ? value : new Date(value || Date.now());
  return Number.isNaN(date.getTime())
    ? new Date().toISOString()
    : date.toISOString();
}

function hasOwn(value: unknown, key: string): boolean {
  return isRecord(value) && Object.prototype.hasOwnProperty.call(value, key);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isIsoDate(value: unknown): value is string {
  if (!nonEmptyString(value) || !ISO_DATE_PATTERN.test(value)) return false;
  return !Number.isNaN(Date.parse(value));
}

function sameArray(left: unknown, right: readonly unknown[]): boolean {
  return (
    Array.isArray(left) &&
    left.length === right.length &&
    left.every((item, index) => item === right[index])
  );
}

function diagnostic(
  path: string,
  code: AgentConfigDiagnostic['code'],
  message: string,
): AgentConfigDiagnostic {
  return { path, code, message };
}

function add(
  errors: AgentConfigDiagnostic[],
  path: string,
  code: AgentConfigDiagnostic['code'],
  message: string,
): void {
  errors.push(diagnostic(path, code, message));
}

function warn(
  warnings: AgentConfigDiagnostic[],
  path: string,
  code: AgentConfigDiagnostic['code'],
  message: string,
): void {
  warnings.push(diagnostic(path, code, message));
}

function isSafeComponent(value: unknown, maxLength = 128): value is string {
  return (
    nonEmptyString(value) &&
    value.length <= maxLength &&
    SAFE_COMPONENT_PATTERN.test(value) &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

/** Return only reference metadata; this is also used when applying overrides. */
function copySecretRef(value: unknown, fallback: SecretRef): SecretRef {
  if (!isRecord(value)) return fallback;
  const kind = value.kind;
  if (kind === 'env')
    return { kind, name: typeof value.name === 'string' ? value.name : '' };
  if (kind === 'secret_manager') {
    const result: SecretManagerRef = {
      kind,
      name: typeof value.name === 'string' ? value.name : '',
    };
    if (typeof value.key === 'string') result.key = value.key;
    if (typeof value.version === 'string') result.version = value.version;
    return result;
  }
  return { kind: 'env', name: '' };
}

function copyVerification(
  value: unknown,
  fallback: AgentVerification,
): AgentVerification {
  if (!isRecord(value)) return fallback;
  return {
    status: value.status as AgentVerificationStatus,
    verifiedAt: typeof value.verifiedAt === 'string' ? value.verifiedAt : null,
    verifier: typeof value.verifier === 'string' ? value.verifier : null,
    evidence: Array.isArray(value.evidence)
      ? value.evidence.filter(
          (item): item is string => typeof item === 'string',
        )
      : [],
  };
}

function copyCapability(
  value: unknown,
  fallback: CapabilityBinding,
): CapabilityBinding {
  if (!isRecord(value)) return fallback;
  return {
    capabilityId:
      typeof value.capabilityId === 'string' ? value.capabilityId : null,
    action: typeof value.action === 'string' ? value.action : null,
    inputContract:
      typeof value.inputContract === 'string'
        ? value.inputContract
        : fallback.inputContract,
    outputContract:
      typeof value.outputContract === 'string'
        ? value.outputContract
        : fallback.outputContract,
    invocation: value.invocation as CapabilityBinding['invocation'],
  };
}

function defaults(
  role: AgentRole,
  timestamp: string,
  environment: Record<string, string | undefined>,
): AgentRuntimeConfig {
  const metadata = contractMetadata(role);
  const contract = ROLE_CONTRACTS[role];
  // Agents are opt-in: an unverified default must never appear callable.
  const enabled = environment[envName(role, 'ENABLED')] === 'true';
  const status: AgentStatus = enabled ? 'unverified' : 'disabled';
  const provider =
    environment[envName(role, 'PROVIDER')] ||
    environment[`AI_FRONTIER_${role.toUpperCase()}_PROVIDER`] ||
    'contract-local';
  const model =
    environment[envName(role, 'MODEL')] ||
    environment[`AI_FRONTIER_${role.toUpperCase()}_MODEL`] ||
    'contract-v1';
  return {
    id: `agent_${role}`,
    role,
    name: role,
    ...metadata,
    provider,
    model,
    secretRef: {
      kind: 'env',
      name: environment[envName(role, 'SECRET_ENV')] || envKey(role),
    },
    enabled,
    status,
    timeoutMs: Number(environment[envName(role, 'TIMEOUT_MS')] || 30_000),
    retry: {
      maxAttempts: Number(environment[envName(role, 'RETRY_MAX')] || 2),
      backoffMs: 250,
      maxBackoffMs: 5_000,
    },
    quota: { daily: null, perMinute: null, concurrent: null },
    promptVersion: environment[envName(role, 'PROMPT_VERSION')] || 'v1',
    verification: {
      status: 'not_run',
      verifiedAt: null,
      verifier: null,
      evidence: [],
    },
    audit: {
      createdAt: timestamp,
      updatedAt: timestamp,
      createdBy: 'system',
      updatedBy: 'system',
      changeId: 'bootstrap',
      changeReason: 'runtime defaults',
      source: 'code',
    },
    capability: {
      capabilityId: null,
      action: null,
      inputContract: contract.input,
      outputContract: contract.output,
      invocation: 'not_configured',
    },
  };
}

/**
 * Apply an override without copying arbitrary fields (especially secret
 * values) into the registry. Unknown non-sensitive fields are intentionally
 * ignored at construction time; a parsed external registry is still checked
 * by validateAgentRegistry.
 */
function applyOverride(
  base: AgentRuntimeConfig,
  override: unknown,
): AgentRuntimeConfig {
  if (!isRecord(override)) return base;
  const result: AgentRuntimeConfig = { ...base };
  const scalarKeys = [
    'name',
    'provider',
    'model',
    'enabled',
    'status',
    'timeoutMs',
    'promptVersion',
  ] as const;
  for (const key of scalarKeys) {
    if (hasOwn(override, key))
      (result as unknown as Record<string, unknown>)[key] = override[key];
  }
  if (hasOwn(override, 'secretRef'))
    result.secretRef = copySecretRef(override.secretRef, base.secretRef);
  if (isRecord(override.retry))
    result.retry = {
      ...base.retry,
      ...override.retry,
    } as AgentRuntimeConfig['retry'];
  if (isRecord(override.quota))
    result.quota = {
      ...base.quota,
      ...override.quota,
    } as AgentRuntimeConfig['quota'];
  if (hasOwn(override, 'verification'))
    result.verification = copyVerification(
      override.verification,
      base.verification,
    );
  if (isRecord(override.audit))
    result.audit = {
      ...base.audit,
      ...override.audit,
    } as AgentRuntimeConfig['audit'];
  if (hasOwn(override, 'capability'))
    result.capability = copyCapability(override.capability, base.capability);
  // role and contract metadata are owned by ROLE_CONTRACTS and cannot drift.
  return { ...result, role: base.role, ...contractMetadata(base.role) };
}

export function createAgentRegistry(
  options: AgentRegistryOptions = {},
): AgentRegistry {
  const timestamp = nowIso(options.now);
  const environment = options.environment || process.env;
  const agents = {} as Record<AgentRole, AgentRuntimeConfig>;
  for (const role of AGENT_ROLES) {
    agents[role] = applyOverride(
      defaults(role, timestamp, environment),
      options.overrides?.[role],
    );
  }
  return { version: '1.0', generatedAt: timestamp, agents };
}

function secretRefKind(ref: unknown): SecretRef['kind'] {
  return isRecord(ref) && ref.kind === 'secret_manager'
    ? 'secret_manager'
    : 'env';
}

/** Validate reference metadata without ever resolving or returning a secret. */
export function isValidSecretRef(ref: unknown): ref is SecretRef {
  if (!isRecord(ref)) return false;
  if (ref.kind === 'env') {
    return (
      typeof ref.name === 'string' && ENV_SECRET_NAME_PATTERN.test(ref.name)
    );
  }
  if (ref.kind !== 'secret_manager') return false;
  if (
    typeof ref.name !== 'string' ||
    !SECRET_MANAGER_NAME_PATTERN.test(ref.name)
  )
    return false;
  if (
    ref.key !== undefined &&
    (typeof ref.key !== 'string' || !SECRET_COMPONENT_PATTERN.test(ref.key))
  )
    return false;
  if (
    ref.version !== undefined &&
    (typeof ref.version !== 'string' ||
      !SECRET_COMPONENT_PATTERN.test(ref.version))
  )
    return false;
  return true;
}

export function resolveSecret(
  ref: SecretRef,
  options: SecretResolverOptions = {},
): SecretResolution {
  if (!isValidSecretRef(ref)) {
    return {
      ok: false,
      source: secretRefKind(ref),
      reason: 'Invalid secret reference',
    };
  }
  try {
    if (ref.kind === 'env') {
      const value = (options.environment || process.env)[ref.name];
      return typeof value === 'string' && value.trim().length > 0
        ? { ok: true, source: 'env', value }
        : {
            ok: false,
            source: 'env',
            reason: `Missing environment secret: ${ref.name}`,
          };
    }
    const value = options.secretManager?.(ref);
    return typeof value === 'string' && value.trim().length > 0
      ? { ok: true, source: 'secret_manager', value }
      : {
          ok: false,
          source: 'secret_manager',
          reason: `Missing secret-manager reference: ${ref.name}`,
        };
  } catch {
    // Resolver failures are deliberately opaque and never include secret data.
    return { ok: false, source: ref.kind, reason: 'Secret resolution failed' };
  }
}

function containsSensitiveKey(
  value: unknown,
  path: string,
  seen = new Set<object>(),
): string | null {
  if (!isRecord(value) && !Array.isArray(value)) return null;
  if (typeof value === 'object' && value !== null) {
    if (seen.has(value)) return null;
    seen.add(value);
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = containsSensitiveKey(
        value[index],
        `${path}[${index}]`,
        seen,
      );
      if (found) return found;
    }
    return null;
  }
  for (const [key, child] of Object.entries(value)) {
    const childPath = path ? `${path}.${key}` : key;
    if (SENSITIVE_KEY_PATTERN.test(key) && key !== 'secretRef')
      return childPath;
    const found = containsSensitiveKey(child, childPath, seen);
    if (found) return found;
  }
  return null;
}

function validateSecretReference(
  ref: unknown,
  path: string,
  errors: AgentConfigDiagnostic[],
): ref is SecretRef {
  if (!isRecord(ref)) {
    add(errors, path, 'invalid_type', 'Secret reference must be an object');
    return false;
  }
  const sensitive = Object.keys(ref).find(
    (key) =>
      SENSITIVE_KEY_PATTERN.test(key) &&
      key !== 'kind' &&
      key !== 'name' &&
      key !== 'key' &&
      key !== 'version',
  );
  if (sensitive)
    add(
      errors,
      `${path}.${sensitive}`,
      'unsafe_secret',
      'Secret values must not be stored in registry metadata',
    );
  if (ref.kind !== 'env' && ref.kind !== 'secret_manager') {
    add(
      errors,
      `${path}.kind`,
      'unsafe_secret',
      'Secret references must use env or secret_manager',
    );
    return false;
  }
  if (!isValidSecretRef(ref)) {
    add(
      errors,
      path,
      'invalid_value',
      ref.kind === 'env'
        ? 'Environment secret name must be a non-empty identifier'
        : 'Secret-manager reference name/key/version has an invalid format',
    );
    return false;
  }
  return true;
}

function validateVerification(
  verification: unknown,
  path: string,
  errors: AgentConfigDiagnostic[],
): verification is AgentVerification {
  if (!isRecord(verification)) {
    add(
      errors,
      path,
      'invalid_type',
      'Verification metadata must be an object',
    );
    return false;
  }
  if (
    !VERIFICATION_STATUS_VALUES.includes(
      verification.status as AgentVerificationStatus,
    )
  ) {
    add(
      errors,
      `${path}.status`,
      'invalid_value',
      'Unknown verification status',
    );
  }
  if (verification.verifiedAt !== null && !isIsoDate(verification.verifiedAt)) {
    add(
      errors,
      `${path}.verifiedAt`,
      'invalid_date',
      'verifiedAt must be an ISO-8601 UTC date or null',
    );
  }
  if (
    verification.verifier !== null &&
    !nonEmptyString(verification.verifier)
  ) {
    add(
      errors,
      `${path}.verifier`,
      'invalid_value',
      'Verifier must be non-empty when provided',
    );
  }
  if (
    !Array.isArray(verification.evidence) ||
    verification.evidence.some((item) => !nonEmptyString(item))
  ) {
    add(
      errors,
      `${path}.evidence`,
      'invalid_value',
      'Verification evidence must be a non-empty string array',
    );
  }
  return true;
}

function validateAgent(
  role: AgentRole,
  agent: unknown,
  path: string,
  options: SecretResolverOptions,
  errors: AgentConfigDiagnostic[],
  warnings: AgentConfigDiagnostic[],
  seenIds: Set<string>,
): void {
  if (!isRecord(agent)) {
    add(errors, path, 'invalid_type', 'Agent configuration must be an object');
    return;
  }
  const sensitivePath = containsSensitiveKey(agent, path);
  if (sensitivePath)
    add(
      errors,
      sensitivePath,
      'unsafe_secret',
      'Secret values must not be stored in registry metadata',
    );

  const expected = contractMetadata(role);
  const contract = ROLE_CONTRACTS[role];
  const id = agent.id;
  if (
    !nonEmptyString(id) ||
    id.length > REGISTRY_LIMITS.id ||
    !ID_PATTERN.test(id) ||
    id !== `agent_${role}`
  ) {
    add(
      errors,
      `${path}.id`,
      'invalid_identifier',
      `Agent id must be agent_${role}`,
    );
  }
  if (typeof id === 'string') {
    if (seenIds.has(id))
      add(errors, `${path}.id`, 'duplicate_role', 'Duplicate agent id');
    seenIds.add(id);
  }
  if (agent.role !== role) {
    const code =
      typeof agent.role === 'string' && !isPostProcessingRole(agent.role)
        ? 'unknown_role'
        : 'inconsistent_metadata';
    add(errors, `${path}.role`, code, `Agent role must be ${role}`);
  }
  if (
    !nonEmptyString(agent.name) ||
    agent.name.length > REGISTRY_LIMITS.name ||
    agent.name !== role
  ) {
    add(
      errors,
      `${path}.name`,
      'inconsistent_metadata',
      `Agent name must be ${role}`,
    );
  }

  const metadataChecks: Array<[keyof typeof expected, unknown, string]> = [
    ['label', agent.label, 'label'],
    ['stage', agent.stage, 'stage'],
    ['failurePolicy', agent.failurePolicy, 'failurePolicy'],
    ['evidenceRequired', agent.evidenceRequired, 'evidenceRequired'],
  ];
  for (const [key, actual, label] of metadataChecks) {
    if (actual !== expected[key])
      add(
        errors,
        `${path}.${label}`,
        'inconsistent_metadata',
        `${label} does not match the role contract`,
      );
  }
  if (!sameArray(agent.dependsOn, expected.dependsOn)) {
    add(
      errors,
      `${path}.dependsOn`,
      'inconsistent_metadata',
      'Dependencies do not match the role contract',
    );
  }

  if (!isSafeComponent(agent.provider, REGISTRY_LIMITS.provider)) {
    add(
      errors,
      `${path}.provider`,
      nonEmptyString(agent.provider) ? 'invalid_value' : 'required',
      'Provider must be a bounded identifier',
    );
  }
  if (!isSafeComponent(agent.model, REGISTRY_LIMITS.model)) {
    add(
      errors,
      `${path}.model`,
      nonEmptyString(agent.model) ? 'invalid_value' : 'required',
      'Model must be a bounded identifier',
    );
  }
  if (typeof agent.enabled !== 'boolean')
    add(errors, `${path}.enabled`, 'invalid_type', 'Enabled must be boolean');
  if (!AGENT_STATUS_VALUES.includes(agent.status as AgentStatus))
    add(errors, `${path}.status`, 'invalid_value', 'Unknown agent status');

  const timeoutMs =
    typeof agent.timeoutMs === 'number' ? agent.timeoutMs : Number.NaN;
  if (
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > REGISTRY_LIMITS.timeoutMs
  ) {
    add(
      errors,
      `${path}.timeoutMs`,
      'invalid_value',
      `Timeout must be an integer between 1 and ${REGISTRY_LIMITS.timeoutMs} ms`,
    );
  }
  const retry = agent.retry;
  if (!isRecord(retry)) {
    add(
      errors,
      `${path}.retry`,
      'invalid_type',
      'Retry policy must be an object',
    );
  } else {
    const maxAttempts =
      typeof retry.maxAttempts === 'number' ? retry.maxAttempts : Number.NaN;
    const backoffMs =
      typeof retry.backoffMs === 'number' ? retry.backoffMs : Number.NaN;
    const maxBackoffMs =
      typeof retry.maxBackoffMs === 'number' ? retry.maxBackoffMs : Number.NaN;
    if (
      !Number.isInteger(maxAttempts) ||
      maxAttempts < 1 ||
      maxAttempts > REGISTRY_LIMITS.retryAttempts
    ) {
      add(
        errors,
        `${path}.retry.maxAttempts`,
        'invalid_value',
        `maxAttempts must be an integer from 1 to ${REGISTRY_LIMITS.retryAttempts}`,
      );
    }
    if (
      !Number.isInteger(backoffMs) ||
      backoffMs < 0 ||
      backoffMs > REGISTRY_LIMITS.retryBackoffMs
    ) {
      add(
        errors,
        `${path}.retry.backoffMs`,
        'invalid_value',
        'backoffMs is outside the permitted range',
      );
    }
    if (
      !Number.isInteger(maxBackoffMs) ||
      maxBackoffMs < 0 ||
      maxBackoffMs > REGISTRY_LIMITS.retryBackoffMs ||
      maxBackoffMs < backoffMs
    ) {
      add(
        errors,
        `${path}.retry.maxBackoffMs`,
        'invalid_value',
        'maxBackoffMs must bound backoffMs and stay within the permitted range',
      );
    }
  }

  const quota = agent.quota;
  if (!isRecord(quota)) {
    add(
      errors,
      `${path}.quota`,
      'invalid_type',
      'Quota policy must be an object',
    );
  } else {
    const quotaLimits: Record<'daily' | 'perMinute' | 'concurrent', number> = {
      daily: REGISTRY_LIMITS.dailyQuota,
      perMinute: REGISTRY_LIMITS.perMinuteQuota,
      concurrent: REGISTRY_LIMITS.concurrentQuota,
    };
    for (const key of ['daily', 'perMinute', 'concurrent'] as const) {
      const value = quota[key];
      if (
        value !== null &&
        (typeof value !== 'number' ||
          !Number.isInteger(value) ||
          value < 0 ||
          value > quotaLimits[key])
      ) {
        add(
          errors,
          `${path}.quota.${key}`,
          'invalid_value',
          `${key} must be null or a bounded non-negative integer`,
        );
      }
    }
  }
  if (
    typeof agent.promptVersion !== 'string' ||
    agent.promptVersion.length > REGISTRY_LIMITS.promptVersion ||
    !PROMPT_VERSION_PATTERN.test(agent.promptVersion)
  ) {
    add(
      errors,
      `${path}.promptVersion`,
      'invalid_value',
      'Prompt version must look like v1, v1.2, or v1.2.3',
    );
  }

  const validRef = validateSecretReference(
    agent.secretRef,
    `${path}.secretRef`,
    errors,
  );
  const verificationValid = validateVerification(
    agent.verification,
    `${path}.verification`,
    errors,
  );
  const verification =
    verificationValid && isRecord(agent.verification)
      ? agent.verification
      : null;
  const enabled = agent.enabled === true;
  const status = agent.status as AgentStatus;
  const verificationReady = Boolean(
    verification &&
    verification.status === 'verified' &&
    isIsoDate(verification.verifiedAt) &&
    nonEmptyString(verification.verifier) &&
    Array.isArray(verification.evidence) &&
    verification.evidence.length > 0 &&
    verification.evidence.every((item) => nonEmptyString(item)),
  );
  if (enabled && status === 'disabled')
    add(
      errors,
      `${path}.status`,
      'inconsistent_status',
      'Enabled agents cannot have disabled status',
    );
  if (enabled && status !== 'active' && status !== 'disabled') {
    warn(
      warnings,
      `${path}.status`,
      'inconsistent_status',
      'Agent is registered but not callable until status is active and verified',
    );
  }
  if (!enabled && status !== 'disabled')
    add(
      errors,
      `${path}.status`,
      'inconsistent_status',
      'Disabled agents must have disabled status',
    );
  if (status === 'active' && !verificationReady)
    add(
      errors,
      `${path}.verification`,
      'inconsistent_status',
      'Active agents require verified status, timestamp, verifier, and evidence',
    );
  if (
    enabled &&
    validRef &&
    isValidSecretRef(agent.secretRef) &&
    !resolveSecret(agent.secretRef, options).ok
  ) {
    add(
      errors,
      `${path}.secretRef`,
      'required',
      'Enabled agents require a resolvable credential',
    );
  }

  const capability = agent.capability;
  if (!isRecord(capability)) {
    add(
      errors,
      `${path}.capability`,
      'invalid_type',
      'Capability binding must be an object',
    );
  } else {
    if (capability.inputContract !== contract.input)
      add(
        errors,
        `${path}.capability.inputContract`,
        'inconsistent_metadata',
        'Input contract does not match the role contract',
      );
    if (capability.outputContract !== contract.output)
      add(
        errors,
        `${path}.capability.outputContract`,
        'inconsistent_metadata',
        'Output contract does not match the role contract',
      );
    if (
      !['not_configured', 'adapter_only', 'available'].includes(
        capability.invocation as string,
      )
    ) {
      add(
        errors,
        `${path}.capability.invocation`,
        'invalid_capability',
        'Unknown capability invocation mode',
      );
    }
    const hasId = nonEmptyString(capability.capabilityId);
    const hasAction = nonEmptyString(capability.action);
    if (
      capability.invocation === 'not_configured' &&
      (capability.capabilityId !== null || capability.action !== null)
    ) {
      add(
        errors,
        `${path}.capability`,
        'invalid_capability',
        'Unconfigured capabilities must not declare an id or action',
      );
    }
    if (capability.invocation !== 'not_configured') {
      if (!hasId || !isSafeComponent(capability.capabilityId, 128))
        add(
          errors,
          `${path}.capability.capabilityId`,
          'invalid_capability',
          'Configured capabilities require a bounded capability id',
        );
      if (!hasAction || !isSafeComponent(capability.action, 128))
        add(
          errors,
          `${path}.capability.action`,
          'invalid_capability',
          'Configured capabilities require a bounded action',
        );
    }
  }

  const audit = agent.audit;
  if (!isRecord(audit)) {
    add(
      errors,
      `${path}.audit`,
      'invalid_type',
      'Audit metadata must be an object',
    );
  } else {
    for (const key of ['createdAt', 'updatedAt'] as const) {
      if (!isIsoDate(audit[key]))
        add(
          errors,
          `${path}.audit.${key}`,
          'invalid_date',
          `${key} must be an ISO-8601 UTC date`,
        );
    }
    for (const key of [
      'createdBy',
      'updatedBy',
      'changeId',
      'changeReason',
      'source',
    ] as const) {
      if (!nonEmptyString(audit[key]))
        add(errors, `${path}.audit.${key}`, 'required', `${key} is required`);
    }
  }
}

export function validateAgentRegistry(
  registry: AgentRegistry,
  options: SecretResolverOptions = {},
): AgentConfigValidation {
  const errors: AgentConfigDiagnostic[] = [];
  const warnings: AgentConfigDiagnostic[] = [];
  const root = registry as unknown as Record<string, unknown>;
  if (!isRecord(root))
    return {
      valid: false,
      errors: [
        diagnostic('registry', 'invalid_type', 'Registry must be an object'),
      ],
      warnings,
    };
  if (root.version !== '1.0')
    add(errors, 'version', 'invalid_value', 'Registry version must be 1.0');
  if (!isIsoDate(root.generatedAt))
    add(
      errors,
      'generatedAt',
      'invalid_date',
      'generatedAt must be an ISO-8601 UTC date',
    );
  const agents = root.agents;
  if (!isRecord(agents)) {
    add(errors, 'agents', 'invalid_type', 'agents must be an object');
    return { valid: false, errors, warnings };
  }
  const expectedRoles = new Set<string>(AGENT_ROLES);
  for (const key of Object.keys(agents)) {
    if (!expectedRoles.has(key))
      add(
        errors,
        `agents.${key}`,
        'unknown_role',
        'Unknown or extra agent role',
      );
  }
  const seenIds = new Set<string>();
  for (const role of AGENT_ROLES) {
    const path = `agents.${role}`;
    if (!hasOwn(agents, role)) {
      add(errors, path, 'required', 'Agent configuration is required');
      continue;
    }
    validateAgent(role, agents[role], path, options, errors, warnings, seenIds);
  }
  return { valid: errors.length === 0, errors, warnings };
}

export type InvocationBlock =
  'enabled' | 'status' | 'verification' | 'credential' | 'adapter';

export interface CapabilityInvocationPlan {
  role: AgentRole;
  provider: string;
  model: string;
  capabilityId: string | null;
  action: string | null;
  /** Kept as a literal false: this function only builds metadata. */
  invokesExternalProvider: false;
  gates: AgentInvocationGates;
  allowed: boolean;
  callable: boolean;
  canInvoke: boolean;
  blockedBy: InvocationBlock[];
  credentialRequired: true;
  verificationRequired: true;
  enabledRequired: true;
  adapterKind: 'local_contract' | 'miaoda' | 'external';
  reason: string;
}

function adapterFor(options: AgentInvocationOptions): AgentCapabilityAdapters {
  return {
    ...(options.adapters || {}),
    ...(options.miaoda ? { miaoda: options.miaoda } : {}),
    ...(options.external ? { external: options.external } : {}),
  };
}

export function getAgentInvocationGates(
  agent: AgentRuntimeConfig,
  options: AgentInvocationOptions = {},
): AgentInvocationGates {
  const enabled = agent.enabled === true;
  const status = agent.status === 'active';
  const verification =
    agent.verification?.status === 'verified' &&
    isIsoDate(agent.verification.verifiedAt) &&
    nonEmptyString(agent.verification.verifier) &&
    Array.isArray(agent.verification.evidence) &&
    agent.verification.evidence.length > 0 &&
    agent.verification.evidence.every((item) => nonEmptyString(item));
  const adapters = adapterFor(options);
  let adapter = true;
  if (agent.capability?.invocation !== 'not_configured') {
    adapter =
      nonEmptyString(agent.capability?.capabilityId) &&
      nonEmptyString(agent.capability?.action) &&
      Boolean(adapters.miaoda) &&
      typeof adapters.miaoda?.load === 'function';
  } else if (agent.provider !== 'contract-local') {
    adapter =
      Boolean(adapters.external) &&
      typeof adapters.external?.invoke === 'function';
  }
  // Resolve credentials last: blocked status/verification/adapter must not touch secret stores.
  const credential =
    enabled && status && verification && adapter
      ? isValidSecretRef(agent.secretRef) &&
        resolveSecret(agent.secretRef, options).ok
      : false;
  return {
    enabled,
    status,
    verification,
    credential,
    adapter,
    allowed: enabled && status && verification && credential && adapter,
  };
}

export function buildCapabilityInvocationPlan(
  agent: AgentRuntimeConfig,
  options: AgentInvocationOptions = {},
): CapabilityInvocationPlan {
  const gates = getAgentInvocationGates(agent, options);
  const blockedBy: InvocationBlock[] = [];
  if (!gates.enabled) blockedBy.push('enabled');
  if (!gates.status) blockedBy.push('status');
  if (!gates.verification) blockedBy.push('verification');
  if (!gates.credential) blockedBy.push('credential');
  if (!gates.adapter) blockedBy.push('adapter');
  const adapterKind: CapabilityInvocationPlan['adapterKind'] =
    agent.capability?.invocation !== 'not_configured'
      ? 'miaoda'
      : agent.provider === 'contract-local'
        ? 'local_contract'
        : 'external';
  return {
    role: agent.role,
    provider: agent.provider,
    model: agent.model,
    capabilityId: agent.capability?.capabilityId ?? null,
    action: agent.capability?.action ?? null,
    invokesExternalProvider: false,
    gates,
    allowed: gates.allowed,
    callable: gates.allowed,
    canInvoke: gates.allowed,
    blockedBy,
    credentialRequired: true,
    verificationRequired: true,
    enabledRequired: true,
    adapterKind,
    reason:
      blockedBy.length > 0
        ? `Invocation blocked by: ${blockedBy.join(', ')}`
        : 'Invocation is authorized by registry gates; the host adapter owns execution',
  };
}

/** Redact sensitive keys before persisting or emitting registry diagnostics. */
export function redactAgentRegistry(value: unknown): unknown {
  const seen = new WeakSet<object>();
  const redact = (input: unknown, key?: string): unknown => {
    if (key && SENSITIVE_KEY_PATTERN.test(key) && key !== 'kind')
      return '[REDACTED]';
    if (Array.isArray(input)) return input.map((item) => redact(item));
    if (!isRecord(input)) return input;
    if (seen.has(input)) return '[CIRCULAR]';
    seen.add(input);
    const output: Record<string, unknown> = {};
    for (const [childKey, child] of Object.entries(input))
      output[childKey] = redact(child, childKey);
    return output;
  };
  return redact(value);
}

export function serializeAgentRegistry(registry: AgentRegistry): string {
  return JSON.stringify(redactAgentRegistry(registry));
}

export const safeSerializeAgentRegistry = serializeAgentRegistry;
