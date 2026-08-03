import { Logger } from '@nestjs/common';
import {
  Automation,
  BindTrigger,
} from '@lark-apaas/fullstack-nestjs-core';
import { CollectorService } from './collector.service';

@Automation()
export class CollectorAutomation {
  private readonly logger = new Logger(CollectorAutomation.name);

  constructor(
    private readonly collectorService: CollectorService,
  ) {}

  @BindTrigger('ai_news_collection_pipeline')
  async runCollectionPipeline(): Promise<void> {
    this.logger.log('Starting AI news collection pipeline');
    try {
      await this.collectorService.runPipeline();
      this.logger.log(
        'AI news collection pipeline completed successfully',
      );
    } catch (error: unknown) {
      const errMsg =
        error instanceof Error ? error.message : String(error);
      this.logger.error(`Pipeline failed: ${errMsg}`);
      if (error instanceof Error && error.stack) {
        this.logger.error(`Stack: ${error.stack}`);
      }
    }
  }
}
