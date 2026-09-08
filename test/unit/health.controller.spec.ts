import { HealthController } from '../../server/modules/health/health.controller';

describe('HealthController', () => {
  it('returns a JSON-ready status payload without database access', () => {
    const result = new HealthController().getHealth();

    expect(result.status).toBe('ok');
    expect(result.service).toBe('ai-frontier');
    expect(new Date(result.timestamp).toISOString()).toBe(result.timestamp);
  });
});
