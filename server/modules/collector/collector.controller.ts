import {
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Post,
} from '@nestjs/common';
import { NeedLogin } from '@lark-apaas/fullstack-nestjs-core';
import { CollectorService } from './collector.service';

/**
 * Failures here must surface as non-2xx. Returning `{ ok: false }` with HTTP 200
 * previously let the admin UI and any caller record a failed run as a success.
 */
@Controller('api/collector')
export class CollectorController {
  constructor(private readonly collectorService: CollectorService) {}

  @NeedLogin()
  @Post('run')
  async runPipeline(): Promise<{ ok: true; accepted: true; message: string }> {
    let result: { accepted: boolean; reason?: string };
    try {
      result = await this.collectorService.startPipelineDetached('manual');
    } catch (error: unknown) {
      throw new HttpException(
        {
          ok: false,
          message: `Failed to start pipeline: ${error instanceof Error ? error.message : String(error)}`,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }

    if (!result.accepted) {
      // A run already in flight is a conflict, not a success.
      throw new HttpException(
        { ok: false, message: result.reason ?? 'Pipeline not accepted' },
        HttpStatus.CONFLICT,
      );
    }

    return {
      ok: true,
      accepted: true,
      message:
        'Pipeline accepted and running in the background; poll GET /api/collector/status for the outcome',
    };
  }

  /** Lets callers observe the real outcome of a detached run. */
  @NeedLogin()
  @Get('status')
  async getStatus(): Promise<{
    ok: true;
    state: Record<string, unknown> | null;
  }> {
    try {
      return { ok: true, state: await this.collectorService.getRunState() };
    } catch (error: unknown) {
      throw new HttpException(
        {
          ok: false,
          message: error instanceof Error ? error.message : String(error),
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @NeedLogin()
  @Post('select-front-page')
  async selectFrontPage(): Promise<{ ok: true; message: string }> {
    try {
      await this.collectorService.selectForFrontPage();
      return { ok: true, message: 'Front page selection completed' };
    } catch (error: unknown) {
      throw new HttpException(
        {
          ok: false,
          message: error instanceof Error ? error.message : String(error),
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @NeedLogin()
  @Post('rescore-pending')
  async rescorePending(): Promise<{
    ok: true;
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
      throw new HttpException(
        {
          ok: false,
          message: error instanceof Error ? error.message : String(error),
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}
