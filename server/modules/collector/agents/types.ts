import {
  POST_PROCESSING_ROLES,
  ROLE_CONTRACTS,
  type ContractPipelineStage,
  type FailurePolicy,
  type PostProcessingRole,
} from '../architecture/contracts';

/** The runtime registry is deliberately limited to the eight post-processing roles. */
export const AGENT_ROLES = POST_PROCESSING_ROLES;
export type AgentRole = PostProcessingRole;

export type AgentStatus =
  | 'active'
  | 'disabled'
  | 'degraded'
  | 'unverified'
  | 'pending_verification'
  | 'failed'
  | 'blocked';

export type AgentVerificationStatus =
  'verified' | 'pending' | 'not_run' | 'failed';

export type SecretRef = EnvironmentSecretRef | SecretManagerRef;

/**
 * Secret references are deliberately narrower than arbitrary strings.  The
 * registry stores only these names; a resolved secret is transient and never
 * belongs in an AgentRuntimeConfig.
 */
export const ENV_SECRET_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const SECRET_MANAGER_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
export const SECRET_COMPONENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;

/** A reference is metadata only. It must never contain the secret value. */
export interface EnvironmentSecretRef {
  kind: 'env';
  name: string;
}

/** Secret-manager references identify a record without embedding its value. */
export interface SecretManagerRef {
  kind: 'secret_manager';
  name: string;
  key?: string;
  version?: string;
}

export interface AgentRetryPolicy {
  maxAttempts: number;
  backoffMs: number;
  maxBackoffMs: number;
}

export interface AgentQuotaPolicy {
  /** A null limit means that this registry does not impose that dimension. */
  daily: number | null;
  perMinute: number | null;
  concurrent: number | null;
}

export interface AgentVerification {
  status: AgentVerificationStatus;
  verifiedAt: string | null;
  verifier: string | null;
  evidence: string[];
}

export interface AgentAuditFields {
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  updatedBy: string;
  changeId: string;
  changeReason: string;
  source: 'code' | 'environment' | 'secret_manager' | 'operator';
}

/**
 * This describes an optional capability binding, not an invocation.
 * A missing binding means the local contract processor remains the only path.
 */
export interface CapabilityBinding {
  capabilityId: string | null;
  action: string | null;
  inputContract: string;
  outputContract: string;
  invocation: 'not_configured' | 'adapter_only' | 'available';
}

/** A minimal capability shape. It is an adapter seam, not an
 * implementation and therefore cannot accidentally perform a platform call. */
export interface CapabilityExecutor {
  call(action: string, input: unknown, context?: unknown): Promise<unknown>;
}

export interface CapabilityServiceAdapter {
  load(capabilityId: string): CapabilityExecutor;
}

/** External providers are supplied by the host application. */
export interface ExternalProviderRequest {
  provider: string;
  model: string;
  input: unknown;
  timeoutMs: number;
  promptVersion: string;
}

export interface ExternalProviderAdapter {
  invoke(request: ExternalProviderRequest): Promise<unknown>;
}

export type ExternalApiAdapter = ExternalProviderAdapter;

export interface AgentCapabilityAdapters {
  capability?: CapabilityServiceAdapter;
  external?: ExternalProviderAdapter;
}

export interface AgentInvocationRequest {
  input: unknown;
  context?: unknown;
}

/** Safe execution result returned by adapter integration. It never contains a
 * resolved credential or provider error payload that might include one. */
export type AgentInvocationResult =
  | { ok: true; role: AgentRole; output: unknown }
  | {
      ok: false;
      role: AgentRole;
      code:
        | 'disabled'
        | 'status_not_active'
        | 'verification_required'
        | 'credential_required'
        | 'adapter_required'
        | 'invalid_capability'
        | 'invocation_failed';
      reason: string;
    };

export interface AgentRuntimeConfig {
  /** Stable registry identity; it is not a provider/capability id. */
  id: string;
  role: AgentRole;
  name: string;
  label: string;
  stage: ContractPipelineStage;
  dependsOn: AgentRole[];
  failurePolicy: FailurePolicy;
  evidenceRequired: boolean;
  provider: string;
  model: string;
  secretRef: SecretRef;
  enabled: boolean;
  status: AgentStatus;
  timeoutMs: number;
  retry: AgentRetryPolicy;
  quota: AgentQuotaPolicy;
  promptVersion: string;
  verification: AgentVerification;
  audit: AgentAuditFields;
  capability: CapabilityBinding;
}

export interface AgentRegistry {
  version: '1.0';
  generatedAt: string;
  agents: Readonly<Record<AgentRole, AgentRuntimeConfig>>;
}

export interface AgentConfigDiagnostic {
  path: string;
  code:
    | 'invalid_type'
    | 'required'
    | 'invalid_value'
    | 'unsafe_secret'
    | 'duplicate_role'
    | 'unknown_role'
    | 'inconsistent_status'
    | 'inconsistent_metadata'
    | 'invalid_identifier'
    | 'missing_credential'
    | 'invalid_capability'
    | 'invalid_date';
  message: string;
}

export interface AgentConfigValidation {
  valid: boolean;
  errors: AgentConfigDiagnostic[];
  warnings: AgentConfigDiagnostic[];
}

export interface SecretResolution {
  ok: boolean;
  source: SecretRef['kind'];
  /** This value is transient and must not be copied into registry/config data. */
  value?: string;
  reason?: string;
}

export interface SecretResolverOptions {
  environment?: Record<string, string | undefined>;
  secretManager?: (ref: SecretManagerRef) => string | undefined;
}

export interface AgentInvocationGates {
  /** The config is enabled and has an active runtime status. */
  enabled: boolean;
  /** The runtime status is active (not degraded, blocked, or unverified). */
  status: boolean;
  /** Verification has completed successfully with evidence. */
  verification: boolean;
  /** A resolver found a credential without exposing its value. */
  credential: boolean;
  /** An adapter/local contract path is declared and usable by the host. */
  adapter: boolean;
  /** All gates required for a callable plan are satisfied. */
  allowed: boolean;
}

/** Keep this map in one place so registry/config parsing cannot drift from contracts. */
export function contractMetadata(
  role: AgentRole,
): Pick<
  AgentRuntimeConfig,
  'label' | 'stage' | 'dependsOn' | 'failurePolicy' | 'evidenceRequired'
> {
  const contract = ROLE_CONTRACTS[role];
  return {
    label: contract.label,
    stage: contract.stage,
    dependsOn: [...contract.dependsOn],
    failurePolicy: contract.failurePolicy,
    evidenceRequired: contract.evidenceRequired,
  };
}
