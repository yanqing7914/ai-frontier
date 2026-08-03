import { Module } from '@nestjs/common';
import { AiScoringService } from './ai-scoring.service';

@Module({
  providers: [AiScoringService],
  exports: [AiScoringService],
})
export class CollectorModule {}
