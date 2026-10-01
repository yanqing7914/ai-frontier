import { Injectable } from '@nestjs/common';
import { ArticleService } from '../article/article.service';
import { DigestService } from '../digest/digest.service';
import type { HotArticleItem, PaginatedResponse, DailyDigest } from '@shared/api.interface';

/** Shared public read boundary for the site and future feeds or agent APIs. */
@Injectable()
export class PublicationService {
  constructor(
    private readonly articles: ArticleService,
    private readonly digests: DigestService,
  ) {}

  getTodayArticles(params: {
    page: number;
    pageSize: number;
    directions?: string[];
  }): Promise<PaginatedResponse<HotArticleItem>> {
    return this.articles.getHotArticles(params);
  }

  getDailyDigest(date: string): Promise<DailyDigest> {
    return this.digests.getDigestByDate(date);
  }
}
