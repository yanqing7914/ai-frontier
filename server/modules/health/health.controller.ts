import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import type { Response } from 'express';
import { getAiProviderStatus } from '../../infrastructure/ai-provider-status';
import { DIRECTIONS } from '@shared/directions';
import { POST_PROCESSING_ROLES } from '../collector/architecture/contracts';

@Controller('health')
export class HealthController {
  @Get()
  getHealth(@Res({ passthrough: true }) response?: Response) {
    const databaseConfigured = Boolean(process.env.DATABASE_URL || process.env.SUDA_DATABASE_URL);
    const ready = databaseConfigured;
    const aiProvider = getAiProviderStatus();
    if (!ready) response?.status(HttpStatus.OK);
    return {
      // Keep the liveness contract stable; readiness carries dependency state.
      status: 'ok',
      service: 'ai-frontier',
      readiness: {
        status: ready ? 'ready' : 'degraded',
        database: databaseConfigured ? 'configured' : 'missing',
        aiScoring: aiProvider.scoringAgent.enabled ? 'ready' : 'disabled',
      },
      ai: {
        provider: {
          protocol: aiProvider.protocol,
          configured: aiProvider.providerConfigured,
          endpoint: aiProvider.endpointConfigured ? 'configured' : 'missing',
          apiKey: aiProvider.apiKeyConfigured ? 'configured' : 'missing',
          model: aiProvider.modelConfigured ? 'configured' : 'default',
        },
        scoringAgent: {
          role: 'content_evaluator',
          enabled: aiProvider.scoringAgent.enabled,
          invocation: aiProvider.scoringAgent.invocation,
          blockReason: aiProvider.scoringAgent.blockReason,
        },
        architecture: {
          directions: DIRECTIONS.length,
          postProcessingRoles: POST_PROCESSING_ROLES.length,
          externallyConfiguredRoles: aiProvider.scoringAgent.enabled ? 1 : 0,
        },
      },
      timestamp: new Date().toISOString(),
    };
  }
}
