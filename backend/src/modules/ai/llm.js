import { env } from '../../config/env.js';
import { AppError } from '../../http/errors.js';

const MAX_RETRIES = 4;

export class LlmError extends AppError {
  constructor(status, message) {
    super(status === 429 ? 503 : 502, status === 429 ? 'AI_RATE_LIMITED' : 'AI_PROVIDER_ERROR', message);
  }
}

/** Minimal client for any OpenAI-compatible /chat/completions endpoint (Groq, Gemini, OpenRouter, OpenAI...). */
export class LlmClient {
  baseUrl;
  apiKey;
  model;
  reasoningEffort;

  constructor(baseUrl, apiKey, model, reasoningEffort) {
    this.baseUrl = baseUrl;
    this.apiKey = apiKey;
    this.model = model;
    this.reasoningEffort = reasoningEffort;
  }

  /** Free tiers rate-limit by tokens per minute; wait as instructed and retry a few times before giving up. */
  async chat(options, attempt = 0) {
    try {
      return await this.#request(options);
    } catch (error) {
      if (!(error instanceof LlmError) || error.code !== 'AI_RATE_LIMITED' || attempt >= MAX_RETRIES) throw error;
      const seconds = Number(/try again in ([\d.]+)s/i.exec(error.message)?.[1] ?? 10);
      const waitMs = Math.min(Math.ceil(seconds * 1000) + 500, 30_000);
      console.warn(`[llm] rate limited, retrying in ${Math.round(waitMs / 1000)}s (attempt ${attempt + 1}/${MAX_RETRIES})`);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      return this.chat(options, attempt + 1);
    }
  }

  async #request(options) {
    let response;
    try {
      response = await fetch(`${this.baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          messages: options.messages,
          temperature: options.temperature ?? 0,
          max_tokens: options.maxTokens ?? 1500,
          ...(options.tools ? { tools: options.tools, tool_choice: 'auto' } : {}),
          ...(options.json ? { response_format: { type: 'json_object' } } : {}),
          ...(this.reasoningEffort ? { reasoning_effort: this.reasoningEffort } : {}),
        }),
        signal: AbortSignal.timeout(60_000),
      });
    } catch (error) {
      throw new LlmError(502, `LLM provider unreachable: ${error.message}`);
    }
    const body = await response.json().catch(() => ({}));

    const message = body.choices?.[0]?.message;
    if (!response.ok || !message) {
      throw new LlmError(
        response.status,
        `LLM request failed (${response.status}): ${body.error?.message ?? 'no completion returned'}`,
      );
    }
    // Keep only standard fields: some models add e.g. `reasoning`, which providers reject when it is sent back.
    return {
      role: 'assistant',
      content: message.content ?? null,
      ...(message.tool_calls?.length ? { tool_calls: message.tool_calls } : {}),
    };
  }
}

export function getLlm() {
  return env.LLM_API_KEY
    ? new LlmClient(env.LLM_BASE_URL, env.LLM_API_KEY, env.LLM_MODEL, env.LLM_REASONING_EFFORT)
    : null;
}

/** Parses a JSON object out of a completion, tolerating ```json fences. */
export function parseJsonObject(content) {
  const text = (content ?? '')
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```$/, '')
    .trim();
  try {
    return JSON.parse(text);
  } catch {
    throw new LlmError(502, 'LLM returned malformed JSON');
  }
}
