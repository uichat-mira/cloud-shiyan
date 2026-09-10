import type {
  AdjustRequest,
  LlmOutcome,
  OrganizeRequest,
} from './llm';
import { renderOrganizedMarkdown } from './llmMarkdown';
import { buildAdjustMessages, buildOrganizeMessages } from './llmPrompts';
import {
  parseStructuredContent,
  validateStructuredOrganization,
} from './llmSchema';
import { validateSceneSpec, type SceneSpec } from './scenes';
import {
  OpenAiCompatibleChatProvider,
  type FetchLike,
} from './openAiCompatible';

export interface LlmProviderSlot {
  provider: string;
  baseUrl: string;
  model: string;
  apiKey: string;
}

export interface LlmGatewaySlots {
  primary: LlmProviderSlot | null;
  fallback: LlmProviderSlot | null;
  timeoutMs: number;
  maxTranscriptChars: number;
}

export interface LlmEnvLike {
  LLM_PRIMARY_PROVIDER?: string;
  LLM_PRIMARY_BASE_URL?: string;
  LLM_PRIMARY_MODEL?: string;
  LLM_PRIMARY_API_KEY?: string;
  LLM_FALLBACK_PROVIDER?: string;
  LLM_FALLBACK_BASE_URL?: string;
  LLM_FALLBACK_MODEL?: string;
  LLM_FALLBACK_API_KEY?: string;
  LLM_TIMEOUT_MS?: string;
  LLM_MAX_TRANSCRIPT_CHARS?: string;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_TRANSCRIPT_CHARS = 200_000;

const parsePositiveInt = (value: string | undefined, fallback: number): number => {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const resolveSlot = (
  env: LlmEnvLike,
  role: 'PRIMARY' | 'FALLBACK',
): LlmProviderSlot | null => {
  const provider = env[`LLM_${role}_PROVIDER`]?.trim() || role.toLowerCase();
  const baseUrl = env[`LLM_${role}_BASE_URL`]?.trim();
  const model = env[`LLM_${role}_MODEL`]?.trim();
  const apiKey = env[`LLM_${role}_API_KEY`]?.trim();

  // Provider is only an observability label. A usable OpenAI-compatible slot
  // needs endpoint + model + key; fallback may be left entirely unconfigured.
  if (!baseUrl || !model || !apiKey) return null;
  return { provider, baseUrl, model, apiKey };
};

export const resolveLlmSlots = (env: LlmEnvLike): LlmGatewaySlots => ({
  primary: resolveSlot(env, 'PRIMARY'),
  fallback: resolveSlot(env, 'FALLBACK'),
  timeoutMs: parsePositiveInt(env.LLM_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
  maxTranscriptChars: parsePositiveInt(
    env.LLM_MAX_TRANSCRIPT_CHARS,
    DEFAULT_MAX_TRANSCRIPT_CHARS,
  ),
});

const invalidRequest = (message: string): LlmOutcome => ({
  ok: false,
  error: { kind: 'terminal', code: 'invalid_request', message },
});

/**
 * Primary + fallback gateway for the private `shiyan-llm` Worker.
 *
 * Fallback rules (MOB-020): only clearly retryable / provider-unavailable
 * failures fail over. Schema, prompt and business input errors are terminal
 * and are returned as-is so they are never masked by a second provider.
 */
export class ShiyanLlmGateway {
  constructor(
    private readonly slots: LlmGatewaySlots,
    private readonly fetchLike: FetchLike = fetch,
  ) {}

  async generateStructured(input: OrganizeRequest): Promise<LlmOutcome> {
    const common = this.validateCommon(input);
    if (!common.ok) return common;
    const messages = buildOrganizeMessages(
      input.scene,
      input.title,
      input.transcriptText,
      input.language,
    );
    return this.run(messages, input.scene, input.title);
  }

  async adjustDraft(input: AdjustRequest): Promise<LlmOutcome> {
    const common = this.validateCommon(input);
    if (!common.ok) return common;

    const instruction = input.instruction?.trim();
    if (!instruction || instruction.length > 2000) {
      return invalidRequest(
        'instruction must be a non-empty string of at most 2000 characters',
      );
    }
    if (
      typeof input.currentDraft?.structured !== 'object' ||
      input.currentDraft.structured === null ||
      Array.isArray(input.currentDraft.structured)
    ) {
      return invalidRequest('currentDraft.structured must be an object');
    }

    const messages = buildAdjustMessages(
      input.scene,
      input.title,
      input.transcriptText,
      JSON.stringify(input.currentDraft.structured),
      instruction,
      input.language,
    );
    return this.run(messages, input.scene, input.title);
  }

  private validateCommon(input: OrganizeRequest): LlmOutcome | { ok: true } {
    const scene = validateSceneSpec(input.scene);
    if (!scene.ok) {
      return invalidRequest(`scene is invalid: ${scene.issues.join('; ')}`);
    }
    if (!input.transcriptText?.trim()) {
      return invalidRequest('transcriptText must be a non-empty string');
    }
    if (input.transcriptText.length > this.slots.maxTranscriptChars) {
      return invalidRequest(
        `transcriptText exceeds ${this.slots.maxTranscriptChars} characters`,
      );
    }
    if (!input.title?.trim()) {
      return invalidRequest('title must be a non-empty string');
    }
    return { ok: true };
  }

  private async run(
    messages: { system: string; user: string },
    scene: SceneSpec,
    title: string,
  ): Promise<LlmOutcome> {
    if (!this.slots.primary && !this.slots.fallback) {
      return {
        ok: false,
        error: {
          kind: 'retryable',
          code: 'not_configured',
          message: 'no LLM provider is configured with base URL, model and API key',
        },
      };
    }

    const attempts = [this.slots.primary, this.slots.fallback];
    let lastError: import('./llm').LlmFailure | null = null;
    for (let index = 0; index < attempts.length; index += 1) {
      const slot = attempts[index];
      if (!slot) continue;

      const provider = new OpenAiCompatibleChatProvider(
        {
          provider: slot.provider,
          baseUrl: slot.baseUrl,
          model: slot.model,
          apiKey: slot.apiKey,
          timeoutMs: this.slots.timeoutMs,
        },
        this.fetchLike,
      );
      const call = await provider.complete({
        systemPrompt: messages.system,
        userPrompt: messages.user,
      });

      if (!call.ok) {
        lastError = call.error;
        const canFailOver =
          call.error.kind === 'retryable' && attempts.slice(index + 1).some(Boolean);
        if (!canFailOver) return { ok: false, error: call.error };
        continue;
      }

      const parsed = parseStructuredContent(call.content);
      if (!parsed.ok) {
        return {
          ok: false,
          error: {
            kind: 'terminal',
            code: 'invalid_response',
            message: `${call.provider}: ${parsed.message}`,
          },
        };
      }

      const validated = validateStructuredOrganization(scene, parsed.value);
      if (!validated.ok) {
        return {
          ok: false,
          error: {
            kind: 'terminal',
            code: 'invalid_response',
            message: `structured output failed validation: ${validated.issues.join('; ')}`,
          },
        };
      }

      return {
        ok: true,
        value: {
          markdown: renderOrganizedMarkdown(title, scene, validated.value),
          structured: validated.value,
          provider: call.provider,
          model: call.model,
          latencyMs: call.latencyMs,
          ...(call.usage ? { usage: call.usage } : {}),
          ...(call.providerRequestId
            ? { providerRequestId: call.providerRequestId }
            : {}),
          fallbackUsed: index > 0,
        },
      };
    }

    return {
      ok: false,
      error: {
        kind: 'retryable',
        code: 'provider_error',
        message: 'all configured LLM providers failed with retryable errors',
      },
    };
  }
}
