import { Module } from '@nestjs/common';
import { FeedSourceModule } from '../feed-source/feed-source.module';
import { DigestModule } from '../digest/digest.module';
import { ReviewModule } from '../review/review.module';
import { AiScoringService } from './ai-scoring.service';
import { CollectorService } from './collector.service';
import { CollectorController } from './collector.controller';
import { CollectorAutomation } from './collector.automation';

@Module({
  imports: [FeedSourceModule, DigestModule, ReviewModule],
  controllers: [CollectorController],
  providers: [AiScoringService, CollectorService, CollectorAutomation],
  exports: [AiScoringService],
})
export class CollectorModule {}
