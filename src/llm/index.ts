import type {
  AdjustRequest,
  LlmOutcome,
  OrganizeRequest,
  ShiyanLlmBinding,
} from '../shared/llm';
import { ShiyanLlmGateway, resolveLlmSlots, type LlmEnvLike } from '../shared/llmGateway';

export type { AdjustRequest, LlmOutcome, OrganizeRequest } from '../shared/llm';

/**
 * In-process LLM service boundary for Cloud Shiyan.
 *
 * Provider configuration and keys remain runtime bindings/secrets owned by
 * this module. The business layer receives only normalized LLM outcomes.
 * Keeping this contract independent of D1/CaptureTask state preserves a clean
 * extraction point if a real isolation or reuse requirement later justifies a
 * separate deployment unit again.
 */
export function createShiyanLlmService(env: LlmEnvLike): ShiyanLlmBinding {
  const gateway = new ShiyanLlmGateway(resolveLlmSlots(env));
  return {
    generateStructured(input: OrganizeRequest): Promise<LlmOutcome> {
      return gateway.generateStructured(input);
    },
    adjustDraft(input: AdjustRequest): Promise<LlmOutcome> {
      return gateway.adjustDraft(input);
    },
  };
}
