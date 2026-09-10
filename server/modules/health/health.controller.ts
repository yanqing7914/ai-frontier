import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import type { Response } from 'express';

@Controller('health')
export class HealthController {
  @Get()
  getHealth(@Res({ passthrough: true }) response?: Response) {
    const databaseConfigured = Boolean(process.env.DATABASE_URL || process.env.SUDA_DATABASE_URL);
    const ready = databaseConfigured;
    if (!ready) response?.status(HttpStatus.OK);
    return {
      // Keep the liveness contract stable; readiness carries dependency state.
      status: 'ok',
      service: 'ai-frontier',
      readiness: {
        status: ready ? 'ready' : 'degraded',
        database: databaseConfigured ? 'configured' : 'missing',
      },
      timestamp: new Date().toISOString(),
    };
  }
}
