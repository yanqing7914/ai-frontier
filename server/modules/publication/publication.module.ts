import { Module } from '@nestjs/common';
import { ArticleModule } from '../article/article.module';
import { DigestModule } from '../digest/digest.module';
import { PublicationController } from './publication.controller';
import { PublicationService } from './publication.service';

@Module({
  imports: [ArticleModule, DigestModule],
  controllers: [PublicationController],
  providers: [PublicationService],
  exports: [PublicationService],
})
export class PublicationModule {}
