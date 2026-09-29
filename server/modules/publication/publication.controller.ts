import { Controller, Get, Param, Query } from '@nestjs/common';
import { PublicationService } from './publication.service';
import { parsePagination } from '../../common/pagination';

@Controller('api')
export class PublicationController {
  constructor(private readonly publication: PublicationService) {}

  @Get('hot-articles')
  getTodayArticles(
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('directions') directions?: string,
  ) {
    const pagination = parsePagination(page, pageSize);
    return this.publication.getTodayArticles({
      ...pagination,
      directions: directions?.split(',').filter(Boolean),
    });
  }

  @Get('daily-digests/:date')
  getDailyDigest(@Param('date') date: string) {
    return this.publication.getDailyDigest(date);
  }
}
