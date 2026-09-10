import type { SttFailure, SttSuccess, TranscriptSegment } from '../shared/stt';
import { executeSttStage } from '../shared/sttStage';
import { WorkersAiSttProvider, type WorkersAiLike } from '../shared/workersAiStt';

type D1Value = string | number | null;

type D1Result<T = unknown> = {
  results?: T[];
  success: boolean;
};

export interface Mob019D1Statement {
  bind(...values: D1Value[]): Mob019D1Statement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  run<T = unknown>(): Promise<D1Result<T>>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
}

export interface Mob019D1 {
  prepare(sql: string): Mob019D1Statement;
  batch(statements: Mob019D1Statement[]): Promise<D1Result[]>;
}

export interface Mob019R2Object {
  size: number;
  etag: string;
  httpMetadata?: { contentType?: string };
}

export interface Mob019R2Body extends Mob019R2Object {
  arrayBuffer(): Promise<ArrayBuffer>;
  text(): Promise<string>;
}

export interface Mob019R2 {
  head(key: string): Promise<Mob019R2Object | null>;
  get(key: string): Promise<Mob019R2Body | null>;
  put(
    key: string,
    value: string | ArrayBuffer | ArrayBufferView,
    options?: { httpMetadata?: { contentType?: string } },
  ): Promise<unknown>;
  delete(key: string): Promise<void>;
}

export interface Mob019WorkflowBinding {
  create(input?: { id?: string; params?: Record<string, unknown> }): Promise<unknown>;
  get(id: string): Promise<unknown>;
}

export interface Mob019Env {
  DB: Mob019D1;
  AUDIO: Mob019R2;
  AI: WorkersAiLike;
  CAPTURE_WORKFLOW: Mob019WorkflowBinding;
}

export interface Mob019WorkflowPayload {
  taskId: string;
  objectKey: string;
  requestId?: string;
  startStage?: 'verify-audio' | 'transcribe';
  initialPrompt?: string;
}

export interface Mob019WorkflowStep {
  do<T>(name: string, callback: () => Promise<T>): Promise<T>;
}

type AssetRow = {
  id: string;
  task_id: string;
  object_key: string;
  content_type: string;
  expected_size_bytes: number | null;
  actual_size_bytes: number | null;
  etag: string | null;
  status: 'awaiting_upload' | 'uploaded' | 'confirmed' | 'rejected';
  retained: number;
  delete_after: string | null;
  deleted_at: string | null;
  confirmed_at: string | null;
};

type StageRow = {
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped';
  retryable: number;
  retry_count: number;
  error_code: string | null;
};

type TranscriptRow = {
  id: string;
  task_id: string;
  source_asset_id: string;
  text: string;
  language: string | null;
  duration_ms: number | null;
  provider: string;
  model: string;
  provider_request_id: string | null;
  provider_metadata_json: string | null;
  stt_artifact_key: string;
  created_at: string;
};

type SegmentRow = {
  segment_index: number;
  start_ms: number;
  end_ms: number;
  text: string;
};

type CleanupRow = {
  id: string;
  object_key: string;
};

type AssetValidation =
  | { ok: true; asset: AssetRow }
  | { ok: false; error: SttFailure };

const TASK_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const AUDIO_RETENTION_MS = 3 * 24 * 60 * 60 * 1000;

const response = (body: unknown, status = 200): Response =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store' } });

const errorResponse = (
  requestId: string,
  status: number,
  code: string,
  message: string,
  retryable = false,
  taskId?: string,
): Response =>
  response(
    {
      ok: false,
      error: { code, message, retryable },
      requestId,
      ...(taskId ? { taskId } : {}),
    },
    status,
  );

const parseTaskId = (value: string): string | null => {
  try {
    const decoded = decodeURIComponent(value);
    return TASK_ID_PATTERN.test(decoded) ? decoded : null;
  } catch {
    return null;
  }
};

const errorText = (error: unknown, fallback: string): string =>
  error instanceof Error ? error.message : fallback;

const safeProviderMetadata = (value: SttSuccess['providerMetadata']): string | null => {
  if (!value) return null;
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
};

const parseProviderMetadata = (value: string | null): Record<string, unknown> => {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
};

const arrayBufferToBase64 = (buffer: ArrayBuffer): string => {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
};

async function taskOwnedByDevice(
  env: Mob019Env,
  taskId: string,
  deviceId: string,
): Promise<boolean> {
  const row = await env.DB.prepare(
    'SELECT id FROM capture_tasks WHERE id = ? AND device_id = ? LIMIT 1',
  )
    .bind(taskId, deviceId)
    .first<{ id: string }>();
  return Boolean(row);
}

async function readAsset(
  env: Mob019Env,
  taskId: string,
  objectKey?: string,
): Promise<AssetRow | null> {
  const statement = objectKey
    ? env.DB.prepare(
        `SELECT id, task_id, object_key, content_type, expected_size_bytes,
                actual_size_bytes, etag, status, retained, delete_after, deleted_at,
                confirmed_at
         FROM audio_assets
         WHERE task_id = ? AND object_key = ?
         ORDER BY created_at ASC LIMIT 1`,
      ).bind(taskId, objectKey)
    : env.DB.prepare(
        `SELECT id, task_id, object_key, content_type, expected_size_bytes,
                actual_size_bytes, etag, status, retained, delete_after, deleted_at,
                confirmed_at
         FROM audio_assets
         WHERE task_id = ?
         ORDER BY created_at ASC LIMIT 1`,
      ).bind(taskId);
  return statement.first<AssetRow>();
}

async function validateAssetForStt(
  env: Mob019Env,
  taskId: string,
  objectKey: string,
): Promise<AssetValidation> {
  const asset = await readAsset(env, taskId, objectKey);
  if (!asset || asset.status !== 'confirmed') {
    return {
      ok: false,
      error: {
        kind: 'terminal',
        code: 'audio_asset_not_confirmed',
        message: 'STT requires a confirmed audio asset',
      },
    };
  }
  if (asset.deleted_at) {
    return {
      ok: false,
      error: {
        kind: 'terminal',
        code: 'audio_asset_deleted',
        message: 'The retained audio window expired before STT could run',
      },
    };
  }

  let object: Mob019R2Object | null;
  try {
    object = await env.AUDIO.head(asset.object_key);
  } catch (error) {
    return {
      ok: false,
      error: {
        kind: 'retryable',
        code: 'audio_asset_check_failed',
        message: errorText(error, 'Audio asset metadata could not be checked'),
      },
    };
  }
  if (!object) {
    return {
      ok: false,
      error: {
        kind: 'terminal',
        code: 'audio_object_missing',
        message: 'Confirmed audio object is missing from R2',
      },
    };
  }

  const expectedSize = asset.actual_size_bytes ?? asset.expected_size_bytes;
  if (expectedSize !== null && object.size !== expectedSize) {
    return {
      ok: false,
      error: {
        kind: 'terminal',
        code: 'audio_size_mismatch',
        message: 'Audio object size changed after confirmation',
      },
    };
  }
  const contentType = object.httpMetadata?.contentType;
  if (contentType && contentType !== asset.content_type) {
    return {
      ok: false,
      error: {
        kind: 'terminal',
        code: 'audio_content_type_mismatch',
        message: 'Audio object content type changed after confirmation',
      },
    };
  }

  return { ok: true, asset };
}

async function ensureStage(
  env: Mob019Env,
  taskId: string,
  stage: string,
  now = new Date().toISOString(),
): Promise<void> {
  await env.DB.prepare(
    `INSERT OR IGNORE INTO capture_stages
     (task_id, stage, status, retryable, retry_count, updated_at)
     VALUES (?, ?, 'pending', 1, 0, ?)`,
  )
    .bind(taskId, stage, now)
    .run();
}

async function markStageFailed(
  env: Mob019Env,
  taskId: string,
  stage: string,
  failure: SttFailure,
): Promise<void> {
  const now = new Date().toISOString();
  await env.DB.prepare(
    `UPDATE capture_stages
     SET status = 'failed', retryable = ?, error_code = ?, error_message = ?,
         finished_at = ?, updated_at = ?
     WHERE task_id = ? AND stage = ?`,
  )
    .bind(
      failure.kind === 'retryable' ? 1 : 0,
      failure.code,
      failure.message,
      now,
      now,
      taskId,
      stage,
    )
    .run();
}

async function loadAudioBase64(env: Mob019Env, objectKey: string): Promise<string> {
  const object = await env.AUDIO.get(objectKey);
  if (!object) throw new Error('audio_asset_missing');
  return arrayBufferToBase64(await object.arrayBuffer());
}

async function persistSttArtifact(
  env: Mob019Env,
  taskId: string,
  value: SttSuccess,
): Promise<string> {
  const key = `stt/normalized/${taskId}/${crypto.randomUUID()}.json`;
  await env.AUDIO.put(key, JSON.stringify(value), {
    httpMetadata: { contentType: 'application/json' },
  });
  return key;
}

const isSttSuccess = (value: unknown): value is SttSuccess => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.text === 'string' &&
    record.text.trim().length > 0 &&
    typeof record.provider === 'string' &&
    typeof record.model === 'string'
  );
};

async function loadSttArtifact(env: Mob019Env, key: string): Promise<SttSuccess> {
  const object = await env.AUDIO.get(key);
  if (!object) throw new Error('stt_artifact_missing');
  const value = JSON.parse(await object.text()) as unknown;
  if (!isSttSuccess(value)) throw new Error('stt_artifact_invalid');
  return value;
}

async function persistTranscript(
  env: Mob019Env,
  taskId: string,
  assetId: string,
  artifactKey: string,
  value: SttSuccess,
): Promise<string> {
  const existing = await env.DB.prepare(
    'SELECT id FROM transcripts WHERE task_id = ? LIMIT 1',
  )
    .bind(taskId)
    .first<{ id: string }>();
  if (existing) return existing.id;

  const transcriptId = crypto.randomUUID();
  const now = new Date().toISOString();
  const statements: Mob019D1Statement[] = [
    env.DB.prepare(
      `INSERT INTO transcripts
       (id, task_id, source_asset_id, text, language, duration_ms, provider, model,
        provider_request_id, provider_metadata_json, stt_artifact_key, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      transcriptId,
      taskId,
      assetId,
      value.text,
      value.language ?? null,
      value.durationMs ?? null,
      value.provider,
      value.model,
      value.providerRequestId ?? null,
      safeProviderMetadata(value.providerMetadata),
      artifactKey,
      now,
    ),
  ];

  for (const [index, segment] of (value.segments ?? []).entries()) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO transcript_segments
         (transcript_id, segment_index, start_ms, end_ms, text)
         VALUES (?, ?, ?, ?, ?)`,
      ).bind(transcriptId, index, segment.startMs, segment.endMs, segment.text),
    );
  }

  try {
    await env.DB.batch(statements);
    return transcriptId;
  } catch (error) {
    const winner = await env.DB.prepare(
      'SELECT id FROM transcripts WHERE task_id = ? LIMIT 1',
    )
      .bind(taskId)
      .first<{ id: string }>();
    if (winner) return winner.id;
    throw error;
  }
}

async function readTranscript(env: Mob019Env, taskId: string): Promise<Record<string, unknown> | null> {
  const transcript = await env.DB.prepare(
    `SELECT id, task_id, source_asset_id, text, language, duration_ms, provider, model,
            provider_request_id, provider_metadata_json, stt_artifact_key, created_at
     FROM transcripts WHERE task_id = ? LIMIT 1`,
  )
    .bind(taskId)
    .first<TranscriptRow>();
  if (!transcript) return null;

  const segments = await env.DB.prepare(
    `SELECT segment_index, start_ms, end_ms, text
     FROM transcript_segments WHERE transcript_id = ? ORDER BY segment_index ASC`,
  )
    .bind(transcript.id)
    .all<SegmentRow>();

  return {
    id: transcript.id,
    taskId: transcript.task_id,
    sourceAssetId: transcript.source_asset_id,
    text: transcript.text,
    language: transcript.language,
    durationMs: transcript.duration_ms,
    segments: (segments.results ?? []).map((segment) => ({
      startMs: segment.start_ms,
      endMs: segment.end_ms,
      text: segment.text,
    } satisfies TranscriptSegment)),
    provider: transcript.provider,
    model: transcript.model,
    providerRequestId: transcript.provider_request_id,
    providerMetadata: parseProviderMetadata(transcript.provider_metadata_json),
    createdAt: transcript.created_at,
  };
}

export async function ensureDefaultAudioRetention(
  env: Mob019Env,
  assetId: string,
  fallbackConfirmedAt = new Date().toISOString(),
): Promise<void> {
  const asset = await env.DB.prepare(
    `SELECT confirmed_at, delete_after FROM audio_assets WHERE id = ? LIMIT 1`,
  )
    .bind(assetId)
    .first<{ confirmed_at: string | null; delete_after: string | null }>();
  if (!asset || asset.delete_after) return;
  const confirmedAt = asset.confirmed_at ?? fallbackConfirmedAt;
  const deleteAfter = new Date(new Date(confirmedAt).getTime() + AUDIO_RETENTION_MS).toISOString();
  await env.DB.prepare(
    'UPDATE audio_assets SET delete_after = ? WHERE id = ? AND delete_after IS NULL',
  )
    .bind(deleteAfter, assetId)
    .run();
}

async function setAudioRetention(
  request: Request,
  env: Mob019Env,
  taskId: string,
  requestId: string,
): Promise<Response> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    raw = null;
  }
  const retained =
    typeof raw === 'object' && raw !== null && !Array.isArray(raw)
      ? (raw as Record<string, unknown>).retained
      : undefined;
  if (typeof retained !== 'boolean') {
    return errorResponse(requestId, 400, 'invalid_request', 'retained must be a boolean', false, taskId);
  }

  const asset = await readAsset(env, taskId);
  if (!asset || asset.status !== 'confirmed') {
    return errorResponse(requestId, 409, 'audio_not_confirmed', 'Audio must be confirmed first', false, taskId);
  }
  if (asset.deleted_at) {
    return errorResponse(requestId, 409, 'audio_already_deleted', 'Deleted audio cannot be retained', false, taskId);
  }

  await ensureDefaultAudioRetention(env, asset.id, asset.confirmed_at ?? undefined);
  await env.DB.prepare('UPDATE audio_assets SET retained = ? WHERE id = ?')
    .bind(retained ? 1 : 0, asset.id)
    .run();
  const latest = await readAsset(env, taskId);

  return response({
    ok: true,
    data: {
      assetId: asset.id,
      retained,
      deleteAfter: latest?.delete_after ?? null,
      deletedAt: latest?.deleted_at ?? null,
    },
    requestId,
  });
}

async function workflowExists(env: Mob019Env, workflowId: string): Promise<boolean> {
  try {
    await env.CAPTURE_WORKFLOW.get(workflowId);
    return true;
  } catch {
    return false;
  }
}

async function retryStt(
  env: Mob019Env,
  taskId: string,
  requestId: string,
): Promise<Response> {
  const asset = await readAsset(env, taskId);
  if (!asset || asset.status !== 'confirmed' || asset.deleted_at) {
    return errorResponse(
      requestId,
      409,
      'audio_unavailable',
      'Confirmed audio is required to retry STT',
      false,
      taskId,
    );
  }

  const stage = await env.DB.prepare(
    `SELECT status, retryable, retry_count, error_code
     FROM capture_stages WHERE task_id = ? AND stage = 'transcribe' LIMIT 1`,
  )
    .bind(taskId)
    .first<StageRow>();
  if (!stage) {
    return errorResponse(requestId, 409, 'stt_not_started', 'STT has not started yet', false, taskId);
  }
  if (stage.status !== 'failed') {
    return errorResponse(requestId, 409, 'stt_not_failed', 'Only a failed STT stage can be retried', false, taskId);
  }
  if (stage.retryable !== 1) {
    return errorResponse(requestId, 409, 'stt_not_retryable', 'This STT failure is not retryable', false, taskId);
  }

  const retryCount = stage.retry_count + 1;
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE capture_stages
       SET status = 'pending', retryable = 1, retry_count = ?, error_code = NULL,
           error_message = NULL, started_at = NULL, finished_at = NULL, updated_at = ?
       WHERE task_id = ? AND stage = 'transcribe'`,
    ).bind(retryCount, now, taskId),
    env.DB.prepare(
      `UPDATE capture_tasks SET current_stage = 'transcribe', updated_at = ? WHERE id = ?`,
    ).bind(now, taskId),
  ]);

  const workflowId = `capture-${taskId}-stt-${retryCount}`;
  let started = false;
  try {
    await env.CAPTURE_WORKFLOW.create({
      id: workflowId,
      params: {
        taskId,
        objectKey: asset.object_key,
        requestId,
        startStage: 'transcribe',
      },
    });
    started = true;
  } catch {
    started = await workflowExists(env, workflowId);
  }

  if (!started) {
    await markStageFailed(env, taskId, 'transcribe', {
      kind: 'retryable',
      code: 'workflow_start_failed',
      message: 'STT retry workflow could not be started',
    });
    return errorResponse(
      requestId,
      503,
      'workflow_start_failed',
      'STT retry could not start yet',
      true,
      taskId,
    );
  }

  return response({
    ok: true,
    data: { taskId, stage: 'transcribe', retryCount },
    requestId,
  });
}

export async function handleMob019Request(
  request: Request,
  env: Mob019Env,
  device: { id: string },
  requestId: string,
): Promise<Response | null> {
  const url = new URL(request.url);

  const transcriptMatch = /^\/v1\/capture-tasks\/([^/]+)\/transcript$/.exec(url.pathname);
  const retryMatch = /^\/v1\/capture-tasks\/([^/]+)\/stt\/retry$/.exec(url.pathname);
  const retentionMatch = /^\/v1\/capture-tasks\/([^/]+)\/audio\/retention$/.exec(url.pathname);
  const match = transcriptMatch ?? retryMatch ?? retentionMatch;
  if (!match) return null;

  const taskId = parseTaskId(match[1]);
  if (!taskId) {
    return errorResponse(requestId, 400, 'invalid_task_id', 'Invalid CaptureTask id');
  }
  if (!(await taskOwnedByDevice(env, taskId, device.id))) {
    return errorResponse(requestId, 404, 'task_not_found', 'CaptureTask not found');
  }

  if (transcriptMatch && request.method === 'GET') {
    const transcript = await readTranscript(env, taskId);
    if (!transcript) {
      return errorResponse(requestId, 404, 'transcript_not_ready', 'Transcript is not available yet', true, taskId);
    }
    return response({ ok: true, data: { transcript }, requestId });
  }

  if (retryMatch && request.method === 'POST') {
    return retryStt(env, taskId, requestId);
  }

  if (retentionMatch && request.method === 'PUT') {
    return setAudioRetention(request, env, taskId, requestId);
  }

  return errorResponse(requestId, 405, 'method_not_allowed', 'Method not allowed', false, taskId);
}

async function markVerifyRunning(env: Mob019Env, taskId: string): Promise<void> {
  const now = new Date().toISOString();
  await env.DB.prepare(
    `UPDATE capture_stages
     SET status = 'running', retryable = 1, error_code = NULL, error_message = NULL,
         started_at = ?, finished_at = NULL, updated_at = ?
     WHERE task_id = ? AND stage = 'verify-audio'`,
  )
    .bind(now, now, taskId)
    .run();
}

async function markVerifySucceeded(env: Mob019Env, taskId: string): Promise<void> {
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE capture_stages
       SET status = 'succeeded', retryable = 0, error_code = NULL, error_message = NULL,
           finished_at = ?, updated_at = ?
       WHERE task_id = ? AND stage = 'verify-audio'`,
    ).bind(now, now, taskId),
    env.DB.prepare(
      `INSERT OR IGNORE INTO capture_stages
       (task_id, stage, status, retryable, retry_count, updated_at)
       VALUES (?, 'transcribe', 'pending', 1, 0, ?)`,
    ).bind(taskId, now),
    env.DB.prepare(
      `UPDATE capture_tasks SET current_stage = 'transcribe', updated_at = ? WHERE id = ?`,
    ).bind(now, taskId),
  ]);
}

async function runTranscribeStep(
  env: Mob019Env,
  payload: Mob019WorkflowPayload,
): Promise<{ ok: true; artifactKey: string } | { ok: false; errorCode: string }> {
  await ensureStage(env, payload.taskId, 'transcribe');
  const validation = await validateAssetForStt(env, payload.taskId, payload.objectKey);
  if (!validation.ok) {
    await markStageFailed(env, payload.taskId, 'transcribe', validation.error);
    return { ok: false, errorCode: validation.error.code };
  }

  const provider = new WorkersAiSttProvider(env.AI, (key) => loadAudioBase64(env, key));
  const execution = await executeSttStage(
    provider,
    {
      taskId: payload.taskId,
      audioObjectKey: validation.asset.object_key,
      contentType: validation.asset.content_type,
      ...(payload.initialPrompt ? { initialPrompt: payload.initialPrompt } : {}),
    },
    {
      markRunning: async () => {
        const now = new Date().toISOString();
        await env.DB.prepare(
          `UPDATE capture_stages
           SET status = 'running', retryable = 1, error_code = NULL, error_message = NULL,
               started_at = ?, finished_at = NULL, updated_at = ?
           WHERE task_id = ? AND stage = 'transcribe'`,
        )
          .bind(now, now, payload.taskId)
          .run();
      },
      persistArtifact: (value) => persistSttArtifact(env, payload.taskId, value),
      markSucceeded: async () => {
        const now = new Date().toISOString();
        await env.DB.batch([
          env.DB.prepare(
            `UPDATE capture_stages
             SET status = 'succeeded', retryable = 0, error_code = NULL,
                 error_message = NULL, finished_at = ?, updated_at = ?
             WHERE task_id = ? AND stage = 'transcribe'`,
          ).bind(now, now, payload.taskId),
          env.DB.prepare(
            `INSERT OR IGNORE INTO capture_stages
             (task_id, stage, status, retryable, retry_count, updated_at)
             VALUES (?, 'persist-transcript', 'pending', 1, 0, ?)`,
          ).bind(payload.taskId, now),
          env.DB.prepare(
            `UPDATE capture_tasks SET current_stage = 'persist-transcript', updated_at = ?
             WHERE id = ?`,
          ).bind(now, payload.taskId),
        ]);
      },
      markFailed: (failure) => markStageFailed(env, payload.taskId, 'transcribe', failure),
    },
  );

  return execution.ok
    ? { ok: true, artifactKey: execution.artifactKey }
    : { ok: false, errorCode: execution.error.code };
}

async function runPersistTranscriptStep(
  env: Mob019Env,
  payload: Mob019WorkflowPayload,
  artifactKey: string,
): Promise<{ ok: true; transcriptId: string } | { ok: false; errorCode: string }> {
  await ensureStage(env, payload.taskId, 'persist-transcript');
  const startedAt = new Date().toISOString();
  await env.DB.prepare(
    `UPDATE capture_stages
     SET status = 'running', retryable = 1, error_code = NULL, error_message = NULL,
         started_at = ?, finished_at = NULL, updated_at = ?
     WHERE task_id = ? AND stage = 'persist-transcript'`,
  )
    .bind(startedAt, startedAt, payload.taskId)
    .run();

  try {
    const asset = await readAsset(env, payload.taskId, payload.objectKey);
    if (!asset) throw new Error('audio_asset_missing');
    const value = await loadSttArtifact(env, artifactKey);
    const transcriptId = await persistTranscript(
      env,
      payload.taskId,
      asset.id,
      artifactKey,
      value,
    );
    const finishedAt = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE capture_stages
         SET status = 'succeeded', retryable = 0, error_code = NULL,
             error_message = NULL, finished_at = ?, updated_at = ?
         WHERE task_id = ? AND stage = 'persist-transcript'`,
      ).bind(finishedAt, finishedAt, payload.taskId),
      env.DB.prepare(
        `INSERT OR IGNORE INTO capture_stages
         (task_id, stage, status, retryable, retry_count, updated_at)
         VALUES (?, 'organize', 'pending', 1, 0, ?)`,
      ).bind(payload.taskId, finishedAt),
      env.DB.prepare(
        `UPDATE capture_tasks SET current_stage = 'organize', updated_at = ? WHERE id = ?`,
      ).bind(finishedAt, payload.taskId),
    ]);
    return { ok: true, transcriptId };
  } catch (error) {
    const failure: SttFailure = {
      kind: 'retryable',
      code: 'transcript_persist_failed',
      message: errorText(error, 'Transcript could not be persisted'),
    };
    await markStageFailed(env, payload.taskId, 'persist-transcript', failure);
    return { ok: false, errorCode: failure.code };
  }
}

export async function runMob019Workflow(
  env: Mob019Env,
  payload: Mob019WorkflowPayload,
  step: Mob019WorkflowStep,
): Promise<void> {
  if (payload.startStage !== 'transcribe') {
    const verified = await step.do('verify-audio', async () => {
      await markVerifyRunning(env, payload.taskId);
      const validation = await validateAssetForStt(env, payload.taskId, payload.objectKey);
      if (!validation.ok) {
        await markStageFailed(env, payload.taskId, 'verify-audio', validation.error);
        if (validation.error.kind === 'retryable') {
          throw new Error(validation.error.code);
        }
        return { ok: false, errorCode: validation.error.code } as const;
      }
      await markVerifySucceeded(env, payload.taskId);
      return { ok: true } as const;
    });
    if (!verified.ok) return;
  }

  const transcribed = await step.do('transcribe', () => runTranscribeStep(env, payload));
  if (!transcribed.ok) return;

  await step.do('persist-transcript', () =>
    runPersistTranscriptStep(env, payload, transcribed.artifactKey),
  );
}

export async function cleanupExpiredAudio(
  env: Mob019Env,
  now = new Date(),
): Promise<{ deleted: number; failed: number }> {
  const rows = await env.DB.prepare(
    `SELECT id, object_key FROM audio_assets
     WHERE status = 'confirmed' AND retained = 0 AND deleted_at IS NULL
       AND delete_after IS NOT NULL AND delete_after <= ?
     ORDER BY delete_after ASC LIMIT 100`,
  )
    .bind(now.toISOString())
    .all<CleanupRow>();

  let deleted = 0;
  let failed = 0;
  for (const asset of rows.results ?? []) {
    try {
      await env.AUDIO.delete(asset.object_key);
      await env.DB.prepare('UPDATE audio_assets SET deleted_at = ? WHERE id = ?')
        .bind(new Date().toISOString(), asset.id)
        .run();
      deleted += 1;
    } catch {
      failed += 1;
    }
  }
  return { deleted, failed };
}
