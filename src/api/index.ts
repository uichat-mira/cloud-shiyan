import { WorkflowEntrypoint } from 'cloudflare:workers';
import {
  cleanupExpiredAudio,
  ensureDefaultAudioRetention,
  handleMob019Request,
  runMob019Workflow,
  type Mob019WorkflowPayload,
  type Mob019WorkflowStep,
} from './mob019';
import { handleMob020Request, runMob020Organize } from './mob020';
import { handleMob022Request } from './mob022';
import { createShiyanLlmService } from '../llm/index';
import { createPresignedR2PutUrl } from '../shared/r2Presign';
import type { ShiyanLlmBinding } from '../shared/llm';
import type { LlmEnvLike } from '../shared/llmGateway';
import type {
  ApiEnvelope,
  CaptureStageView,
  CaptureTaskView,
  CreateCaptureTaskInput,
  UploadGrant,
} from '../shared/contracts';

type D1Value = string | number | null;

interface D1Result<T = unknown> {
  results?: T[];
  success: boolean;
}

interface D1Statement {
  bind(...values: D1Value[]): D1Statement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  run<T = unknown>(): Promise<D1Result<T>>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
}

interface D1DatabaseLike {
  prepare(sql: string): D1Statement;
  batch(statements: D1Statement[]): Promise<D1Result[]>;
}

interface R2ObjectLike {
  size: number;
  etag: string;
  httpMetadata?: { contentType?: string };
}

interface R2ObjectBodyLike extends R2ObjectLike {
  arrayBuffer(): Promise<ArrayBuffer>;
  text(): Promise<string>;
}

interface R2BucketLike {
  head(key: string): Promise<R2ObjectLike | null>;
  get(key: string): Promise<R2ObjectBodyLike | null>;
  put(
    key: string,
    value: string | ArrayBuffer | ArrayBufferView,
    options?: { httpMetadata?: { contentType?: string } },
  ): Promise<unknown>;
  delete(key: string): Promise<void>;
}

interface WorkflowBindingLike {
  create(input?: { id?: string; params?: Record<string, unknown> }): Promise<unknown>;
  get(id: string): Promise<unknown>;
}

interface Env extends LlmEnvLike {
  DB: D1DatabaseLike;
  AUDIO: R2BucketLike;
  AI: {
    run(model: string, input: Record<string, unknown>): Promise<unknown>;
  };
  CAPTURE_WORKFLOW: WorkflowBindingLike;
  R2_ACCOUNT_ID: string;
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
  R2_BUCKET_NAME: string;
  UPLOAD_TTL_SECONDS: string;
  DEVICE_AUTH_PEPPER: string;
  GITHUB_DESTINATION_TOKEN: string;
  GITHUB_DESTINATION_OWNER?: string;
  GITHUB_DESTINATION_REPOSITORY?: string;
  GITHUB_DESTINATION_BRANCH?: string;
  GITHUB_DESTINATION_ROOT?: string;
}

interface DeviceRow {
  id: string;
  user_id: string | null;
}

interface TaskRow {
  id: string;
  device_id: string;
  user_id: string | null;
  title: string;
  scene_id: string;
  lifecycle_status: CaptureTaskView['lifecycle'];
  current_stage: string;
  created_at: string;
  updated_at: string;
}

interface StageRow {
  stage: string;
  status: CaptureStageView['status'];
  retryable: number;
  retry_count: number;
  error_code: string | null;
  error_message: string | null;
  started_at: string | null;
  finished_at: string | null;
  updated_at: string;
}

interface AssetRow {
  id: string;
  task_id: string;
  object_key: string;
  content_type: string;
  expected_size_bytes: number | null;
  actual_size_bytes: number | null;
  etag: string | null;
  status: 'awaiting_upload' | 'uploaded' | 'confirmed' | 'rejected';
  upload_expires_at: string;
  confirm_idempotency_key: string | null;
}

type RuntimeEnv = Env & { LLM: ShiyanLlmBinding };

const withLlm = (env: Env): RuntimeEnv => ({
  ...env,
  LLM: createShiyanLlmService(env),
});

const TASK_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

const json = <T>(body: ApiEnvelope<T>, status = 200): Response =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store' } });

const requestIdFor = (request: Request): string => {
  const supplied = request.headers.get('x-request-id')?.trim();
  return supplied && supplied.length <= 128 ? supplied : crypto.randomUUID();
};

const errorResponse = (
  requestId: string,
  status: number,
  code: string,
  message: string,
  retryable = false,
  taskId?: string,
): Response =>
  json(
    {
      ok: false,
      error: { code, message, retryable },
      requestId,
      ...(taskId ? { taskId } : {}),
    },
    status,
  );

const sha256Hex = async (value: string): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
};

async function authenticateDevice(
  request: Request,
  env: Env,
): Promise<DeviceRow | null> {
  const authorization = request.headers.get('authorization') ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(authorization);
  const credential = match?.[1]?.trim();
  if (!credential) return null;

  const hash = await sha256Hex(`${env.DEVICE_AUTH_PEPPER}:${credential}`);
  const device = await env.DB.prepare(
    `SELECT id, user_id FROM devices
     WHERE credential_hash = ? AND revoked_at IS NULL
     LIMIT 1`,
  )
    .bind(hash)
    .first<DeviceRow>();

  if (device) {
    void env.DB.prepare('UPDATE devices SET last_seen_at = ? WHERE id = ?')
      .bind(new Date().toISOString(), device.id)
      .run()
      .catch(() => undefined);
  }
  return device;
}

const safeJson = async (request: Request): Promise<Record<string, unknown> | null> => {
  try {
    const value = await request.json();
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
};

const parseTaskIdPathParam = (value: string): string | null => {
  try {
    const decoded = decodeURIComponent(value);
    return TASK_ID_PATTERN.test(decoded) ? decoded : null;
  } catch {
    return null;
  }
};

const parseCreateInput = (value: Record<string, unknown>): CreateCaptureTaskInput | null => {
  const audio =
    typeof value.audio === 'object' && value.audio !== null && !Array.isArray(value.audio)
      ? (value.audio as Record<string, unknown>)
      : null;
  const idempotencyKey = typeof value.idempotencyKey === 'string' ? value.idempotencyKey.trim() : '';
  const title = typeof value.title === 'string' ? value.title.trim() : '';
  const sceneId = typeof value.sceneId === 'string' ? value.sceneId.trim() : '';
  const contentType = typeof audio?.contentType === 'string' ? audio.contentType.trim() : '';
  const sizeBytes = audio?.sizeBytes;

  if (!idempotencyKey || idempotencyKey.length > 128 || !title || !sceneId || !contentType) {
    return null;
  }
  if (
    sizeBytes !== undefined &&
    (!Number.isSafeInteger(sizeBytes) || typeof sizeBytes !== 'number' || sizeBytes <= 0)
  ) {
    return null;
  }

  return {
    idempotencyKey,
    title,
    sceneId,
    audio: {
      contentType,
      ...(typeof sizeBytes === 'number' ? { sizeBytes } : {}),
    },
  };
};

async function readTask(env: Env, taskId: string): Promise<CaptureTaskView | null> {
  const task = await env.DB.prepare(
    `SELECT id, device_id, user_id, title, scene_id, lifecycle_status, current_stage,
            created_at, updated_at
     FROM capture_tasks WHERE id = ? LIMIT 1`,
  )
    .bind(taskId)
    .first<TaskRow>();
  if (!task) return null;

  const stageRows = await env.DB.prepare(
    `SELECT stage, status, retryable, retry_count, error_code, error_message,
            started_at, finished_at, updated_at
     FROM capture_stages WHERE task_id = ? ORDER BY rowid ASC`,
  )
    .bind(taskId)
    .all<StageRow>();

  return {
    id: task.id,
    deviceId: task.device_id,
    userId: task.user_id,
    title: task.title,
    sceneId: task.scene_id,
    lifecycle: task.lifecycle_status,
    currentStage: task.current_stage,
    createdAt: task.created_at,
    updatedAt: task.updated_at,
    stages: (stageRows.results ?? []).map((stage) => ({
      stage: stage.stage,
      status: stage.status,
      retryable: stage.retryable === 1,
      retryCount: stage.retry_count,
      errorCode: stage.error_code,
      errorMessage: stage.error_message,
      startedAt: stage.started_at,
      finishedAt: stage.finished_at,
      updatedAt: stage.updated_at,
    })),
  };
}

async function readFirstAsset(env: Env, taskId: string): Promise<AssetRow | null> {
  return env.DB.prepare(
    `SELECT id, task_id, object_key, content_type, expected_size_bytes,
            actual_size_bytes, etag, status, upload_expires_at, confirm_idempotency_key
     FROM audio_assets WHERE task_id = ? ORDER BY created_at ASC LIMIT 1`,
  )
    .bind(taskId)
    .first<AssetRow>();
}

async function uploadGrant(env: Env, asset: AssetRow, now = new Date()): Promise<UploadGrant> {
  const ttl = Number.parseInt(env.UPLOAD_TTL_SECONDS, 10);
  const expiresInSeconds = Number.isFinite(ttl) ? Math.min(Math.max(ttl, 60), 3600) : 900;
  const expiresAt = new Date(now.getTime() + expiresInSeconds * 1000).toISOString();
  const url = await createPresignedR2PutUrl({
    accountId: env.R2_ACCOUNT_ID,
    bucket: env.R2_BUCKET_NAME,
    objectKey: asset.object_key,
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    contentType: asset.content_type,
    expiresInSeconds,
    now,
  });

  return {
    assetId: asset.id,
    objectKey: asset.object_key,
    method: 'PUT',
    url,
    expiresAt,
    headers: { 'content-type': asset.content_type },
  };
}

async function canonicalCaptureTaskResponse(
  env: Env,
  taskId: string,
  requestId: string,
  status = 200,
): Promise<Response> {
  const task = await readTask(env, taskId);
  const asset = await readFirstAsset(env, taskId);
  if (!task || !asset) {
    return errorResponse(
      requestId,
      500,
      'canonical_state_missing',
      'CaptureTask state is incomplete',
      false,
      taskId,
    );
  }
  const grant = asset.status === 'awaiting_upload' ? await uploadGrant(env, asset) : null;
  return json({ ok: true, data: { task, upload: grant }, requestId }, status);
}

async function captureWorkflowExists(env: Env, workflowId: string): Promise<boolean> {
  try {
    await env.CAPTURE_WORKFLOW.get(workflowId);
    return true;
  } catch {
    return false;
  }
}

async function ensureCaptureWorkflowStarted(
  env: Env,
  taskId: string,
  objectKey: string,
  requestId: string,
): Promise<boolean> {
  const workflowId = `capture-${taskId}`;
  try {
    await env.CAPTURE_WORKFLOW.create({
      id: workflowId,
      params: { taskId, objectKey, requestId, startStage: 'verify-audio' },
    });
    return true;
  } catch {
    return captureWorkflowExists(env, workflowId);
  }
}

async function markWorkflowStartFailed(env: Env, taskId: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE capture_stages
     SET status = 'failed', retryable = 1, retry_count = retry_count + 1,
         error_code = 'workflow_start_failed',
         error_message = 'Workflow could not be started', updated_at = ?
     WHERE task_id = ? AND stage = 'verify-audio'`,
  )
    .bind(new Date().toISOString(), taskId)
    .run();
}

async function createCaptureTask(
  request: Request,
  env: Env,
  device: DeviceRow,
  requestId: string,
): Promise<Response> {
  const raw = await safeJson(request);
  const input = raw ? parseCreateInput(raw) : null;
  if (!input) {
    return errorResponse(requestId, 400, 'invalid_request', 'Invalid CaptureTask request');
  }

  const existing = await env.DB.prepare(
    `SELECT id FROM capture_tasks
     WHERE device_id = ? AND create_idempotency_key = ? LIMIT 1`,
  )
    .bind(device.id, input.idempotencyKey)
    .first<{ id: string }>();

  if (existing) {
    return canonicalCaptureTaskResponse(env, existing.id, requestId);
  }

  const now = new Date().toISOString();
  const taskId = crypto.randomUUID();
  const assetId = crypto.randomUUID();
  const objectKey = `audio/ephemeral/${taskId}/${assetId}`;
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();

  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO capture_tasks
         (id, device_id, user_id, title, scene_id, lifecycle_status, current_stage,
          create_idempotency_key, correlation_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'active', 'upload', ?, ?, ?, ?)`,
      ).bind(taskId, device.id, device.user_id, input.title, input.sceneId, input.idempotencyKey, requestId, now, now),
      env.DB.prepare(
        `INSERT INTO capture_stages
         (task_id, stage, status, retryable, retry_count, started_at, updated_at)
         VALUES (?, 'upload', 'running', 1, 0, ?, ?)`,
      ).bind(taskId, now, now),
      env.DB.prepare(
        `INSERT INTO audio_assets
         (id, task_id, object_key, content_type, expected_size_bytes, status,
          upload_expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, 'awaiting_upload', ?, ?)`,
      ).bind(assetId, taskId, objectKey, input.audio.contentType, input.audio.sizeBytes ?? null, expiresAt, now),
    ]);
  } catch {
    const winner = await env.DB.prepare(
      `SELECT id FROM capture_tasks
       WHERE device_id = ? AND create_idempotency_key = ? LIMIT 1`,
    )
      .bind(device.id, input.idempotencyKey)
      .first<{ id: string }>();
    if (winner) {
      return canonicalCaptureTaskResponse(env, winner.id, requestId);
    }
    return errorResponse(
      requestId,
      500,
      'capture_task_create_failed',
      'CaptureTask could not be created',
      true,
    );
  }

  return canonicalCaptureTaskResponse(env, taskId, requestId, 201);
}

async function getCaptureTask(
  env: Env,
  device: DeviceRow,
  taskId: string,
  requestId: string,
): Promise<Response> {
  const task = await readTask(env, taskId);
  if (!task || task.deviceId !== device.id) {
    return errorResponse(requestId, 404, 'task_not_found', 'CaptureTask not found');
  }
  return json({ ok: true, data: { task }, requestId });
}

async function confirmAudio(
  request: Request,
  env: Env,
  device: DeviceRow,
  taskId: string,
  requestId: string,
): Promise<Response> {
  const task = await readTask(env, taskId);
  if (!task || task.deviceId !== device.id) {
    return errorResponse(requestId, 404, 'task_not_found', 'CaptureTask not found');
  }

  const raw = await safeJson(request);
  const assetId = typeof raw?.assetId === 'string' ? raw.assetId.trim() : '';
  const idempotencyKey = typeof raw?.idempotencyKey === 'string' ? raw.idempotencyKey.trim() : '';
  if (!assetId || !idempotencyKey || idempotencyKey.length > 128) {
    return errorResponse(requestId, 400, 'invalid_request', 'assetId and idempotencyKey are required', false, taskId);
  }

  const asset = await env.DB.prepare(
    `SELECT id, task_id, object_key, content_type, expected_size_bytes,
            actual_size_bytes, etag, status, upload_expires_at, confirm_idempotency_key
     FROM audio_assets WHERE id = ? AND task_id = ? LIMIT 1`,
  )
    .bind(assetId, taskId)
    .first<AssetRow>();
  if (!asset) {
    return errorResponse(requestId, 404, 'asset_not_found', 'Audio asset not found', false, taskId);
  }

  if (asset.status === 'confirmed') {
    if (asset.confirm_idempotency_key !== idempotencyKey) {
      return errorResponse(requestId, 409, 'asset_already_confirmed', 'Audio asset was confirmed by another request identity', false, taskId);
    }

    await ensureDefaultAudioRetention(env, asset.id);

    const latestTask = await readTask(env, taskId);
    const verifyStage = latestTask?.stages.find((stage) => stage.stage === 'verify-audio');
    if (!latestTask || !verifyStage) {
      return errorResponse(
        requestId,
        500,
        'canonical_state_missing',
        'Confirmed audio is missing verify-audio stage state',
        false,
        taskId,
      );
    }

    const needsWorkflowRecovery =
      verifyStage.status === 'pending' ||
      (verifyStage.status === 'failed' && verifyStage.errorCode === 'workflow_start_failed');
    if (needsWorkflowRecovery) {
      const retryAt = new Date().toISOString();
      await env.DB.prepare(
        `UPDATE capture_stages
         SET status = 'pending', retryable = 1, error_code = NULL, error_message = NULL,
             finished_at = NULL, updated_at = ?
         WHERE task_id = ? AND stage = 'verify-audio'`,
      )
        .bind(retryAt, taskId)
        .run();

      const started = await ensureCaptureWorkflowStarted(
        env,
        taskId,
        asset.object_key,
        requestId,
      );
      if (!started) {
        await markWorkflowStartFailed(env, taskId);
        return errorResponse(
          requestId,
          503,
          'workflow_start_failed',
          'Audio is confirmed but processing could not start yet',
          true,
          taskId,
        );
      }
    }

    return json({ ok: true, data: { task: await readTask(env, taskId) }, requestId });
  }

  const object = await env.AUDIO.head(asset.object_key);
  if (!object) {
    return errorResponse(requestId, 409, 'audio_object_missing', 'Uploaded audio object does not exist yet', true, taskId);
  }
  if (asset.expected_size_bytes !== null && object.size !== asset.expected_size_bytes) {
    return errorResponse(requestId, 409, 'audio_size_mismatch', 'Uploaded audio size does not match the declared asset', true, taskId);
  }
  const objectContentType = object.httpMetadata?.contentType;
  if (objectContentType && objectContentType !== asset.content_type) {
    return errorResponse(requestId, 409, 'audio_content_type_mismatch', 'Uploaded audio content type does not match the signed grant', false, taskId);
  }

  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE audio_assets
       SET status = 'confirmed', actual_size_bytes = ?, etag = ?,
           confirm_idempotency_key = ?, confirmed_at = ?
       WHERE id = ?`,
    ).bind(object.size, object.etag, idempotencyKey, now, asset.id),
    env.DB.prepare(
      `UPDATE capture_stages
       SET status = 'succeeded', retryable = 0, error_code = NULL, error_message = NULL,
           finished_at = ?, updated_at = ?
       WHERE task_id = ? AND stage = 'upload'`,
    ).bind(now, now, taskId),
    env.DB.prepare(
      `INSERT OR IGNORE INTO capture_stages
       (task_id, stage, status, retryable, retry_count, updated_at)
       VALUES (?, 'verify-audio', 'pending', 1, 0, ?)`,
    ).bind(taskId, now),
    env.DB.prepare(
      `UPDATE capture_tasks SET current_stage = 'verify-audio', updated_at = ? WHERE id = ?`,
    ).bind(now, taskId),
  ]);

  await ensureDefaultAudioRetention(env, asset.id, now);

  const started = await ensureCaptureWorkflowStarted(
    env,
    taskId,
    asset.object_key,
    requestId,
  );
  if (!started) {
    await markWorkflowStartFailed(env, taskId);
    return errorResponse(requestId, 503, 'workflow_start_failed', 'Audio is confirmed but processing could not start yet', true, taskId);
  }

  return json({ ok: true, data: { task: await readTask(env, taskId) }, requestId });
}

export class ShiyanCaptureWorkflow extends WorkflowEntrypoint<Env, Mob019WorkflowPayload> {
  async run(
    event: { payload: Mob019WorkflowPayload },
    step: Mob019WorkflowStep,
  ): Promise<void> {
    // Organize retries skip the STT chain entirely: the Transcript evidence
    // layer is already persisted and must never be re-run or overwritten.
    if (event.payload.startStage === 'organize') {
      await runMob020Organize(withLlm(this.env), event.payload, step);
      return;
    }

    const stt = await runMob019Workflow(this.env, event.payload, step);
    if (!stt.ok) return;
    await runMob020Organize(withLlm(this.env), event.payload, step);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const requestId = requestIdFor(request);
    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/health') {
      return json({ ok: true, data: { service: 'mira-shiyan' }, requestId });
    }

    const device = await authenticateDevice(request, env);
    if (!device) {
      return errorResponse(requestId, 401, 'device_unauthorized', 'Valid Shiyan device credential required');
    }

    if (request.method === 'POST' && url.pathname === '/v1/capture-tasks') {
      return createCaptureTask(request, env, device, requestId);
    }

    const taskMatch = /^\/v1\/capture-tasks\/([^/]+)$/.exec(url.pathname);
    if (request.method === 'GET' && taskMatch) {
      const taskId = parseTaskIdPathParam(taskMatch[1]);
      if (!taskId) {
        return errorResponse(requestId, 400, 'invalid_task_id', 'Invalid CaptureTask id');
      }
      return getCaptureTask(env, device, taskId, requestId);
    }

    const confirmMatch = /^\/v1\/capture-tasks\/([^/]+)\/audio\/confirm$/.exec(url.pathname);
    if (request.method === 'POST' && confirmMatch) {
      const taskId = parseTaskIdPathParam(confirmMatch[1]);
      if (!taskId) {
        return errorResponse(requestId, 400, 'invalid_task_id', 'Invalid CaptureTask id');
      }
      return confirmAudio(request, env, device, taskId, requestId);
    }

    const mob019Response = await handleMob019Request(request, env, device, requestId);
    if (mob019Response) return mob019Response;

    const mob020Response = await handleMob020Request(request, withLlm(env), device, requestId);
    if (mob020Response) return mob020Response;

    const mob022Response = await handleMob022Request(request, env, device, requestId);
    if (mob022Response) return mob022Response;

    return errorResponse(requestId, 404, 'route_not_found', 'Route not found');
  },

  async scheduled(
    _controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    ctx.waitUntil(cleanupExpiredAudio(env));
  },
};
