import { Controller, Get, Query } from '@nestjs/common';
import { HotlistService } from './hotlist.service';

@Controller('api/hotlist')
export class HotlistController {
  constructor(private readonly hotlistService: HotlistService) {}

  @Get('github')
  async getGithubTrending(
    @Query('since') since?: string,
    @Query('force') force?: string,
  ) {
    const validSince = since === 'weekly' ? 'weekly' : 'daily';
    if (force === 'true') {
      this.hotlistService.clearCache(`github:${validSince}`);
    }
    return this.hotlistService.getGithubTrending(validSince);
  }

  @Get('weibo')
  async getWeiboHotSearch(@Query('force') force?: string) {
    if (force === 'true') {
      this.hotlistService.clearCache('weibo:hot');
    }
    return this.hotlistService.getWeiboHotSearch();
  }
}
