import { AGENT_ROLES } from './types';
import {
  buildCapabilityInvocationPlan,
  createAgentRegistry,
  resolveSecret,
  validateAgentRegistry,
} from './registry';

describe('agent runtime registry', () => {
  it('creates exactly eight contract-backed roles with environment overrides', () => {
    const registry = createAgentRegistry({
      now: '2026-09-01T00:00:00Z',
      environment: {
        AI_FRONTIER_CONTENT_FILTER_PROVIDER: 'openai',
        AI_FRONTIER_CONTENT_FILTER_MODEL: 'gpt-test',
      },
    });
    expect(Object.keys(registry.agents)).toHaveLength(8);
    expect(Object.keys(registry.agents)).toEqual([...AGENT_ROLES]);
    expect(registry.agents.content_filter.provider).toBe('openai');
    expect(registry.agents.content_filter.model).toBe('gpt-test');
  });

  it('resolves secrets transiently and reports missing keys without exposing values', () => {
    expect(
      resolveSecret(
        { kind: 'env', name: 'KEY' },
        { environment: { KEY: 'secret-value' } },
      ),
    ).toEqual({ ok: true, source: 'env', value: 'secret-value' });
    const missing = resolveSecret(
      { kind: 'secret_manager', name: 'prod/key' },
      { secretManager: () => undefined },
    );
    expect(missing.ok).toBe(false);
    expect(missing.reason).toContain('prod/key');
  });

  it('validates provider/model/policies/prompt and missing secret configuration', () => {
    const registry = createAgentRegistry({ environment: {} });
    const result = validateAgentRegistry(registry, { environment: {} });
    expect(result.valid).toBe(false);
    expect(result.errors.every((error) => error.code === 'required')).toBe(
      true,
    );
    const valid = validateAgentRegistry(registry, {
      environment: Object.fromEntries(
        AGENT_ROLES.map((role) => [
          `AI_FRONTIER_${role.toUpperCase()}_API_KEY`,
          'x',
        ]),
      ),
    });
    expect(valid.valid).toBe(true);
  });

  it('builds a non-invoking capability plan', () => {
    const agent = createAgentRegistry({
      environment: { AI_FRONTIER_CONTENT_FILTER_API_KEY: 'x' },
    }).agents.content_filter;
    expect(buildCapabilityInvocationPlan(agent).invokesExternalProvider).toBe(
      false,
    );
  });
});
