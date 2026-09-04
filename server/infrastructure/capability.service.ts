import { Injectable } from '@nestjs/common';

export interface CapabilityExecutor {
  call(action: string, input: unknown, context?: unknown): Promise<unknown>;
}

/** Local provider bridge. It optionally calls an HTTP AI provider and never
 * depends on a hosting platform SDK. */
@Injectable()
export class CapabilityService {
  load(capabilityId: string): CapabilityExecutor {
    return {
      call: async (action: string, input: unknown) => {
        const endpoint = process.env[`${capabilityId.toUpperCase()}_URL`] ||
          process.env.AI_PROVIDER_URL;
        if (!endpoint) throw new Error(`No provider configured for ${capabilityId}`);
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(process.env.AI_PROVIDER_API_KEY ? { authorization: `Bearer ${process.env.AI_PROVIDER_API_KEY}` } : {}) },
          body: JSON.stringify({ capabilityId, action, input }),
        });
        if (!response.ok) throw new Error(`AI provider returned ${response.status}`);
        return response.json();
      },
    };
  }
}
