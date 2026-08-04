import { Controller, Post } from '@nestjs/common';
import { NeedLogin } from '@lark-apaas/fullstack-nestjs-core';
import { CollectorService } from './collector.service';

@Controller('api/collector')
export class CollectorController {
  constructor(private readonly collectorService: CollectorService) {}

  @NeedLogin()
  @Post('run')
  async runPipeline(): Promise<{ ok: boolean; message: string }> {
    try {
      await this.collectorService.runPipeline();
      return { ok: true, message: 'Pipeline completed' };
    } catch (error: unknown) {
      const errMsg =
        error instanceof Error ? error.message : String(error);
      return { ok: false, message: errMsg };
    }
  }

  @NeedLogin()
  @Post('select-front-page')
  async selectFrontPage(): Promise<{ ok: boolean; message: string }> {
    try {
      await this.collectorService.selectForFrontPage();
      return { ok: true, message: 'Front page selection completed' };
    } catch (error: unknown) {
      const errMsg =
        error instanceof Error ? error.message : String(error);
      return { ok: false, message: errMsg };
    }
  }

  @NeedLogin()
  @Post('rescore-pending')
  async rescorePending(): Promise<{
    ok: boolean;
    message: string;
    rescored: number;
    succeeded: number;
    failed: number;
  }> {
    try {
      const result = await this.collectorService.rescorePending();
      return {
        ok: true,
        message: `Rescore completed: ${result.succeeded} succeeded, ${result.failed} failed`,
        ...result,
      };
    } catch (error: unknown) {
      const errMsg =
        error instanceof Error ? error.message : String(error);
      return { ok: false, message: errMsg, rescored: 0, succeeded: 0, failed: 0 };
    }
  }
}
