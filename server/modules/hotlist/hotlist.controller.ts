import { Controller, Get, Query } from '@nestjs/common';
import { HotlistService } from './hotlist.service';

@Controller('api/hotlist')
export class HotlistController {
  constructor(private readonly hotlistService: HotlistService) {}

  @Get('github')
  async getGithubTrending(@Query('since') since?: string) {
    const validSince = since === 'weekly' ? 'weekly' : 'daily';
    return this.hotlistService.getGithubTrending(validSince);
  }

  @Get('weibo')
  async getWeiboHotSearch() {
    return this.hotlistService.getWeiboHotSearch();
  }
}
