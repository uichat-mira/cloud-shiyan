export interface OrganizeRequest {
  taskId: string;
  sceneId: string;
  transcriptId: string;
}

export interface OrganizeResult {
  markdown: string;
  structured: Record<string, unknown>;
  provider: string;
  latencyMs: number;
}

/**
 * Logical LLM service boundary for Cloud Shiyan.
 *
 * The old deployment exposed this contract through a private Worker and Service
 * Binding. Cloud Shiyan keeps the module boundary but deliberately does not
 * create a second deployment unit until there is a real isolation/reuse need.
 *
 * Provider selection, secrets, fallback and structured validation are not
 * implemented in the source runtime yet, so bootstrap must not fake them.
 */
export async function generateStructured(_input: OrganizeRequest): Promise<OrganizeResult> {
  throw new Error('provider_not_configured');
}
