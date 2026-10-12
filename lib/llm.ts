/**
 * Provider-agnostic chat-completion client (OpenAI-compatible API: OpenAI, DeepSeek, 通义千问 DashScope
 * compatible-mode, Moonshot, local vLLM/Ollama …).
 *
 *   LLM_BASE_URL   e.g. https://api.deepseek.com/v1 | https://dashscope.aliyuncs.com/compatible-mode/v1 | https://api.openai.com/v1
 *   LLM_API_KEY    secret key (never logged)
 *   LLM_MODEL      e.g. deepseek-chat | qwen-plus | gpt-4o-mini
 *   LLM_MOCK=1     force the offline mock provider (default when no key is set)
 *   LLM_TIMEOUT_MS request timeout (default 120000)
 *   LLM_JSON_MODE  set to 0 if a provider rejects response_format={type:json_object}
 *
 * Responses can be cached by the caller (see CAREER/curriculum/cache.ts) — this module never retries a
 * successful call, and retries 429/5xx at most twice.
 */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}
export interface ChatResult {
  text: string;
  model: string;
  promptTokens?: number;
  completionTokens?: number;
}
export interface ChatProvider {
  /** model identifier recorded in provenance ('mock' for the mock provider) */
  readonly model: string;
  readonly isMock: boolean;
  chat(messages: ChatMessage[], opts?: { json?: boolean; temperature?: number }): Promise<ChatResult>;
}

export class OpenAICompatibleProvider implements ChatProvider {
  readonly isMock = false;
  constructor(
    private baseUrl: string,
    private apiKey: string,
    readonly model: string,
    private timeoutMs = Number(process.env.LLM_TIMEOUT_MS ?? 120000),
    private jsonMode = process.env.LLM_JSON_MODE !== '0',
  ) {}

  async chat(messages: ChatMessage[], opts: { json?: boolean; temperature?: number } = {}): Promise<ChatResult> {
    const body: Record<string, unknown> = { model: this.model, messages, temperature: opts.temperature ?? 0 };
    if (opts.json && this.jsonMode) body.response_format = { type: 'json_object' };
    for (let attempt = 0; ; attempt++) {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), this.timeoutMs);
      try {
        const res = await fetch(this.baseUrl.replace(/\/+$/, '') + '/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
          body: JSON.stringify(body),
          signal: ctl.signal,
        });
        if ((res.status === 429 || res.status >= 500) && attempt < 2) {
          await new Promise((r) => setTimeout(r, 5000 * (attempt + 1)));
          continue;
        }
        const j = (await res.json().catch(() => ({}))) as {
          choices?: { message?: { content?: string } }[];
          model?: string;
          usage?: { prompt_tokens?: number; completion_tokens?: number };
          error?: { message?: string };
        };
        if (!res.ok) throw new Error(`LLM HTTP ${res.status}: ${j.error?.message ?? 'error'}`);
        return {
          text: j.choices?.[0]?.message?.content ?? '',
          model: j.model ?? this.model,
          promptTokens: j.usage?.prompt_tokens,
          completionTokens: j.usage?.completion_tokens,
        };
      } finally {
        clearTimeout(t);
      }
    }
  }
}

/** Offline stand-in: returns whatever `respond` produces. Output is always flagged as mock downstream. */
export class MockProvider implements ChatProvider {
  readonly isMock = true;
  readonly model = 'mock';
  constructor(private respond: (messages: ChatMessage[]) => string) {}
  async chat(messages: ChatMessage[]): Promise<ChatResult> {
    return { text: this.respond(messages), model: 'mock' };
  }
}

export function llmConfigured(env = process.env): boolean {
  return !!(env.LLM_API_KEY && env.LLM_BASE_URL && env.LLM_MODEL) && env.LLM_MOCK !== '1';
}

/** Real provider when LLM_* env is complete (and LLM_MOCK != 1), otherwise the given mock. */
export function providerFromEnv(mock: MockProvider, env = process.env): ChatProvider {
  if (!llmConfigured(env)) return mock;
  return new OpenAICompatibleProvider(env.LLM_BASE_URL!, env.LLM_API_KEY!, env.LLM_MODEL!);
}
