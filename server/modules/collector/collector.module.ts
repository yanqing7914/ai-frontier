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
    { provide: AGENT_REGISTRY_TOKEN, useFactory: () => createAgentRegistry() },
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
