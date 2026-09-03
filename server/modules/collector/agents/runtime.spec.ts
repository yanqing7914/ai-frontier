import { createAgentRegistry } from './registry';
import { AgentRuntime } from './runtime';
import { AGENT_ROLES, type AgentRole, type AgentRuntimeConfig } from './types';

const API_KEY_ENV: Record<string, string> = Object.fromEntries(
  AGENT_ROLES.map((role) => [
    `AI_FRONTIER_${role.toUpperCase()}_API_KEY`,
    `test-key-${role}`,
  ]),
);

const VERIFIED_AT = '2026-01-01T00:00:00.000Z';

function verifiedOverrides(): Partial<
  Record<AgentRole, Partial<AgentRuntimeConfig>>
> {
  return Object.fromEntries(
    AGENT_ROLES.map((role) => [
      role,
      {
        enabled: true,
        status: 'active',
        verification: {
          status: 'verified',
          verifiedAt: VERIFIED_AT,
          verifier: 'runtime.spec',
          evidence: [`fixture:${role}`],
        },
      },
    ]),
  ) as Partial<Record<AgentRole, Partial<AgentRuntimeConfig>>>;
}

function registryWithVerifiedAgents(
  overrides: Partial<Record<AgentRole, Partial<AgentRuntimeConfig>>> = {},
) {
  const verified = verifiedOverrides();
  const mergedOverrides = Object.fromEntries(
    AGENT_ROLES.map((role) => {
      const base = verified[role] || {};
      const override = overrides[role] || {};
      return [
        role,
        {
          ...base,
          ...override,
          ...(base.verification || override.verification
            ? {
                verification: {
                  ...base.verification,
                  ...override.verification,
                },
              }
            : {}),
          ...(base.retry || override.retry
            ? { retry: { ...base.retry, ...override.retry } }
            : {}),
          ...(base.quota || override.quota
            ? { quota: { ...base.quota, ...override.quota } }
            : {}),
        },
      ];
    }),
  ) as Partial<Record<AgentRole, Partial<AgentRuntimeConfig>>>;
  return createAgentRegistry({
    environment: API_KEY_ENV,
    overrides: mergedOverrides,
  });
}

describe('AgentRuntime', () => {
  it('does not execute an enabled agent until it is verified and active', async () => {
    const calls: string[] = [];
    const registry = createAgentRegistry({ environment: API_KEY_ENV });
    const handlers = Object.fromEntries(
      AGENT_ROLES.map((role) => [
        role,
        async (input: unknown) => {
          calls.push(role);
          return input;
        },
      ]),
    );

    const result = await new AgentRuntime(registry, {
      environment: API_KEY_ENV,
      handlers,
    }).run('input');

    expect(calls).toHaveLength(0);
    expect(result.records[0]).toMatchObject({
      role: 'content_filter',
      status: 'skipped',
      outcome: 'skipped',
      output: 'input',
      reason: 'disabled',
    });
    expect(result.status).toBe('degraded');
    expect(result.output).toBeNull();
  });

  it('runs serially and caches idempotent results', async () => {
    const calls: AgentRole[] = [];
    const registry = registryWithVerifiedAgents();
    const handlers = Object.fromEntries(
      AGENT_ROLES.map((role) => [
        role,
        async (
          input: unknown,
          context: { dependencies: Record<string, unknown> },
        ) => {
          calls.push(role);
          // Every stage sees only results from stages that have already completed.
          expect(context.dependencies).not.toHaveProperty(role);
          return { role, input };
        },
      ]),
    );
    const runtime = new AgentRuntime(registry, {
      environment: API_KEY_ENV,
      handlers,
    });

    const first = await runtime.run({ x: 1 }, 'same');
    const second = await runtime.run({ x: 2 }, 'same');

    expect(calls).toEqual([...AGENT_ROLES]);
    expect(first.status).toBe('completed');
    expect(second).toBe(first);
    expect(first.records).toHaveLength(AGENT_ROLES.length);
  });

  it('deduplicates concurrent calls with the same idempotency key', async () => {
    const calls: AgentRole[] = [];
    const registry = registryWithVerifiedAgents();
    const handlers = Object.fromEntries(
      AGENT_ROLES.map((role) => [
        role,
        async (input: unknown) => {
          calls.push(role);
          await new Promise((resolve) => setTimeout(resolve, 2));
          return input;
        },
      ]),
    );
    const runtime = new AgentRuntime(registry, {
      environment: API_KEY_ENV,
      handlers,
    });

    const [first, second] = await Promise.all([
      runtime.run('first', 'concurrent'),
      runtime.run('second', 'concurrent'),
    ]);

    expect(second).toBe(first);
    expect(calls).toEqual([...AGENT_ROLES]);
  });

  it('passes an isolated deep dependency snapshot to each stage', async () => {
    const registry = registryWithVerifiedAgents();
    const seen: unknown[] = [];
    const handlers = Object.fromEntries(
      AGENT_ROLES.map((role, index) => [
        role,
        async (
          input: unknown,
          context: { dependencies: Record<string, unknown> },
        ) => {
          if (index > 0) {
            const previous = context.dependencies[AGENT_ROLES[index - 1]] as {
              nested?: { value?: number };
            };
            seen.push(previous?.nested?.value);
            if (previous?.nested) previous.nested.value = 999;
          }
          return { nested: { value: index }, input };
        },
      ]),
    );

    await new AgentRuntime(registry, {
      environment: API_KEY_ENV,
      handlers,
    }).run('input');

    expect(seen).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it('retries timeout and applies fail-closed output and status', async () => {
    const registry = registryWithVerifiedAgents({
      content_filter: {
        timeoutMs: 5,
        retry: { maxAttempts: 2, backoffMs: 0, maxBackoffMs: 0 },
      },
    });
    const result = await new AgentRuntime(registry, {
      environment: API_KEY_ENV,
      handlers: {
        content_filter: () => new Promise((resolve) => setTimeout(resolve, 20)),
      },
    }).run('input');

    expect(result.records[0]).toMatchObject({
      role: 'content_filter',
      status: 'failed',
      outcome: 'rejected',
      output: null,
      attempts: 2,
    });
    expect(result.status).toBe('failed');
    expect(result.output).toBeNull();
    expect(
      result.records.find((record) => record.role === 'content_evaluator'),
    ).toMatchObject({
      status: 'skipped',
      reason: 'dependency_failed',
    });
  });

  it('blocks dependent agents after an upstream failure', async () => {
    const calls: AgentRole[] = [];
    const registry = registryWithVerifiedAgents({
      content_filter: {
        retry: { maxAttempts: 1, backoffMs: 0, maxBackoffMs: 0 },
      },
    });
    const handlers = {
      content_filter: () => {
        calls.push('content_filter');
        throw new Error('upstream failed');
      },
      content_evaluator: () => {
        calls.push('content_evaluator');
        return 'should-not-run';
      },
    };

    const result = await new AgentRuntime(registry, {
      environment: API_KEY_ENV,
      handlers,
    }).run('input');

    expect(calls).toEqual(['content_filter']);
    expect(
      result.records.find((record) => record.role === 'content_evaluator'),
    ).toMatchObject({
      status: 'skipped',
      outcome: 'skipped',
      reason: 'dependency_failed',
      output: 'input',
    });
    expect(result.status).toBe('failed');
    expect(result.output).toBeNull();
  });

  it('redacts a resolved credential from handler failure reasons', async () => {
    const secret = API_KEY_ENV.AI_FRONTIER_CONTENT_FILTER_API_KEY;
    const registry = registryWithVerifiedAgents();
    const result = await new AgentRuntime(registry, {
      environment: API_KEY_ENV,
      handlers: {
        content_filter: () => {
          throw new Error(`provider rejected ${secret}`);
        },
      },
    }).run('input');

    expect(result.records[0].reason).toBe('provider rejected [REDACTED]');
    expect(result.records[0].reason).not.toContain(secret);
  });
});
