import { Injectable, Logger } from '@nestjs/common';

export interface CapabilityExecutor {
  call(action: string, input: unknown, context?: unknown): Promise<unknown>;
}

interface ChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string | Array<{ type?: string; text?: string }>;
    };
  }>;
}

const SCORING_JSON_INSTRUCTIONS = `You score AI-news articles. Reply with JSON only, no markdown.
Schema:
{
  "summary": string, // <= 200 chars, grounded in the article, Chinese if the article is Chinese
  "scores": {
    "model": {"entity":0|2.5|5,"capability":0|2.5|5,"availability":0|2.5|5,"performance":0|2.5|5,"cost":0|2.5|5,"ecosystem":0|2.5|5,"adoption":0|2.5|5},
    "agent": {"task_boundary":0|2.5|5,"tool_call":0|2.5|5,"protocol":0|2.5|5,"orchestration":0|2.5|5,"observability":0|2.5|5,"production":0|2.5|5,"benchmark":0|2.5|5,"workflow":0|2.5|5},
    "multimodal": {"modality_coverage":0|2.5|5,"io_capability":0|2.5|5,"quality":0|2.5|5,"realtime":0|2.5|5,"editing":0|2.5|5,"3d_world":0|2.5|5,"safety_copyright":0|2.5|5,"product":0|2.5|5},
    "coding": {"code_gen":0|2.5|5,"repo_understanding":0|2.5|5,"engineering":0|2.5|5,"ide_integration":0|2.5|5,"delivery":0|2.5|5,"benchmark":0|2.5|5,"cost_speed":0|2.5|5,"security":0|2.5|5},
    "infrastructure": {"hardware":0|2.5|5,"training":0|2.5|5,"performance":0|2.5|5,"cost":0|2.5|5,"software_stack":0|2.5|5,"cloud":0|2.5|5,"edge":0|2.5|5,"ops":0|2.5|5},
    "data_eval": {"data_asset":0|2.5|5,"coverage":0|2.5|5,"methodology":0|2.5|5,"reproducibility":0|2.5|5,"performance":0|2.5|5,"quality":0|2.5|5,"governance":0|2.5|5,"decision_value":0|2.5|5},
    "safety_governance": {"risk_type":0|2.5|5,"controls":0|2.5|5,"verification":0|2.5|5,"privacy":0|2.5|5,"copyright":0|2.5|5,"regulation":0|2.5|5,"framework":0|2.5|5,"deployment_impact":0|2.5|5},
    "applications": {"industry":0|2.5|5,"business_problem":0|2.5|5,"launch_status":0|2.5|5,"scale":0|2.5|5,"roi":0|2.5|5,"workflow_change":0|2.5|5,"replicability":0|2.5|5,"risk_responsibility":0|2.5|5},
    "business_ecosystem": {"business_fact":0|2.5|5,"entity_market":0|2.5|5,"strategy":0|2.5|5,"business_model":0|2.5|5,"market_landscape":0|2.5|5,"open_source":0|2.5|5,"talent":0|2.5|5,"signal":0|2.5|5}
  },
  "evidence": [
    {
      "direction": string,
      "dimension": string,
      "score": 2.5|5,
      "quote": string, // MUST be an exact substring of article_text
      "subject": string,
      "predicate": string,
      "object": string,
      "certainty": "fact",
      "fields": object
    }
  ]
}
Rules:
- Score 5 only for a direct, present-tense fact in the article. 2.5 for a weak but grounded hint. 0 if absent.
- Every non-zero dimension MUST have one evidence item whose quote is copied verbatim from article_text.
- Do not invent launches, metrics, companies, or quotes.
- If the article is off-topic, keep scores at 0 and write a short grounded summary.`;

function chatCompletionsUrl(endpoint: string): string {
  const trimmed = endpoint.replace(/\/+$/, '');
  if (trimmed.endsWith('/chat/completions')) return trimmed;
  if (trimmed.endsWith('/v1')) return `${trimmed}/chat/completions`;
  return `${trimmed}/v1/chat/completions`;
}

function messageText(payload: ChatCompletionResponse): string {
  const content = payload.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part?.text === 'string' ? part.text : ''))
      .join('');
  }
  return '';
}

function parseJsonContent(raw: string): unknown {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : trimmed;
  return JSON.parse(candidate);
}

function scoringUserPrompt(input: unknown): string {
  if (input && typeof input === 'object' && 'article_text' in input) {
    return `article_text:\n${String((input as { article_text: unknown }).article_text)}`;
  }
  return typeof input === 'string' ? input : JSON.stringify(input);
}

/** Local provider bridge. It optionally calls an HTTP AI provider and never
 * depends on a hosting platform SDK. */
@Injectable()
export class CapabilityService {
  private readonly logger = new Logger(CapabilityService.name);

  load(capabilityId: string): CapabilityExecutor {
    return {
      call: async (action: string, input: unknown) => {
        const endpoint =
          process.env[`${capabilityId.toUpperCase()}_URL`] ||
          process.env.AI_PROVIDER_URL;
        if (!endpoint) throw new Error(`No provider configured for ${capabilityId}`);
        const apiKey = process.env.AI_PROVIDER_API_KEY;
        const protocol = (process.env.AI_PROVIDER_PROTOCOL || 'openai').toLowerCase();
        if (protocol === 'legacy') {
          return this.callLegacy(endpoint, apiKey, capabilityId, action, input);
        }
        return this.callOpenAiCompatible(endpoint, apiKey, capabilityId, action, input);
      },
    };
  }

  private async callLegacy(
    endpoint: string,
    apiKey: string | undefined,
    capabilityId: string,
    action: string,
    input: unknown,
  ): Promise<unknown> {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({ capabilityId, action, input }),
    });
    if (!response.ok) throw new Error(`AI provider returned ${response.status}`);
    return response.json();
  }

  private async callOpenAiCompatible(
    endpoint: string,
    apiKey: string | undefined,
    capabilityId: string,
    action: string,
    input: unknown,
  ): Promise<unknown> {
    const model = process.env.AI_PROVIDER_MODEL || 'deepseek-v4-flash';
    const system =
      capabilityId === 'ai_article_scoring_1' && action === 'textToJson'
        ? SCORING_JSON_INSTRUCTIONS
        : `Return JSON only for capability ${capabilityId} action ${action}.`;
    const response = await fetch(chatCompletionsUrl(endpoint), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: scoringUserPrompt(input) },
        ],
      }),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      this.logger.warn(`AI provider returned ${response.status}`);
      throw new Error(`AI provider returned ${response.status}${detail ? `: ${detail.slice(0, 180)}` : ''}`);
    }
    const payload = (await response.json()) as ChatCompletionResponse;
    const raw = messageText(payload);
    if (!raw.trim()) throw new Error('AI provider returned an empty completion');
    try {
      return parseJsonContent(raw);
    } catch {
      throw new Error('AI provider returned non-JSON content');
    }
  }
}
