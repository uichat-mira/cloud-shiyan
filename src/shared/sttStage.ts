import type { SttFailure, SttProvider, SttRequest, SttSuccess } from './stt';

export type SttStageExecution =
  | { ok: true; artifactKey: string }
  | { ok: false; error: SttFailure };

export interface SttStageHooks {
  markRunning(): Promise<void>;
  persistArtifact(value: SttSuccess): Promise<string>;
  markSucceeded(artifactKey: string): Promise<void>;
  markFailed(error: SttFailure): Promise<void>;
}

const unexpectedProviderFailure = (error: unknown): SttFailure => ({
  kind: 'retryable',
  code: 'stt_provider_exception',
  message: error instanceof Error ? error.message : 'STT provider threw an unexpected error',
});

const artifactPersistenceFailure = (error: unknown): SttFailure => ({
  kind: 'retryable',
  code: 'stt_artifact_persist_failed',
  message: error instanceof Error ? error.message : 'STT evidence artifact could not be persisted',
});

export async function executeSttStage(
  provider: SttProvider,
  request: SttRequest,
  hooks: SttStageHooks,
): Promise<SttStageExecution> {
  await hooks.markRunning();

  let result;
  try {
    result = await provider.transcribe(request);
  } catch (error) {
    const failure = unexpectedProviderFailure(error);
    await hooks.markFailed(failure);
    return { ok: false, error: failure };
  }

  if (!result.ok) {
    await hooks.markFailed(result.error);
    return { ok: false, error: result.error };
  }

  let artifactKey: string;
  try {
    artifactKey = await hooks.persistArtifact(result.value);
  } catch (error) {
    const failure = artifactPersistenceFailure(error);
    await hooks.markFailed(failure);
    return { ok: false, error: failure };
  }

  await hooks.markSucceeded(artifactKey);
  return { ok: true, artifactKey };
}
