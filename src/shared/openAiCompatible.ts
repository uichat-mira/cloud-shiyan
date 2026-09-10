import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { generateText } from 'ai';
import type { LlmFailure, LlmUsage } from './llm';

export type FetchLike = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<Response>;

export interface OpenAiCompatConfig {
  provider: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  timeoutMs: number;
}

export interface LlmCallInput {
  systemPrompt: string;
  userPrompt: string;
}

export type LlmCallResult =
  | {
      ok: true;
      content: string;
      provider: string;
      model: string;
      latencyMs: number;
      usage?: LlmUsage;
      providerRequestId?: string;
    }
  | { ok: false; error: LlmFailure };

type ErrorLike = {
  name?: unknown;
  statusCode?: unknown;
  cause?: unknown;
};

const errorChain = (error: unknown): unknown[] => {
  const chain: unknown[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;

  while (current && !seen.has(current)) {
    chain.push(current);
    seen.add(current);
    if (typeof current !== 'object') break;
    current = (current as ErrorLike).cause;
  }

  return chain;
};

const errorName = (error: unknown): string => {
  if (!error || typeof error !== 'object') return '';
  const name = (error as ErrorLike).name;
  return typeof name === 'string' ? name : '';
};

const statusCodeFrom = (error: unknown): number | null => {
  for (const item of errorChain(error)) {
    if (!item || typeof item !== 'object') continue;
    const statusCode = (item as ErrorLike).statusCode;
    if (typeof statusCode === 'number') return statusCode;
  }
  return null;
};

const isAbort = (error: unknown): boolean =>
  errorChain(error).some((item) => {
    if (item instanceof DOMException && item.name === 'AbortError') return true;
    return errorName(item) === 'AbortError';
  });

const isInvalidProviderPayload = (error: unknown): boolean =>
  errorChain(error).some((item) => {
    const name = errorName(item);
    return (
      name.includes('JSONParseError') ||
      name.includes('TypeValidationError') ||
      name.includes('NoContentGeneratedError')
    );
  });

const toSdkFetch = (fetchLike: FetchLike): typeof fetch =>
  async (input, init) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;

    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    let body: string | undefined;
    if (typeof init?.body === 'string') {
      body = init.body;
    } else if (init?.body != null) {
      body = await new Response(init.body).text();
    }

    return fetchLike(url, {
      ...(init?.method ? { method: init.method } : {}),
      headers,
      ...(body !== undefined ? { body } : {}),
      ...(init?.signal ? { signal: init.signal } : {}),
    });
  };

/**
 * OpenAI-compatible chat adapter backed by the Vercel AI SDK.
 *
 * The SDK owns the wire protocol, request serialization and provider response
 * decoding. Shiyan still owns business validation, normalized failure semantics
 * and primary -> fallback routing in ShiyanLlmGateway.
 */
export class OpenAiCompatibleChatProvider {
  constructor(
    private readonly config: OpenAiCompatConfig,
    private readonly fetchLike: FetchLike = fetch,
  ) {}

  async complete(input: LlmCallInput): Promise<LlmCallResult> {
    const startedAt = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);

    const provider = createOpenAICompatible({
      name: this.config.provider,
      baseURL: this.config.baseUrl,
      apiKey: this.config.apiKey,
      fetch: toSdkFetch(this.fetchLike),
      // MOB-020 expects a JSON object. Keep that wire-level hint here while
      // retaining Shiyan's own parser/schema validator as the source of truth.
      transformRequestBody: (body) => ({
        ...body,
        response_format: { type: 'json_object' },
      }),
    });

    try {
      const result = await generateText({
        model: provider.chatModel(this.config.model),
        system: input.systemPrompt,
        prompt: input.userPrompt,
        temperature: 0.2,
        // Organize/adjust responses are small structured JSON. Bound output so
        // a reasoning-heavy or misrouted provider cannot burn thousands of
        // completion tokens before the request timeout.
        maxOutputTokens: 1200,
        // ShiyanLlmGateway owns failover. Disable SDK retries so one provider
        // attempt cannot silently multiply requests before fallback begins.
        maxRetries: 0,
        abortSignal: controller.signal,
      });

      const content = result.text;
      if (!content.trim()) {
        return {
          ok: false,
          error: {
            kind: 'terminal',
            code: 'invalid_response',
            message: `${this.config.provider} returned no completion content`,
          },
        };
      }

      const usage = result.usage;
      const normalizedUsage: LlmUsage = {
        ...(typeof usage.inputTokens === 'number'
          ? { promptTokens: usage.inputTokens }
          : {}),
        ...(typeof usage.outputTokens === 'number'
          ? { completionTokens: usage.outputTokens }
          : {}),
        ...(typeof usage.totalTokens === 'number'
          ? { totalTokens: usage.totalTokens }
          : {}),
      };

      return {
        ok: true,
        content,
        provider: this.config.provider,
        model: this.config.model,
        latencyMs: Date.now() - startedAt,
        ...(Object.keys(normalizedUsage).length > 0
          ? { usage: normalizedUsage }
          : {}),
        ...(result.response?.id
          ? { providerRequestId: result.response.id }
          : {}),
      };
    } catch (error) {
      // A malformed HTTP-200 provider response is a provider-output contract
      // failure, not an invalid Shiyan request. AI SDK can attach statusCode=200
      // to its parse/validation error, so classify payload failures first.
      if (isInvalidProviderPayload(error)) {
        return {
          ok: false,
          error: {
            kind: 'terminal',
            code: 'invalid_response',
            message: `${this.config.provider} returned an invalid OpenAI-compatible response`,
          },
        };
      }
      const status = statusCodeFrom(error);
      if (status !== null) {
        return { ok: false, error: this.httpFailure(status) };
      }
      if (isAbort(error)) {
        return {
          ok: false,
          error: {
            kind: 'retryable',
            code: 'timeout',
            message: `${this.config.provider} request timed out after ${this.config.timeoutMs}ms`,
          },
        };
      }
      return {
        ok: false,
        error: {
          kind: 'retryable',
          code: 'provider_error',
          message: `${this.config.provider} request failed before a valid response arrived`,
        },
      };
    } finally {
      clearTimeout(timer);
    }
  }

  private httpFailure(status: number): LlmFailure {
    const provider = this.config.provider;
    if (status === 429) {
      return {
        kind: 'retryable',
        code: 'rate_limited',
        message: `${provider} rate limited the request (HTTP 429)`,
      };
    }
    if (status >= 500) {
      return {
        kind: 'retryable',
        code: 'provider_error',
        message: `${provider} returned HTTP ${status}`,
      };
    }
    if (status === 401 || status === 403) {
      return {
        kind: 'terminal',
        code: 'provider_error',
        message: `${provider} rejected the configured credential (HTTP ${status})`,
      };
    }
    return {
      kind: 'terminal',
      code: 'invalid_request',
      message: `${provider} rejected the request (HTTP ${status})`,
    };
  }
}
