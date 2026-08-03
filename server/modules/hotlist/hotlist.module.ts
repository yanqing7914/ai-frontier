import { Module } from '@nestjs/common';
import { HotlistController } from './hotlist.controller';
import { HotlistService } from './hotlist.service';

@Module({
  controllers: [HotlistController],
  providers: [HotlistService],
})
export class HotlistModule {}
