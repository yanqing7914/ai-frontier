import {
  getAgentInvocationGates,
  isValidSecretRef,
  type AgentInvocationOptions,
} from './registry';
import type {
  AgentCapabilityAdapters,
  AgentInvocationRequest,
  AgentInvocationResult,
  ExternalProviderRequest,
  CapabilityExecutor,
  AgentRegistry,
  AgentRole,
  AgentRuntimeConfig,
  SecretResolution,
  SecretRef,
} from './types';
import { AGENT_ROLES } from './types';

/** Stable, non-provider error codes exposed by the invocation boundary. */
export const AGENT_GATEWAY_ERROR_CODES = Object.freeze({
  disabled: 'AGENT_DISABLED',
  status_not_active: 'AGENT_STATUS_NOT_ACTIVE',
  verification_required: 'AGENT_VERIFICATION_REQUIRED',
  credential_required: 'AGENT_CREDENTIAL_REQUIRED',
  adapter_required: 'AGENT_ADAPTER_REQUIRED',
  invalid_capability: 'AGENT_INVALID_CAPABILITY',
  invocation_failed: 'AGENT_INVOCATION_FAILED',
} as const);

export type AgentGatewayErrorCode =
  (typeof AGENT_GATEWAY_ERROR_CODES)[keyof typeof AGENT_GATEWAY_ERROR_CODES];

export type AgentGatewayBlockCode = AgentInvocationResult extends infer Result
  ? Result extends { ok: false; code: infer Code }
    ? Code
    : never
  : never;

export interface AgentGatewaySuccess {
  ok: true;
  role: AgentRole;
  /** A stable status intentionally contains no provider details. */
  status: 'completed';
  authorized: true;
  output: unknown;
}

export interface AgentGatewayFailure {
  ok: false;
  role: AgentRole;
  /** Gate failures are blocked; adapter/provider failures are failed. */
  status: 'blocked' | 'failed';
  code: AgentGatewayBlockCode;
  /** A stable public code; raw adapter/resolver errors are never returned. */
  errorCode: AgentGatewayErrorCode;
  reason: string;
  blockedBy?: 'enabled' | 'status' | 'verification' | 'credential' | 'adapter';
}

export type AgentGatewayResult = AgentGatewaySuccess | AgentGatewayFailure;
export type GatewayResult = AgentGatewayResult;
export type InvocationGatewayResult = AgentGatewayResult;
export type AgentInvocationGatewayResult = AgentGatewayResult;

export interface AgentGatewayRequest extends AgentInvocationRequest {
  role: AgentRole;
}

export type AgentGatewayHandler = (
  input: unknown,
  context?: unknown,
) => unknown | Promise<unknown>;

/**
 * Options accepted by the gateway. The aliases keep this seam convenient for
 * Hosts can provide a capability adapter or an external provider.
 */
export interface AgentGatewayOptions extends AgentInvocationOptions {
  /** Compatibility switch for legacy direct capability consumers. */
  omitUndefinedContext?: boolean;
  /** Local contract handlers are optional; external/Capability adapters are preferred. */
  handlers?: Partial<Record<AgentRole, AgentGatewayHandler>>;
  local?: Partial<Record<AgentRole, AgentGatewayHandler>>;
  /** Either an adapter container or a single load/invoke adapter. */
  adapter?: AgentCapabilityAdapters | AgentGatewayAdapter;
  capabilityService?: AgentCapabilityAdapters['capability'];
  externalProvider?: AgentCapabilityAdapters['external'];
  /** Optional host resolver hook. It is called only after static gates pass. */
  resolver?: (
    ref: SecretRef,
  ) =>
    | boolean
    | string
    | SecretResolution
    | undefined
    | Promise<boolean | string | SecretResolution | undefined>;
  secretResolver?: (
    ref: SecretRef,
  ) =>
    | boolean
    | string
    | SecretResolution
    | undefined
    | Promise<boolean | string | SecretResolution | undefined>;
}

export type InvocationGatewayOptions = AgentGatewayOptions;
export type AgentInvocationGatewayOptions = AgentGatewayOptions;

/** Structural single-adapter form accepted by the compatibility seam. */
export interface AgentGatewayAdapter {
  load?: (capabilityId: string) => CapabilityExecutor;
  invoke?: (request: ExternalProviderRequest) => Promise<unknown>;
}

const SAFE_REASON: Record<AgentGatewayBlockCode, string> = {
  disabled: 'Agent is disabled',
  status_not_active: 'Agent status is not active',
  verification_required: 'Agent verification is required',
  credential_required: 'Agent credential is unavailable',
  adapter_required: 'Agent adapter is unavailable',
  invalid_capability: 'Agent capability configuration is invalid',
  invocation_failed: 'Agent invocation failed',
};

const GATE_ERROR_CODE: Record<AgentGatewayBlockCode, AgentGatewayErrorCode> = {
  disabled: AGENT_GATEWAY_ERROR_CODES.disabled,
  status_not_active: AGENT_GATEWAY_ERROR_CODES.status_not_active,
  verification_required: AGENT_GATEWAY_ERROR_CODES.verification_required,
  credential_required: AGENT_GATEWAY_ERROR_CODES.credential_required,
  adapter_required: AGENT_GATEWAY_ERROR_CODES.adapter_required,
  invalid_capability: AGENT_GATEWAY_ERROR_CODES.invalid_capability,
  invocation_failed: AGENT_GATEWAY_ERROR_CODES.invocation_failed,
};

const ROLE_SET = new Set<string>(AGENT_ROLES);
const CAPABILITY_MODES = new Set([
  'not_configured',
  'adapter_only',
  'available',
]);
const SENSITIVE_KEY =
  /(?:secret|token|password|credential|authorization|api[_.-]?key)/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwn(value: unknown, key: string): boolean {
  return isRecord(value) && Object.prototype.hasOwnProperty.call(value, key);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function stableRole(value: unknown): AgentRole {
  // Runtime callers can still pass untrusted strings despite the TypeScript
  // type. Keep the public result shape stable without echoing that string.
  return typeof value === 'string' && ROLE_SET.has(value)
    ? (value as AgentRole)
    : AGENT_ROLES[0];
}

function normalizeAdapters(
  options: AgentGatewayOptions,
): AgentCapabilityAdapters {
  const direct = options.adapter;
  const directRecord = isRecord(direct) ? direct : undefined;
  const directLoad = directRecord?.load;
  const directInvoke = directRecord?.invoke;
  const directCapability =
    typeof directLoad === 'function'
      ? {
          load: (capabilityId: string) =>
            (directLoad as (id: string) => CapabilityExecutor).call(
              directRecord,
              capabilityId,
            ),
        }
      : undefined;
  const directExternal =
    typeof directInvoke === 'function'
      ? {
          invoke: (request: ExternalProviderRequest) =>
            (
              directInvoke as (
                value: ExternalProviderRequest,
              ) => Promise<unknown>
            ).call(directRecord, request),
        }
      : undefined;
  const container =
    directRecord &&
    (isRecord(directRecord.capability) || isRecord(directRecord.external))
      ? {
          ...(isRecord(directRecord.capability)
            ? {
                capability:
                  directRecord.capability as unknown as AgentCapabilityAdapters['capability'],
              }
            : {}),
          ...(isRecord(directRecord.external)
            ? {
                external:
                  directRecord.external as unknown as AgentCapabilityAdapters['external'],
              }
            : {}),
        }
      : {};
  return {
    ...container,
    ...(options.adapters || {}),
    ...(directCapability ? { capability: directCapability } : {}),
    ...(directExternal ? { external: directExternal } : {}),
    ...(options.capabilityService ? { capability: options.capabilityService } : {}),
    ...(options.externalProvider ? { external: options.externalProvider } : {}),
    ...(options.capability ? { capability: options.capability } : {}),
    ...(options.external ? { external: options.external } : {}),
  };
}

function normalizedInvocationOptions(
  options: AgentGatewayOptions,
): AgentInvocationOptions {
  const adapters = normalizeAdapters(options);
  return {
    environment: options.environment,
    secretManager: options.secretManager,
    adapters,
    capability: adapters.capability,
    external: adapters.external,
  };
}

/** Do not pass resolver-bearing options to the first (static) gate pass. */
function staticInvocationOptions(
  options: AgentGatewayOptions,
): AgentInvocationOptions {
  const adapters = normalizeAdapters(options);
  return {
    // An empty environment prevents an accidental process.env lookup during
    // the static pass while preserving the adapter shape checks.
    environment: {},
    adapters,
    capability: adapters.capability,
    external: adapters.external,
  };
}

/**
 * Keep the registry gate as the single source of truth for non-credential
 * checks while making the first pass incapable of resolving a secret. An
 * invalid reference short-circuits `getAgentInvocationGates`' credential leg.
 */
function staticGateAgent(agent: AgentRuntimeConfig): AgentRuntimeConfig {
  return {
    ...agent,
    secretRef: { kind: 'env', name: '' },
  };
}

function normalizeRequest(
  request: AgentInvocationRequest | unknown,
  context?: unknown,
): AgentInvocationRequest {
  if (isRecord(request) && hasOwn(request, 'input')) {
    return {
      input: request.input,
      context: hasOwn(request, 'context') ? request.context : context,
    };
  }
  return { input: request, context };
}

function failure(
  role: AgentRole,
  code: AgentGatewayBlockCode,
  status: AgentGatewayFailure['status'] = 'blocked',
  blockedBy?: AgentGatewayFailure['blockedBy'],
): AgentGatewayFailure {
  return {
    ok: false,
    role,
    status,
    code,
    errorCode: GATE_ERROR_CODE[code],
    reason: SAFE_REASON[code],
    ...(blockedBy ? { blockedBy } : {}),
  };
}

function safeOutput(
  value: unknown,
  seen = new WeakSet<object>(),
  key?: string,
): unknown {
  if (key && SENSITIVE_KEY.test(key)) return '[REDACTED]';
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) {
    if (seen.has(value)) return '[CIRCULAR]';
    seen.add(value);
    return value.map((item) => safeOutput(item, seen));
  }
  if (!isRecord(value)) return value;
  if (seen.has(value)) return '[CIRCULAR]';
  seen.add(value);
  const result: Record<string, unknown> = {};
  for (const [childKey, child] of Object.entries(value)) {
    result[childKey] = safeOutput(child, seen, childKey);
  }
  return result;
}

function capabilityBlock(
  agent: AgentRuntimeConfig,
): AgentGatewayBlockCode | null {
  const capability = agent.capability;
  const mode = capability?.invocation as string | undefined;
  if (!CAPABILITY_MODES.has(mode || '')) return 'invalid_capability';
  if (mode === 'adapter_only') return 'adapter_required';
  if (
    mode === 'available' &&
    (!nonEmpty(capability?.capabilityId) || !nonEmpty(capability?.action))
  ) {
    return 'invalid_capability';
  }
  if (
    mode === 'not_configured' &&
    (capability?.capabilityId !== null || capability?.action !== null)
  ) {
    return 'invalid_capability';
  }
  return null;
}

function localHandler(
  options: AgentGatewayOptions,
  role: AgentRole,
): AgentGatewayHandler | undefined {
  const preferred = options.handlers?.[role];
  if (typeof preferred === 'function') return preferred;
  const fallback = options.local?.[role];
  return typeof fallback === 'function' ? fallback : undefined;
}

/**
 * The local handler is an execution adapter too. Check it before resolving a
 * credential so a missing adapter cannot cause an unnecessary secret lookup.
 */
function hasExecutionAdapter(
  agent: AgentRuntimeConfig,
  options: AgentGatewayOptions,
): boolean {
  const mode = agent.capability?.invocation;
  if (mode === 'available') return true; // structural check is delegated to gates
  if (agent.provider !== 'contract-local') {
    const external = normalizeAdapters(options).external;
    return Boolean(external && typeof external.invoke === 'function');
  }
  return typeof localHandler(options, agent.role) === 'function';
}

async function resolveWithHostResolver(
  ref: SecretRef,
  options: AgentGatewayOptions,
): Promise<boolean | null> {
  const resolver = options.resolver || options.secretResolver;
  if (!resolver) return null;
  try {
    const resolved = await resolver(ref);
    if (typeof resolved === 'string') return resolved.trim().length > 0;
    // SecretResolution.value is deliberately optional: a host may confirm
    // authorization without handing the gateway the secret itself.
    if (isRecord(resolved)) {
      if (resolved.ok !== true) return false;
      // An omitted value represents an opaque authorization decision. If a
      // host does provide `value`, require it to be a non-empty string.
      if (!hasOwn(resolved, 'value')) return true;
      return (
        typeof resolved.value === 'string' && resolved.value.trim().length > 0
      );
    }
    // Keep the host seam permissive for simple boolean authorization hooks.
    if (typeof resolved === 'boolean') return resolved;
    return false;
  } catch {
    return false;
  }
}

async function authorizedAfterCredential(
  agent: AgentRuntimeConfig,
  staticGates: ReturnType<typeof getAgentInvocationGates>,
  options: AgentGatewayOptions,
): Promise<boolean> {
  const customCredential = await resolveWithHostResolver(
    agent.secretRef,
    options,
  );
  if (customCredential !== null) return customCredential;
  const gates = getAgentInvocationGates(
    agent,
    normalizedInvocationOptions(options),
  );
  return (
    staticGates.enabled &&
    staticGates.status &&
    staticGates.verification &&
    staticGates.adapter &&
    gates.credential
  );
}

function timeoutMs(agent: AgentRuntimeConfig): number {
  return Number.isFinite(agent.timeoutMs) && agent.timeoutMs > 0
    ? agent.timeoutMs
    : 1;
}

async function withTimeout<T>(
  value: Promise<T>,
  milliseconds: number,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), milliseconds);
    value.then(
      (result) => {
        clearTimeout(timer);
        resolve(result);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export class AgentGateway {
  constructor(
    private readonly registry: AgentRegistry,
    private readonly options: AgentGatewayOptions = {},
  ) {}

  async invoke(
    role: AgentRole,
    request: AgentInvocationRequest | unknown,
    context?: unknown,
  ): Promise<AgentGatewayResult>;

  async invoke(request: AgentGatewayRequest): Promise<AgentGatewayResult>;

  async invoke(
    roleOrRequest: AgentRole | AgentGatewayRequest,
    request?: AgentInvocationRequest | unknown,
    context?: unknown,
  ): Promise<AgentGatewayResult> {
    const requestEnvelope =
      typeof roleOrRequest === 'string'
        ? { role: roleOrRequest, request: normalizeRequest(request, context) }
        : isRecord(roleOrRequest)
          ? {
              role: roleOrRequest.role,
              request: normalizeRequest(roleOrRequest),
            }
          : { role: undefined, request: normalizeRequest(undefined, context) };
    const role = stableRole(requestEnvelope.role);
    const agent =
      typeof requestEnvelope.role === 'string' &&
      ROLE_SET.has(requestEnvelope.role)
        ? this.registry.agents[role]
        : undefined;

    if (!agent) return failure(role, 'invalid_capability');

    const adapters = normalizeAdapters(this.options);
    const staticGates = getAgentInvocationGates(
      staticGateAgent(agent),
      staticInvocationOptions(this.options),
    );

    // Return before any resolver or adapter execution for every static block.
    if (!staticGates.enabled)
      return failure(role, 'disabled', 'blocked', 'enabled');
    if (!staticGates.status)
      return failure(role, 'status_not_active', 'blocked', 'status');
    if (!staticGates.verification)
      return failure(role, 'verification_required', 'blocked', 'verification');

    const capabilityError = capabilityBlock(agent);
    if (capabilityError) return failure(role, capabilityError);

    if (!staticGates.adapter)
      return failure(role, 'adapter_required', 'blocked', 'adapter');
    if (!hasExecutionAdapter(agent, this.options))
      return failure(role, 'adapter_required', 'blocked', 'adapter');

    // Invalid references are a static credential block too. Do not hand an
    // untrusted reference to a host resolver merely to discover that fact.
    if (!isValidSecretRef(agent.secretRef))
      return failure(role, 'credential_required', 'blocked', 'credential');

    // Credential resolution is deliberately after static gates and before load/call.
    if (!(await authorizedAfterCredential(agent, staticGates, this.options))) {
      return failure(role, 'credential_required', 'blocked', 'credential');
    }

    try {
      const input = requestEnvelope.request.input;
      const contextValue = requestEnvelope.request.context;
      let output: unknown;
      if (agent.capability.invocation === 'available') {
        const capability = adapters.capability;
        const capabilityId = agent.capability.capabilityId!;
        const action = agent.capability.action!;
        // getAgentInvocationGates only inspected the adapter shape. This is
        // the first point at which the host capability is loaded and called.
        const executor = capability!.load(capabilityId);
        if (!executor || typeof executor.call !== 'function') {
          return failure(role, 'adapter_required', 'failed', 'adapter');
        }
        // The scoring capability historically accepts a two-argument call;
        // preserve that adapter contract while retaining the explicit context
        // slot for other capability integrations.
        const result =
          this.options.omitUndefinedContext && contextValue === undefined
            ? executor.call(action, input)
            : executor.call(action, input, contextValue);
        output = await withTimeout(Promise.resolve(result), timeoutMs(agent));
      } else if (agent.provider !== 'contract-local') {
        const external = adapters.external!;
        output = await withTimeout(
          Promise.resolve(
            external.invoke({
              provider: agent.provider,
              model: agent.model,
              input,
              timeoutMs: timeoutMs(agent),
              promptVersion: agent.promptVersion,
            }),
          ),
          timeoutMs(agent),
        );
      } else {
        const handler = localHandler(this.options, role)!;
        output = await withTimeout(
          Promise.resolve(handler(input, contextValue)),
          timeoutMs(agent),
        );
      }
      return {
        ok: true,
        role,
        status: 'completed',
        authorized: true,
        output: safeOutput(output),
      };
    } catch {
      // Provider and resolver details are intentionally not reflected in the
      // result. Callers can use the stable code for metrics and retries.
      return failure(role, 'invocation_failed', 'failed');
    }
  }

  async call(
    role: AgentRole,
    request: AgentInvocationRequest | unknown,
    context?: unknown,
  ): Promise<AgentGatewayResult>;

  async call(request: AgentGatewayRequest): Promise<AgentGatewayResult>;

  async call(
    roleOrRequest: AgentRole | AgentGatewayRequest,
    request?: AgentInvocationRequest | unknown,
    context?: unknown,
  ): Promise<AgentGatewayResult> {
    if (typeof roleOrRequest === 'string') {
      return this.invoke(roleOrRequest, request, context);
    }
    return this.invoke(roleOrRequest);
  }

  async execute(
    role: AgentRole,
    request: AgentInvocationRequest | unknown,
    context?: unknown,
  ): Promise<AgentGatewayResult>;

  async execute(request: AgentGatewayRequest): Promise<AgentGatewayResult>;

  async execute(
    roleOrRequest: AgentRole | AgentGatewayRequest,
    request?: AgentInvocationRequest | unknown,
    context?: unknown,
  ): Promise<AgentGatewayResult> {
    if (typeof roleOrRequest === 'string') {
      return this.invoke(roleOrRequest, request, context);
    }
    return this.invoke(roleOrRequest);
  }
}

/** Runtime alias for hosts that instantiate the gateway by its longer name. */
export const AgentInvocationGateway = AgentGateway;
export const InvocationGateway = AgentGateway;
export const Gateway = AgentGateway;

export function createAgentGateway(
  registry: AgentRegistry,
  options: AgentGatewayOptions = {},
): AgentGateway {
  return new AgentGateway(registry, options);
}

export async function invokeAgent(
  registry: AgentRegistry,
  role: AgentRole,
  request: AgentInvocationRequest | unknown,
  options: AgentGatewayOptions = {},
  context?: unknown,
): Promise<AgentGatewayResult> {
  return new AgentGateway(registry, options).invoke(role, request, context);
}

export const invokeAgentThroughGateway = invokeAgent;
export const invokeAgentRole = invokeAgent;
export const callAgent = invokeAgent;
export const createAgentInvocationGateway = createAgentGateway;
export const createInvocationGateway = createAgentGateway;

export default AgentGateway;
