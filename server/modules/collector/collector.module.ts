import { Module } from '@nestjs/common';
import { FeedSourceModule } from '../feed-source/feed-source.module';
import { DigestModule } from '../digest/digest.module';
import { ReviewModule } from '../review/review.module';
import {
  AiScoringService,
  AGENT_GATEWAY_TOKEN,
  AGENT_INVOCATION_OPTIONS_TOKEN,
  AGENT_REGISTRY_TOKEN,
} from './ai-scoring.service';
import { createAgentGateway, createAgentRegistry } from './agents';
import type { AgentInvocationOptions, AgentRegistry } from './agents';
import { CapabilityService } from '../../infrastructure/capability.service';
import { CollectorService } from './collector.service';
import { CollectorController } from './collector.controller';
import { CollectorAutomation } from './collector.automation';

@Module({
  imports: [FeedSourceModule, DigestModule, ReviewModule],
  controllers: [CollectorController],
  providers: [
    { provide: AGENT_REGISTRY_TOKEN, useFactory: createProductionAgentRegistry },
    {
      provide: AGENT_INVOCATION_OPTIONS_TOKEN,
      inject: [CapabilityService],
      useFactory: (capabilityService: CapabilityService) => ({
        environment: process.env,
        adapters: { capability: capabilityService },
      }),
    },
    {
      provide: AGENT_GATEWAY_TOKEN,
      inject: [AGENT_REGISTRY_TOKEN, AGENT_INVOCATION_OPTIONS_TOKEN],
      useFactory: (registry: AgentRegistry, options: AgentInvocationOptions) =>
        createAgentGateway(registry, options),
    },
    AiScoringService,
    CollectorService,
    CollectorAutomation,
  ],
  exports: [AiScoringService],
})
export class CollectorModule {}

function createProductionAgentRegistry(): AgentRegistry {
  const providerUrl = process.env.AI_PROVIDER_URL?.trim();
  const providerKey = process.env.AI_PROVIDER_API_KEY?.trim();
  if (!providerUrl || !providerKey) {
    return createAgentRegistry({ environment: process.env });
  }

  const verifiedAt = new Date().toISOString();
  return createAgentRegistry({
    environment: process.env,
    overrides: {
      content_evaluator: {
        enabled: true,
        status: 'active',
        provider: 'openai-compatible',
        model: process.env.AI_PROVIDER_MODEL || 'deepseek-v4-flash',
        secretRef: { kind: 'env', name: 'AI_PROVIDER_API_KEY' },
        verification: {
          status: 'verified',
          verifiedAt,
          verifier: 'ai-provider-env',
          evidence: ['AI_PROVIDER_URL'],
        },
        capability: {
          capabilityId: 'ai_article_scoring_1',
          action: 'textToJson',
          invocation: 'available',
          inputContract: 'ContractArticleInput + ContentFilterOutput',
          outputContract: 'ContentEvaluationOutput',
        },
      },
    },
  });
}
