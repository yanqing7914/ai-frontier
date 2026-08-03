import { APP_FILTER } from '@nestjs/core';
import { Module } from '@nestjs/common';
import { PlatformModule } from '@lark-apaas/fullstack-nestjs-core';

import { GlobalExceptionFilter } from './common/filters/exception.filter';
import { ViewModule } from './modules/view/view.module';
import { FeedSourceModule } from './modules/feed-source/feed-source.module';
import { ArticleModule } from './modules/article/article.module';
import { CollectorModule } from './modules/collector/collector.module';
import { DigestModule } from './modules/digest/digest.module';
import { ReviewModule } from './modules/review/review.module';

@Module({
  imports: [
    // 平台 Module，提供平台能力
    PlatformModule.forRoot(),
    // ====== @route-section: business-modules START ======
    FeedSourceModule,
    ArticleModule,
    CollectorModule,
    DigestModule,
    ReviewModule,
    // ====== @route-section: business-modules END ======

    // ⚠️ @route-order: last
    // ViewModule is the fallback route module, must be registered last.
    ViewModule,
  ],
  providers: [
    {
      provide: APP_FILTER,
      useClass: GlobalExceptionFilter,
    },
  ],
})
export class AppModule {}
