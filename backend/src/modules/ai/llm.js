import { env } from '../../config/env.js';
import { AppError } from '../../http/errors.js';

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

  constructor(baseUrl, apiKey, model) {
    this.baseUrl = baseUrl;
    this.apiKey = apiKey;
    this.model = model;
  }

  async chat(options) {
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
    return message;
  }
}

export function getLlm() {
  return env.LLM_API_KEY ? new LlmClient(env.LLM_BASE_URL, env.LLM_API_KEY, env.LLM_MODEL) : null;
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
