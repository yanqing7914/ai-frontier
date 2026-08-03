import { Controller, Get, Param, Query } from '@nestjs/common';
import { ArticleService } from './article.service';
import type {
  HotArticleItem,
  WorkbenchOverview,
  WorkbenchArticleItem,
  DirectionScoreItem,
  ArticleTrace,
  QualityGateItem,
  PaginatedResponse,
} from '@shared/api.interface';

@Controller('api')
export class ArticleController {
  constructor(private readonly articleService: ArticleService) {}

  @Get('hot-articles')
  async getHotArticles(
    @Query('page') page: string,
    @Query('pageSize') pageSize: string,
    @Query('directions') directions?: string,
  ): Promise<PaginatedResponse<HotArticleItem>> {
    const parsedPage = parseInt(page, 10) || 1;
    const parsedPageSize = parseInt(pageSize, 10) || 20;
    const directionArr = directions
      ? directions.split(',').filter(Boolean)
      : undefined;
    return this.articleService.getHotArticles({
      page: parsedPage,
      pageSize: parsedPageSize,
      directions: directionArr,
    });
  }

  @Get('workbench/overview')
  async getWorkbenchOverview(): Promise<WorkbenchOverview> {
    return this.articleService.getWorkbenchOverview();
  }

  @Get('workbench/articles')
  async getWorkbenchArticles(
    @Query('page') page: string,
    @Query('pageSize') pageSize: string,
    @Query('status') status?: string,
    @Query('direction') direction?: string,
    @Query('sortBy') sortBy?: string,
  ): Promise<PaginatedResponse<WorkbenchArticleItem>> {
    const parsedPage = parseInt(page, 10) || 1;
    const parsedPageSize = parseInt(pageSize, 10) || 20;
    return this.articleService.getWorkbenchArticles({
      page: parsedPage,
      pageSize: parsedPageSize,
      status,
      direction,
      sortBy,
    });
  }

  @Get('workbench/quality-gates')
  async getQualityGates(
    @Query('page') page: string,
    @Query('pageSize') pageSize: string,
    @Query('reason') reason?: string,
  ): Promise<PaginatedResponse<QualityGateItem>> {
    const parsedPage = parseInt(page, 10) || 1;
    const parsedPageSize = parseInt(pageSize, 10) || 20;
    return this.articleService.getQualityGates({
      page: parsedPage,
      pageSize: parsedPageSize,
      reason,
    });
  }

  @Get('workbench/trace')
  async getTraceList(
    @Query('page') page: string,
    @Query('pageSize') pageSize: string,
    @Query('traced') traced?: string,
  ): Promise<PaginatedResponse<ArticleTrace>> {
    const parsedPage = parseInt(page, 10) || 1;
    const parsedPageSize = parseInt(pageSize, 10) || 20;
    const tracedBool =
      traced === undefined ? undefined : traced === 'true';
    return this.articleService.getTraceList({
      page: parsedPage,
      pageSize: parsedPageSize,
      traced: tracedBool,
    });
  }

  @Get('articles/:id/scores')
  async getArticleScores(
    @Param('id') id: string,
  ): Promise<{ items: DirectionScoreItem[] }> {
    return this.articleService.getArticleScores(id);
  }

  @Get('articles/:id/trace')
  async getArticleTrace(
    @Param('id') id: string,
  ): Promise<ArticleTrace> {
    return this.articleService.getArticleTrace(id);
  }
}
