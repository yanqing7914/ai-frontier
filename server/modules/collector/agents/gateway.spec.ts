import { AGENT_ROLES, contractMetadata } from './types';
import { createAgentRegistry } from './registry';
import {
  AgentGateway,
  AGENT_GATEWAY_ERROR_CODES,
  createAgentInvocationGateway,
  createAgentGateway,
} from './gateway';
import type { AgentGatewayOptions } from './gateway';

const verified = {
  status: 'verified' as const,
  verifiedAt: '2026-09-02T00:00:00Z',
  verifier: 'test-operator',
  evidence: ['unit-test'],
};

const environment = Object.fromEntries(
  AGENT_ROLES.flatMap((role) => [
    [`AI_FRONTIER_${role.toUpperCase()}_API_KEY`, 'test-secret'],
    [`AI_FRONTIER_AGENT_${role.toUpperCase()}_ENABLED`, 'true'],
  ]),
);

function activeOverrides() {
  return Object.fromEntries(
    AGENT_ROLES.map((role) => [
      role,
      {
        enabled: true,
        status: 'active' as const,
        verification: verified,
      },
    ]),
  );
}

function availableOverride(role: (typeof AGENT_ROLES)[number]) {
  const metadata = contractMetadata(role);
  const contract =
    role === 'content_filter'
      ? {
          inputContract: 'ContractArticleInput',
          outputContract: 'ContentFilterOutput',
        }
      : role === 'content_evaluator'
        ? {
            inputContract: 'ContractArticleInput + ContentFilterOutput',
            outputContract: 'ContentEvaluationOutput',
          }
        : role === 'chinese_processor'
          ? {
              inputContract: 'ContractArticleInput + ContentEvaluationOutput',
              outputContract: 'ChineseProcessingOutput',
            }
          : role === 'body_organizer'
            ? {
                inputContract: 'ContractArticleInput + ContentFilterOutput',
                outputContract: 'BodyOrganizationOutput',
              }
            : role === 'event_recognizer'
              ? {
                  inputContract:
                    'ContractArticleInput + ContentEvaluationOutput',
                  outputContract: 'EventRecognitionOutput',
                }
              : role === 'semantic_clusterer'
                ? {
                    inputContract:
                      'ContractArticleInput + EventRecognitionOutput',
                    outputContract: 'SemanticClusteringOutput',
                  }
                : role === 'event_reviewer'
                  ? {
                      inputContract:
                        'ContractArticleInput + EventRecognitionOutput + SemanticClusteringOutput',
                      outputContract: 'EventReviewOutput',
                    }
                  : {
                      inputContract:
                        'ContractArticleInput + ContentEvaluationOutput + EventReviewOutput',
                      outputContract: 'FeaturedExplanationOutput',
                    };
  return {
    ...metadata,
    enabled: true,
    status: 'active' as const,
    verification: verified,
    capability: {
      capabilityId: `cap_${role}`,
      action: 'run',
      ...contract,
      invocation: 'available' as const,
    },
  };
}

describe('AgentGateway', () => {
  it('supports every one of the eight registered roles', async () => {
    const registry = createAgentRegistry({
      environment,
      overrides: activeOverrides(),
    });
    const calls: string[] = [];
    const handlers = Object.fromEntries(
      AGENT_ROLES.map((role) => [
        role,
        async (input: unknown) => {
          calls.push(role);
          return { role, input };
        },
      ]),
    );
    const gateway = createAgentGateway(registry, {
      environment,
      handlers,
      // A structurally valid adapter is required even when the local test
      // handler is selected for execution.
      adapters: {
        capability: {
          load: jest.fn(() => ({ call: jest.fn(async () => ({ ok: true })) })),
        },
      },
    });

    const results = await Promise.all(
      AGENT_ROLES.map((role) => gateway.invoke(role, { input: role })),
    );

    expect(results).toHaveLength(8);
    expect(
      results.every((result) => result.ok && result.status === 'completed'),
    ).toBe(true);
    expect(calls).toEqual(expect.arrayContaining([...AGENT_ROLES]));
    expect(calls).toHaveLength(8);
  });

  it('supports the object request and compatibility aliases', async () => {
    const handler = jest.fn().mockResolvedValue({ answer: 'ok' });
    const registry = createAgentRegistry({
      environment,
      overrides: activeOverrides(),
    });
    const gateway = createAgentInvocationGateway(registry, {
      environment,
      handlers: { content_filter: handler },
    });

    const result = await gateway.execute({
      role: 'content_filter',
      input: 'text',
      context: { traceId: 'safe-id' },
    });

    expect(result).toMatchObject({ ok: true, status: 'completed' });
    expect(handler).toHaveBeenCalledWith('text', { traceId: 'safe-id' });
  });

  it('returns a blocked result before resolver or load when status is not active', async () => {
    const load = jest.fn();
    const resolver = jest.fn(() => 'test-secret');
    const registry = createAgentRegistry({
      environment,
      overrides: { content_evaluator: availableOverride('content_evaluator') },
    });
    registry.agents.content_evaluator.status = 'blocked';
    const gateway = new AgentGateway(registry, {
      resolver,
      adapters: { capability: { load } },
    });

    const result = await gateway.invoke('content_evaluator', { input: 'text' });

    expect(result).toMatchObject({
      ok: false,
      status: 'blocked',
      code: 'status_not_active',
      errorCode: AGENT_GATEWAY_ERROR_CODES.status_not_active,
      blockedBy: 'status',
    });
    expect(resolver).not.toHaveBeenCalled();
    expect(load).not.toHaveBeenCalled();
  });

  it('does not resolve credentials or load when the agent is disabled', async () => {
    const load = jest.fn();
    const resolver = jest.fn(() => true);
    const registry = createAgentRegistry({
      environment,
      overrides: {
        content_filter: {
          ...availableOverride('content_filter'),
          enabled: false,
          status: 'disabled',
        },
      },
    });

    const result = await new AgentGateway(registry, {
      resolver,
      adapters: { capability: { load } },
    }).invoke('content_filter', { input: 'text' });

    expect(result).toMatchObject({
      ok: false,
      status: 'blocked',
      code: 'disabled',
      blockedBy: 'enabled',
    });
    expect(resolver).not.toHaveBeenCalled();
    expect(load).not.toHaveBeenCalled();
  });

  it('checks adapter structure before resolving credentials', async () => {
    const resolver = jest.fn(() => true);
    const registry = createAgentRegistry({
      environment,
      overrides: { content_filter: availableOverride('content_filter') },
    });

    const result = await new AgentGateway(registry, {
      resolver,
      adapters: { capability: {} as never },
    }).invoke('content_filter', { input: 'text' });

    expect(result).toMatchObject({
      ok: false,
      status: 'blocked',
      code: 'adapter_required',
      blockedBy: 'adapter',
    });
    expect(resolver).not.toHaveBeenCalled();
  });

  it('does not invoke adapter_only capabilities', async () => {
    const load = jest.fn();
    const resolver = jest.fn(() => 'test-secret');
    const registry = createAgentRegistry({
      environment,
      overrides: {
        content_filter: {
          status: 'active',
          verification: verified,
          capability: {
            capabilityId: 'cap_content_filter',
            action: 'run',
            inputContract: 'ContractArticleInput',
            outputContract: 'ContentFilterOutput',
            invocation: 'adapter_only',
          },
        },
      },
    });
    const gateway = new AgentGateway(registry, {
      resolver,
      adapters: { capability: { load } },
    });

    const result = await gateway.invoke('content_filter', { input: 'text' });

    expect(result).toMatchObject({
      ok: false,
      status: 'blocked',
      code: 'adapter_required',
    });
    expect(resolver).not.toHaveBeenCalled();
    expect(load).not.toHaveBeenCalled();
  });

  it('checks adapter shape without loading it, then resolves and calls only when authorized', async () => {
    const load = jest
      .fn()
      .mockReturnValue({ call: jest.fn().mockResolvedValue({ answer: 'ok' }) });
    const resolver = jest.fn(() => 'transient-secret');
    const registry = createAgentRegistry({
      environment: {},
      overrides: { content_evaluator: availableOverride('content_evaluator') },
    });
    const gateway = new AgentGateway(registry, {
      resolver,
      adapters: { capability: { load } },
    });

    const result = await gateway.invoke('content_evaluator', {
      input: { article: 'text' },
    });

    expect(result).toMatchObject({
      ok: true,
      status: 'completed',
      authorized: true,
      output: { answer: 'ok' },
    });
    expect(resolver).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledWith('cap_content_evaluator');
    expect(load.mock.results[0].value.call).toHaveBeenCalledWith(
      'run',
      { article: 'text' },
      undefined,
    );
  });

  it('aborts a cancellation-aware capability when its invocation times out', async () => {
    const signalSeen: AbortSignal[] = [];
    const callWithSignal = jest.fn(
      async (
        _action: string,
        _input: unknown,
        _context: unknown,
        signal: AbortSignal,
      ) => {
        signalSeen.push(signal);
        return new Promise<never>((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            reject(new Error('cancelled'));
          });
        });
      },
    );
    const registry = createAgentRegistry({
      environment: {},
      overrides: {
        content_evaluator: {
          ...availableOverride('content_evaluator'),
          timeoutMs: 5,
        },
      },
    });

    const result = await new AgentGateway(registry, {
      resolver: () => true,
      adapters: {
        capability: {
          load: jest.fn(() => ({ callWithSignal })),
        },
      },
    }).invoke('content_evaluator', { input: 'text' });

    expect(result).toMatchObject({
      ok: false,
      status: 'failed',
      code: 'invocation_failed',
    });
    expect(callWithSignal).toHaveBeenCalledTimes(1);
    expect(signalSeen).toHaveLength(1);
    expect(signalSeen[0].aborted).toBe(true);
  });

  it('accepts an opaque successful secret resolution without exposing a value', async () => {
    const call = jest.fn().mockResolvedValue({ answer: 'ok' });
    const load = jest.fn().mockReturnValue({ call });
    const resolver = jest.fn(() => ({ ok: true, source: 'env' as const }));
    const registry = createAgentRegistry({
      environment: {},
      overrides: { content_filter: availableOverride('content_filter') },
    });

    const result = await new AgentGateway(registry, {
      resolver,
      adapters: { capability: { load } },
    }).invoke('content_filter', { input: 'text' });

    expect(result).toMatchObject({ ok: true, status: 'completed' });
    expect(resolver).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledTimes(1);
    expect(call).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain('test-secret');
  });

  it('does not load when credential authorization fails', async () => {
    const load = jest.fn();
    const resolver = jest.fn(() => false);
    const registry = createAgentRegistry({
      environment: {},
      overrides: { content_filter: availableOverride('content_filter') },
    });

    const result = await new AgentGateway(registry, {
      resolver,
      adapters: { capability: { load } },
    }).invoke('content_filter', { input: 'text' });

    expect(result).toMatchObject({
      ok: false,
      status: 'blocked',
      code: 'credential_required',
      blockedBy: 'credential',
    });
    expect(resolver).toHaveBeenCalledTimes(1);
    expect(load).not.toHaveBeenCalled();
  });

  it('returns stable redacted errors when an adapter throws a secret-bearing error', async () => {
    const secret = 'super-secret-provider-payload';
    const load = jest.fn().mockReturnValue({
      call: jest
        .fn()
        .mockRejectedValue(new Error(`provider failed: ${secret}`)),
    });
    const registry = createAgentRegistry({
      environment,
      overrides: { content_filter: availableOverride('content_filter') },
    });
    const options: AgentGatewayOptions = {
      environment,
      adapters: { capability: { load } },
    };
    const result = await new AgentGateway(registry, options).invoke(
      'content_filter',
      { input: 'text' },
    );

    expect(result).toMatchObject({
      ok: false,
      status: 'failed',
      code: 'invocation_failed',
      errorCode: AGENT_GATEWAY_ERROR_CODES.invocation_failed,
      reason: 'Agent invocation failed',
    });
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it('redacts sensitive fields in successful adapter output', async () => {
    const load = jest.fn().mockReturnValue({
      call: jest
        .fn()
        .mockResolvedValue({ answer: 'ok', apiKey: 'secret-output' }),
    });
    const registry = createAgentRegistry({
      environment,
      overrides: { content_filter: availableOverride('content_filter') },
    });
    const result = await new AgentGateway(registry, {
      environment,
      adapters: { capability: { load } },
    }).invoke('content_filter', { input: 'text' });

    expect(result).toMatchObject({
      ok: true,
      output: { answer: 'ok', apiKey: '[REDACTED]' },
    });
  });

  it('redacts circular output safely', async () => {
    const circular: Record<string, unknown> = { answer: 'ok' };
    circular.self = circular;
    const load = jest.fn().mockReturnValue({
      call: jest.fn().mockResolvedValue(circular),
    });
    const registry = createAgentRegistry({
      environment,
      overrides: { content_filter: availableOverride('content_filter') },
    });

    const result = await new AgentGateway(registry, {
      environment,
      adapters: { capability: { load } },
    }).invoke('content_filter', { input: 'text' });

    expect(result).toMatchObject({
      ok: true,
      output: { answer: 'ok', self: '[CIRCULAR]' },
    });
  });
});
