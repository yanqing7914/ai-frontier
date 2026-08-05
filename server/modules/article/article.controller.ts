import { BadRequestException, Controller, Get, Param, Query } from '@nestjs/common';
import { ArticleService } from './article.service';
import type {
  HotArticleItem,
  WorkbenchOverview,
  WorkbenchArticleItem,
  DirectionScoreItem,
  ArticleTrace,
  QualityGateItem,
  PaginatedResponse,
  TraceStatus,
} from '@shared/api.interface';

@Controller('api')
export class ArticleController {
  constructor(private readonly articleService: ArticleService) {}

  @Get('hot-articles')
  async getHotArticles(
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('directions') directions?: string,
  ): Promise<PaginatedResponse<HotArticleItem>> {
    const { page: parsedPage, pageSize: parsedPageSize } = parsePagination(page, pageSize);
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
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('status') status?: string,
    @Query('direction') direction?: string,
    @Query('sortBy') sortBy?: string,
  ): Promise<PaginatedResponse<WorkbenchArticleItem>> {
    const { page: parsedPage, pageSize: parsedPageSize } = parsePagination(page, pageSize);
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
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('reason') reason?: string,
  ): Promise<PaginatedResponse<QualityGateItem>> {
    const { page: parsedPage, pageSize: parsedPageSize } = parsePagination(page, pageSize);
    return this.articleService.getQualityGates({
      page: parsedPage,
      pageSize: parsedPageSize,
      reason,
    });
  }

  @Get('workbench/trace')
  async getTraceList(
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('traceStatus') traceStatus?: string,
  ): Promise<PaginatedResponse<ArticleTrace>> {
    const { page: parsedPage, pageSize: parsedPageSize } = parsePagination(page, pageSize);
    const validStatuses: TraceStatus[] = ['first_party', 'editorial', 'verified_reference', 'needs_review', 'unknown'];
    const status = traceStatus && validStatuses.includes(traceStatus as TraceStatus)
      ? (traceStatus as TraceStatus)
      : undefined;
    return this.articleService.getTraceList({
      page: parsedPage,
      pageSize: parsedPageSize,
      traceStatus: status,
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

const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE = 10_000;
const MAX_PAGE_SIZE = 100;

export function parsePagination(page?: string, pageSize?: string): { page: number; pageSize: number } {
  return {
    page: parsePositiveInteger(page, DEFAULT_PAGE, MAX_PAGE, 'page'),
    pageSize: parsePositiveInteger(pageSize, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, 'pageSize'),
  };
}

function parsePositiveInteger(value: string | undefined, fallback: number, max: number, name: string): number {
  if (value === undefined || value === '') return fallback;
  if (!/^\d+$/.test(value)) {
    throw new BadRequestException(`${name} must be a positive integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > max) {
    throw new BadRequestException(`${name} must be between 1 and ${max}`);
  }
  return parsed;
}
