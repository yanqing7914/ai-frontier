import { APP_FILTER } from '@nestjs/core';
import { Global, Module } from '@nestjs/common';
import { DatabaseModule } from './infrastructure/database';
import { CapabilityService } from './infrastructure/capability.service';

import { GlobalExceptionFilter } from './common/filters/exception.filter';
import { ViewModule } from './modules/view/view.module';
import { FeedSourceModule } from './modules/feed-source/feed-source.module';
import { ArticleModule } from './modules/article/article.module';
import { CollectorModule } from './modules/collector/collector.module';
import { DigestModule } from './modules/digest/digest.module';
import { ReviewModule } from './modules/review/review.module';
import { HotlistModule } from './modules/hotlist/hotlist.module';
import { HealthModule } from './modules/health/health.module';

@Global()
@Module({
  imports: [
    DatabaseModule,
    // ====== @route-section: business-modules START ======
    FeedSourceModule,
    ArticleModule,
    CollectorModule,
    DigestModule,
    ReviewModule,
    HotlistModule,
    HealthModule,
    // ====== @route-section: business-modules END ======

    // ⚠️ @route-order: last
    // ViewModule is the fallback route module, must be registered last.
    ViewModule,
  ],
  providers: [
    CapabilityService,
    {
      provide: APP_FILTER,
      useClass: GlobalExceptionFilter,
    },
  ],
  exports: [CapabilityService],
})
export class AppModule {}
