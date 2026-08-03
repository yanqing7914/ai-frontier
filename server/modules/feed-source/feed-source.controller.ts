import {
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
  ) {
    return this.feedSourceService.findAll({
      page: parseInt(page ?? '1', 10),
      pageSize: parseInt(pageSize ?? '20', 10),
      tier,
      enabled,
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
