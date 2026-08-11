import { HttpException, HttpStatus } from '@nestjs/common';
import { CollectorController } from '@server/modules/collector/collector.controller';
import { CollectorAutomation } from '@server/modules/collector/collector.automation';
import type { CollectorService } from '@server/modules/collector/collector.service';

/**
 * Regression guards for the two bugs that made a broken pipeline look healthy:
 *  - the cron automation logged "completed successfully" even when the run threw
 *  - every manual endpoint returned HTTP 200 with { ok: false } on failure
 */
describe('collector failure propagation', () => {
  function serviceStub(overrides: Partial<CollectorService>): CollectorService {
    return overrides as unknown as CollectorService;
  }

  describe('CollectorAutomation', () => {
    it('acknowledges without waiting for the run to finish', async () => {
      const startPipelineDetached = jest.fn().mockResolvedValue({ accepted: true });
      const automation = new CollectorAutomation(
        serviceStub({ startPipelineDetached } as unknown as Partial<CollectorService>),
      );

      await expect(automation.runCollectionPipeline()).resolves.toBeUndefined();
      expect(startPipelineDetached).toHaveBeenCalledWith('cron');
    });

    it('rethrows when the run cannot even be started, so dispatch is recorded as failed', async () => {
      const automation = new CollectorAutomation(
        serviceStub({
          startPipelineDetached: jest
            .fn()
            .mockRejectedValue(new Error('db unreachable')),
        } as unknown as Partial<CollectorService>),
      );

      await expect(automation.runCollectionPipeline()).rejects.toThrow(
        'db unreachable',
      );
    });

    it('does not throw when a run is already in flight', async () => {
      const automation = new CollectorAutomation(
        serviceStub({
          startPipelineDetached: jest
            .fn()
            .mockResolvedValue({ accepted: false, reason: 'already running' }),
        } as unknown as Partial<CollectorService>),
      );

      await expect(automation.runCollectionPipeline()).resolves.toBeUndefined();
    });
  });

  describe('CollectorController', () => {
    it('returns accepted for a fresh run', async () => {
      const controller = new CollectorController(
        serviceStub({
          startPipelineDetached: jest.fn().mockResolvedValue({ accepted: true }),
        } as unknown as Partial<CollectorService>),
      );

      const res = await controller.runPipeline();
      expect(res.ok).toBe(true);
      expect(res.accepted).toBe(true);
    });

    it('answers 409 instead of 200 when a run is already in flight', async () => {
      const controller = new CollectorController(
        serviceStub({
          startPipelineDetached: jest
            .fn()
            .mockResolvedValue({ accepted: false, reason: 'already running' }),
        } as unknown as Partial<CollectorService>),
      );

      await expect(controller.runPipeline()).rejects.toMatchObject({
        status: HttpStatus.CONFLICT,
      });
    });

    it('answers 500 instead of 200 when starting the run throws', async () => {
      const controller = new CollectorController(
        serviceStub({
          startPipelineDetached: jest.fn().mockRejectedValue(new Error('boom')),
        } as unknown as Partial<CollectorService>),
      );

      const error = await controller.runPipeline().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(HttpException);
      expect((error as HttpException).getStatus()).toBe(
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
      expect((error as HttpException).getResponse()).toMatchObject({
        ok: false,
      });
    });

    it.each([
      ['selectFrontPage', 'selectForFrontPage'],
      ['rescorePending', 'rescorePending'],
    ])('%s surfaces failure as 500, never { ok: false } with 200', async (
      method,
      serviceMethod,
    ) => {
      const controller = new CollectorController(
        serviceStub({
          [serviceMethod]: jest.fn().mockRejectedValue(new Error('nope')),
        } as unknown as Partial<CollectorService>),
      );

      const error = await (
        controller[method as 'selectFrontPage' | 'rescorePending']() as Promise<unknown>
      ).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(HttpException);
      expect((error as HttpException).getStatus()).toBe(
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    });
  });
});
