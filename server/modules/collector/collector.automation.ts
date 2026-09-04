import { Logger } from '@nestjs/common';
import { Injectable } from '@nestjs/common';
import { CollectorService } from './collector.service';

@Injectable()
export class CollectorAutomation {
  private readonly logger = new Logger(CollectorAutomation.name);

  constructor(
    private readonly collectorService: CollectorService,
  ) {}

  async runCollectionPipeline(): Promise<void> {
    this.logger.log('Starting AI news collection pipeline');
    // Acknowledge within the scheduler's ~10s dispatch budget; the run itself
    // continues detached and records its real outcome in `pipeline_run_state`.
    // Never claim success here — a full run has not finished by the time we return.
    try {
      const result =
        await this.collectorService.startPipelineDetached('cron');
      if (!result.accepted) {
        this.logger.warn(
          `AI news collection pipeline not started: ${result.reason}`,
        );
        return;
      }
      this.logger.log(
        'AI news collection pipeline accepted and running detached',
      );
    } catch (error: unknown) {
      const errMsg =
        error instanceof Error ? error.message : String(error);
      this.logger.error(`Pipeline could not be started: ${errMsg}`);
      if (error instanceof Error && error.stack) {
        this.logger.error(`Stack: ${error.stack}`);
      }
      // Rethrow so the platform records this dispatch as failed instead of
      // logging an error and still reporting success.
      throw error;
    }
  }
}
