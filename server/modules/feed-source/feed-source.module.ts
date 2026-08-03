import { Module } from '@nestjs/common';
import { FeedSourceController } from './feed-source.controller';
import { FeedSourceService } from './feed-source.service';

@Module({
  controllers: [FeedSourceController],
  providers: [FeedSourceService],
  exports: [FeedSourceService],
})
export class FeedSourceModule {}
