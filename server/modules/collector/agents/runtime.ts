import {
  AGENT_ROLES,
  type AgentRegistry,
  type AgentRole,
  type AgentRuntimeConfig,
  type SecretResolverOptions,
} from './types';
import { getAgentInvocationGates, resolveSecret } from './registry';

export type AgentHandler = (
  input: unknown,
  context: {
    role: AgentRole;
    attempt: number;
    dependencies: Record<string, unknown>;
    /** Credentials are intentionally opaque to handlers and never exposed. */
    secret?: never;
  },
) => unknown | Promise<unknown>;

export interface RuntimeOptions extends SecretResolverOptions {
  handlers: Partial<Record<AgentRole, AgentHandler>>;
  now?: () => number;
}

export interface AgentRunRecord {
  role: AgentRole;
  status: 'completed' | 'skipped' | 'failed' | 'blocked' | 'degraded';
  outcome: 'accepted' | 'rejected' | 'review' | 'degraded' | 'skipped';
  output: unknown;
  attempts: number;
  reason?: string;
}

export interface RuntimeRunResult {
  idempotencyKey: string;
  status: 'completed' | 'degraded' | 'failed';
  records: AgentRunRecord[];
  output: unknown;
}

const sleep = (ms: number): Promise<void> =>
  ms > 0
    ? new Promise<void>((resolve) => setTimeout(resolve, ms))
    : Promise.resolve();

/**
 * Executes injected local contract handlers only after the same gates exposed
 * by the invocation-plan API. The runtime never calls a provider or Miaoda
 * service itself; those remain host-owned adapter responsibilities.
 */
export class AgentRuntime {
  private readonly idempotency = new Map<string, RuntimeRunResult>();
  /** Share an in-flight execution with concurrent callers using the same key. */
  private readonly inFlight = new Map<string, Promise<RuntimeRunResult>>();
  private readonly usage = new Map<
    string,
    {
      minute: number;
      day: number;
      minuteAt: number;
      dayAt: number;
    }
  >();

  constructor(
    private readonly registry: AgentRegistry,
    private readonly options: RuntimeOptions,
  ) {}

  async run(
    input: unknown,
    idempotencyKey = `run_${Date.now()}`,
  ): Promise<RuntimeRunResult> {
    const cached = this.idempotency.get(idempotencyKey);
    if (cached) return cached;

    const pending = this.inFlight.get(idempotencyKey);
    if (pending) return pending;

    const execution = this.runOnce(input, idempotencyKey);
    this.inFlight.set(idempotencyKey, execution);
    try {
      const response = await execution;
      this.idempotency.set(idempotencyKey, response);
      return response;
    } finally {
      if (this.inFlight.get(idempotencyKey) === execution)
        this.inFlight.delete(idempotencyKey);
    }
  }

  private async runOnce(
    input: unknown,
    idempotencyKey: string,
  ): Promise<RuntimeRunResult> {
    const outputs: Record<string, unknown> = {};
    const records: AgentRunRecord[] = [];
    let overall: RuntimeRunResult['status'] = 'completed';

    for (const role of AGENT_ROLES) {
      const agent = this.registry.agents[role];
      const dependencyFailed = agent.dependsOn.some(
        (dependency) =>
          records.find((record) => record.role === dependency)?.status !==
          'completed',
      );
      if (!agent.enabled || dependencyFailed) {
        records.push({
          role,
          status: 'skipped',
          outcome: 'skipped',
          output: input,
          attempts: 0,
          reason: !agent.enabled ? 'disabled' : 'dependency_failed',
        });
        if (overall !== 'failed') overall = 'degraded';
        continue;
      }

      // All three safety gates are checked before resolving or handing a
      // credential to a handler. No unverified/degraded agent can run.
      const gates = getAgentInvocationGates(agent, this.options);
      if (
        !gates.status ||
        !gates.verification ||
        !gates.credential ||
        !gates.adapter
      ) {
        const blocked = !gates.status
          ? 'status_not_active'
          : !gates.verification
            ? 'verification_required'
            : !gates.credential
              ? 'credential_required'
              : 'adapter_required';
        const record = this.fallback(agent, input, 0, blocked);
        records.push(record);
        overall =
          record.status === 'failed'
            ? 'failed'
            : overall === 'failed'
              ? 'failed'
              : 'degraded';
        continue;
      }

      const secret = resolveSecret(agent.secretRef, this.options);
      // The gate above deliberately avoids exposing the value. Resolve it only
      // for the short-lived handler call after every gate has passed.
      if (!secret.ok || !secret.value) {
        const record = this.fallback(agent, input, 0, 'credential_required');
        records.push(record);
        overall =
          record.status === 'failed'
            ? 'failed'
            : overall === 'failed'
              ? 'failed'
              : 'degraded';
        continue;
      }
      const secretValue = secret.value;
      if (!this.consumeQuota(agent)) {
        const record = this.fallback(agent, input, 0, 'quota_exceeded');
        records.push(record);
        overall =
          record.status === 'failed'
            ? 'failed'
            : overall === 'failed'
              ? 'failed'
              : 'degraded';
        continue;
      }

      const handler = this.options.handlers[role];
      if (!handler) {
        const record = this.fallback(agent, input, 0, 'handler_not_configured');
        records.push(record);
        overall =
          record.status === 'failed'
            ? 'failed'
            : overall === 'failed'
              ? 'failed'
              : 'degraded';
        continue;
      }

      let result: unknown;
      let failure: unknown;
      let attempts = 0;
      const maxAttempts =
        Number.isInteger(agent.retry.maxAttempts) && agent.retry.maxAttempts > 0
          ? agent.retry.maxAttempts
          : 1;
      for (attempts = 1; attempts <= maxAttempts; attempts += 1) {
        try {
          result = await this.withTimeout(
            handler(input, {
              role,
              attempt: attempts,
              // Give each handler a point-in-time dependency view. A handler
              // must not be able to mutate outputs already committed by an
              // earlier stage or observe a later stage's result.
              dependencies: this.snapshotDependencies(outputs),
              // Do not pass resolved credentials to handlers.
            }),
            agent.timeoutMs,
          );
          failure = undefined;
          break;
        } catch (error: unknown) {
          failure = error;
          if (attempts < maxAttempts) {
            const delay = Math.min(
              Math.max(0, agent.retry.maxBackoffMs),
              Math.max(0, agent.retry.backoffMs) * 2 ** (attempts - 1),
            );
            await sleep(delay);
          }
        }
      }
      if (failure !== undefined) {
        const reason = this.redactReason(
          failure instanceof Error ? failure.message : String(failure),
          secretValue,
        );
        const record = this.fallback(agent, input, maxAttempts, reason);
        records.push(record);
        overall =
          record.status === 'failed'
            ? 'failed'
            : overall === 'failed'
              ? 'failed'
              : 'degraded';
        continue;
      }

      outputs[role] = result;
      records.push({
        role,
        status: 'completed',
        outcome: 'accepted',
        output: result,
        attempts,
      });
    }

    const response: RuntimeRunResult = {
      idempotencyKey,
      status: overall,
      records,
      output:
        overall === 'completed'
          ? (outputs[AGENT_ROLES[AGENT_ROLES.length - 1]] ??
            records[records.length - 1]?.output ??
            input)
          : null,
    };
    return response;
  }

  private redactReason(reason: string, secret: string): string {
    return secret.length > 0 ? reason.split(secret).join('[REDACTED]') : reason;
  }

  /** Clone JSON-like stage output so a handler cannot mutate prior results. */
  private snapshotDependencies(
    outputs: Record<string, unknown>,
  ): Record<string, unknown> {
    const seen = new WeakMap<object, unknown>();
    const clone = (value: unknown): unknown => {
      if (value === null || typeof value !== 'object') return value;
      const existing = seen.get(value);
      if (existing) return existing;
      if (Array.isArray(value)) {
        const copy: unknown[] = [];
        seen.set(value, copy);
        value.forEach((item) => copy.push(clone(item)));
        return copy;
      }
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) return value;
      const copy: Record<string, unknown> = {};
      seen.set(value, copy);
      Object.entries(value).forEach(([key, item]) => {
        copy[key] = clone(item);
      });
      return copy;
    };
    return clone(outputs) as Record<string, unknown>;
  }

  private withTimeout(
    value: unknown | Promise<unknown>,
    timeoutMs: number,
  ): Promise<unknown> {
    const safeTimeout =
      Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout')), safeTimeout);
      Promise.resolve(value).then(
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

  private consumeQuota(agent: AgentRuntimeConfig): boolean {
    const now = (this.options.now || Date.now)();
    const counters = this.usage.get(agent.role) || {
      minute: 0,
      day: 0,
      minuteAt: now,
      dayAt: now,
    };
    if (now - counters.minuteAt >= 60_000) {
      counters.minute = 0;
      counters.minuteAt = now;
    }
    if (now - counters.dayAt >= 86_400_000) {
      counters.day = 0;
      counters.dayAt = now;
    }
    if (
      agent.quota.perMinute !== null &&
      counters.minute >= agent.quota.perMinute
    )
      return false;
    if (agent.quota.daily !== null && counters.day >= agent.quota.daily)
      return false;
    counters.minute += 1;
    counters.day += 1;
    this.usage.set(agent.role, counters);
    return true;
  }

  private fallback(
    agent: AgentRuntimeConfig,
    input: unknown,
    attempts: number,
    reason?: string,
  ): AgentRunRecord {
    if (agent.failurePolicy === 'fail_closed') {
      return {
        role: agent.role,
        status: 'failed',
        outcome: 'rejected',
        output: null,
        attempts,
        reason,
      };
    }
    if (agent.failurePolicy === 'fail_to_review') {
      return {
        role: agent.role,
        status: 'degraded',
        outcome: 'review',
        output: input,
        attempts,
        reason,
      };
    }
    return {
      role: agent.role,
      status: 'degraded',
      outcome: 'degraded',
      output: input,
      attempts,
      reason,
    };
  }
}
