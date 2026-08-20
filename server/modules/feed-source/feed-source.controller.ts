import {
  BadRequestException,
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Query,
  Body,
} from '@nestjs/common';
import { NeedLogin } from '@lark-apaas/fullstack-nestjs-core';
import { FeedSourceService } from './feed-source.service';
import type {
  CreateFeedSourceRequest,
  UpdateFeedSourceRequest,
  ToggleFeedSourceRequest,
} from '@shared/api.interface';

@Controller('api/feed-sources')
export class FeedSourceController {
  constructor(private readonly feedSourceService: FeedSourceService) {}

  @Get()
  async findAll(
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('tier') tier?: string,
    @Query('enabled') enabled?: string,
    @Query('sourceCategoryId') sourceCategoryId?: string,
  ) {
    const { page: parsedPage, pageSize: parsedPageSize } = parseFeedSourcePagination(page, pageSize);
    return this.feedSourceService.findAll({
      page: parsedPage,
      pageSize: parsedPageSize,
      tier,
      enabled,
      sourceCategoryId,
    });
  }

  @Get(':id')
  async findOne(@Param('id') id: string) {
    return this.feedSourceService.findOne(id);
  }

  @NeedLogin()
  @Post()
  async create(@Body() dto: CreateFeedSourceRequest) {
    return this.feedSourceService.create(dto);
  }

  @NeedLogin()
  @Patch(':id')
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateFeedSourceRequest,
  ) {
    return this.feedSourceService.update(id, dto);
  }

  @NeedLogin()
  @Delete(':id')
  async delete(@Param('id') id: string) {
    return this.feedSourceService.delete(id);
  }

  @NeedLogin()
  @Patch(':id/toggle')
  async toggle(
    @Param('id') id: string,
    @Body() dto: ToggleFeedSourceRequest,
  ) {
    return this.feedSourceService.toggle(id, dto);
  }

  @Get(':id/health')
  async getHealth(@Param('id') id: string) {
    return this.feedSourceService.getHealth(id);
  }
}

const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE = 10_000;
// Source management loads the full operational pool in one view. Keep this
// bounded, but aligned with the 200-row client request.
const MAX_PAGE_SIZE = 200;

export function parseFeedSourcePagination(
  page?: string,
  pageSize?: string,
): { page: number; pageSize: number } {
  return {
    page: parsePositiveInteger(page, DEFAULT_PAGE, MAX_PAGE, 'page'),
    pageSize: parsePositiveInteger(pageSize, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, 'pageSize'),
  };
}

function parsePositiveInteger(
  value: string | undefined,
  fallback: number,
  max: number,
  name: string,
): number {
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
