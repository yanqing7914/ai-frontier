import { CollectorService } from '@server/modules/collector/collector.service';

describe('CollectorService detached trigger', () => {
  it('returns before a slow lease lookup completes', async () => {
    const pendingLeaseLookup = new Promise<never>(() => undefined);
    const db = {
      select: () => ({
        from: () => ({ where: () => pendingLeaseLookup }),
      }),
    };
    const service = Object.create(CollectorService.prototype) as any;
    service.pipelineRunning = false;
    (service as any).db = db;
    (service as any).logger = { log: () => undefined, warn: () => undefined, error: () => undefined };

    const result = await Promise.race([
      service.startPipelineDetached('cron'),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('ack timed out')), 50)),
    ]);

    expect(result).toEqual({ accepted: true });
    expect(service.pipelineRunning).toBe(true);
  });
});
