import type { Mob019D1 } from './mob019';
import type {
  ConfirmedFinalDraftSnapshot,
  DeliveryRecordView,
  DestinationAdapter,
  DestinationFailure,
  DestinationSuccess,
} from '../shared/destination';
import { GithubDestinationAdapter } from '../shared/githubDestination';

export interface Mob022Env {
  DB: Mob019D1;
}

export interface Mob022GithubEnv extends Mob022Env {
  GITHUB_DESTINATION_TOKEN: string;
  GITHUB_DESTINATION_OWNER?: string;
  GITHUB_DESTINATION_REPOSITORY?: string;
  GITHUB_DESTINATION_BRANCH?: string;
  GITHUB_DESTINATION_ROOT?: string;
}

type ConfirmedFinalDraftRow = {
  id: string;
  task_id: string;
  title: string | null;
  markdown: string;
  confirmed_at: string;
};

type DeliveryRow = {
  id: string;
  task_id: string;
  final_draft_id: string;
  destination: 'github';
  idempotency_key: string;
  status: 'pending' | 'succeeded' | 'failed';
  retryable: number;
  retry_count: number;
  content_sha256: string;
  repository: string | null;
  path: string | null;
  commit_sha: string | null;
  file_url: string | null;
  error_code: string | null;
  error_message: string | null;
  delivered_at: string | null;
  created_at: string;
  updated_at: string;
};

export type DeliveryExecutionResult =
  | { ok: true; record: DeliveryRecordView; delivery: DestinationSuccess }
  | { ok: false; record: DeliveryRecordView | null; error: DestinationFailure };

const TASK_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

const parseTaskId = (value: string): string | null => {
  try {
    const decoded = decodeURIComponent(value);
    return TASK_ID_PATTERN.test(decoded) ? decoded : null;
  } catch {
    return null;
  }
};

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

const sha256Hex = async (value: string): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
};

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

async function readConfirmedFinalDraft(
  env: Mob022Env,
  taskId: string,
): Promise<ConfirmedFinalDraftSnapshot | null> {
  const row = await env.DB.prepare(
    `SELECT id, task_id, title, markdown, confirmed_at
     FROM drafts
     WHERE task_id = ? AND kind = 'final' AND confirmed_at IS NOT NULL
     ORDER BY version DESC LIMIT 1`,
  )
    .bind(taskId)
    .first<ConfirmedFinalDraftRow>();
  if (!row || !row.title?.trim() || !row.markdown.trim()) return null;
  return {
    id: row.id,
    taskId: row.task_id,
    title: row.title,
    markdown: row.markdown,
    confirmedAt: row.confirmed_at,
  };
}

const toView = (row: DeliveryRow): DeliveryRecordView => ({
  id: row.id,
  taskId: row.task_id,
  finalDraftId: row.final_draft_id,
  destination: row.destination,
  idempotencyKey: row.idempotency_key,
  status: row.status,
  retryable: row.retryable === 1,
  retryCount: row.retry_count,
  repository: row.repository,
  path: row.path,
  commitSha: row.commit_sha,
  fileUrl: row.file_url,
  errorCode: row.error_code,
  errorMessage: row.error_message,
  deliveredAt: row.delivered_at,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

async function taskOwnedByDevice(env: Mob022Env, taskId: string, deviceId: string): Promise<boolean> {
  const row = await env.DB.prepare(
    'SELECT id FROM capture_tasks WHERE id = ? AND device_id = ? LIMIT 1',
  )
    .bind(taskId, deviceId)
    .first<{ id: string }>();
  return Boolean(row);
}

async function taskExists(env: Mob022Env, taskId: string): Promise<boolean> {
  const row = await env.DB.prepare('SELECT id FROM capture_tasks WHERE id = ? LIMIT 1')
    .bind(taskId)
    .first<{ id: string }>();
  return Boolean(row);
}

async function readDeliveryByKey(
  env: Mob022Env,
  taskId: string,
  idempotencyKey: string,
): Promise<DeliveryRow | null> {
  return env.DB.prepare(
    `SELECT id, task_id, final_draft_id, destination, idempotency_key, status,
            retryable, retry_count, content_sha256, repository, path, commit_sha,
            file_url, error_code, error_message, delivered_at, created_at, updated_at
     FROM delivery_records
     WHERE task_id = ? AND destination = 'github' AND idempotency_key = ? LIMIT 1`,
  )
    .bind(taskId, idempotencyKey)
    .first<DeliveryRow>();
}

async function readDeliveryById(env: Mob022Env, id: string): Promise<DeliveryRow | null> {
  return env.DB.prepare(
    `SELECT id, task_id, final_draft_id, destination, idempotency_key, status,
            retryable, retry_count, content_sha256, repository, path, commit_sha,
            file_url, error_code, error_message, delivered_at, created_at, updated_at
     FROM delivery_records WHERE id = ? LIMIT 1`,
  )
    .bind(id)
    .first<DeliveryRow>();
}

async function listDeliveries(env: Mob022Env, taskId: string): Promise<DeliveryRecordView[]> {
  const rows = await env.DB.prepare(
    `SELECT id, task_id, final_draft_id, destination, idempotency_key, status,
            retryable, retry_count, content_sha256, repository, path, commit_sha,
            file_url, error_code, error_message, delivered_at, created_at, updated_at
     FROM delivery_records WHERE task_id = ? ORDER BY created_at DESC`,
  )
    .bind(taskId)
    .all<DeliveryRow>();
  return (rows.results ?? []).map(toView);
}

async function markDeliveryStageRunning(env: Mob022Env, taskId: string, retryCount: number): Promise<void> {
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO capture_stages
       (task_id, stage, status, retryable, retry_count, updated_at)
       VALUES (?, 'delivery', 'pending', 1, 0, ?)`,
    ).bind(taskId, now),
    env.DB.prepare(
      `UPDATE capture_stages
       SET status = 'running', retryable = 1, retry_count = ?, error_code = NULL,
           error_message = NULL, started_at = COALESCE(started_at, ?),
           finished_at = NULL, updated_at = ?
       WHERE task_id = ? AND stage = 'delivery'`,
    ).bind(retryCount, now, now, taskId),
    env.DB.prepare('UPDATE capture_tasks SET current_stage = ?, updated_at = ? WHERE id = ?')
      .bind('delivery', now, taskId),
  ]);
}

async function markDeliveryStageSucceeded(env: Mob022Env, taskId: string): Promise<void> {
  const now = new Date().toISOString();
  await env.DB.prepare(
    `UPDATE capture_stages
     SET status = 'succeeded', retryable = 0, error_code = NULL, error_message = NULL,
         finished_at = ?, updated_at = ?
     WHERE task_id = ? AND stage = 'delivery'`,
  )
    .bind(now, now, taskId)
    .run();
}

async function markDeliveryStageFailed(
  env: Mob022Env,
  taskId: string,
  failure: DestinationFailure,
): Promise<void> {
  const now = new Date().toISOString();
  await env.DB.prepare(
    `UPDATE capture_stages
     SET status = 'failed', retryable = ?, error_code = ?, error_message = ?,
         finished_at = ?, updated_at = ?
     WHERE task_id = ? AND stage = 'delivery'`,
  )
    .bind(
      failure.kind === 'retryable' ? 1 : 0,
      failure.code,
      failure.message,
      now,
      now,
      taskId,
    )
    .run();
}

const savedSuccess = (row: DeliveryRow): DestinationSuccess | null => {
  if (!row.repository || !row.path || !row.commit_sha || !row.file_url || !row.delivered_at) return null;
  return {
    destination: 'github',
    repository: row.repository,
    path: row.path,
    commitSha: row.commit_sha,
    fileUrl: row.file_url,
    deliveredAt: row.delivered_at,
  };
};

export async function executeDestinationDelivery(
  env: Mob022Env,
  adapter: DestinationAdapter,
  draft: ConfirmedFinalDraftSnapshot,
  idempotencyKey: string,
): Promise<DeliveryExecutionResult> {
  const key = idempotencyKey.trim();
  if (!key || key.length > 128 || !draft.id || !draft.taskId || !draft.title.trim() || !draft.markdown.trim()) {
    return {
      ok: false,
      record: null,
      error: {
        kind: 'terminal',
        code: 'delivery_invalid_input',
        message: 'Confirmed Final Draft and idempotency key are required',
      },
    };
  }
  if (!(await taskExists(env, draft.taskId))) {
    return {
      ok: false,
      record: null,
      error: { kind: 'terminal', code: 'task_not_found', message: 'CaptureTask not found' },
    };
  }

  const contentSha = await sha256Hex(
    JSON.stringify({
      finalDraftId: draft.id,
      title: draft.title,
      markdown: draft.markdown,
      confirmedAt: draft.confirmedAt,
    }),
  );
  let row = await readDeliveryByKey(env, draft.taskId, key);

  if (row) {
    if (row.final_draft_id !== draft.id || row.content_sha256 !== contentSha) {
      return {
        ok: false,
        record: toView(row),
        error: {
          kind: 'terminal',
          code: 'delivery_idempotency_conflict',
          message: 'This delivery idempotency key is already bound to different confirmed content',
        },
      };
    }
    if (row.status === 'succeeded') {
      const delivery = savedSuccess(row);
      if (!delivery) {
        return {
          ok: false,
          record: toView(row),
          error: {
            kind: 'retryable',
            code: 'delivery_evidence_incomplete',
            message: 'Succeeded delivery record is missing canonical GitHub evidence',
          },
        };
      }
      return { ok: true, record: toView(row), delivery };
    }
    if (row.status === 'failed' && row.retryable !== 1) {
      return {
        ok: false,
        record: toView(row),
        error: {
          kind: 'terminal',
          code: row.error_code ?? 'delivery_terminal_failure',
          message: row.error_message ?? 'GitHub delivery cannot be retried automatically',
        },
      };
    }

    const nextRetryCount = row.retry_count + (row.status === 'failed' ? 1 : 0);
    const now = new Date().toISOString();
    await env.DB.prepare(
      `UPDATE delivery_records
       SET status = 'pending', retryable = 1, retry_count = ?, error_code = NULL,
           error_message = NULL, updated_at = ? WHERE id = ?`,
    )
      .bind(nextRetryCount, now, row.id)
      .run();
    row = await readDeliveryById(env, row.id);
  } else {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    try {
      await env.DB.prepare(
        `INSERT INTO delivery_records
         (id, task_id, final_draft_id, destination, idempotency_key, status, retryable,
          retry_count, content_sha256, created_at, updated_at)
         VALUES (?, ?, ?, 'github', ?, 'pending', 1, 0, ?, ?, ?)`,
      )
        .bind(id, draft.taskId, draft.id, key, contentSha, now, now)
        .run();
      row = await readDeliveryById(env, id);
    } catch {
      const winner = await readDeliveryByKey(env, draft.taskId, key);
      if (!winner) {
        return {
          ok: false,
          record: null,
          error: {
            kind: 'retryable',
            code: 'delivery_record_persist_failed',
            message: 'Delivery record could not be persisted',
          },
        };
      }
      return executeDestinationDelivery(env, adapter, draft, key);
    }
  }

  if (!row) {
    return {
      ok: false,
      record: null,
      error: {
        kind: 'retryable',
        code: 'delivery_record_missing',
        message: 'Delivery record could not be loaded after persistence',
      },
    };
  }

  await markDeliveryStageRunning(env, draft.taskId, row.retry_count);
  const result = await adapter.deliver({
    taskId: draft.taskId,
    finalDraftId: draft.id,
    idempotencyKey: key,
    title: draft.title,
    markdown: draft.markdown,
    confirmedAt: draft.confirmedAt,
  });

  if (!result.ok) {
    const now = new Date().toISOString();
    await env.DB.prepare(
      `UPDATE delivery_records
       SET status = 'failed', retryable = ?, error_code = ?, error_message = ?, updated_at = ?
       WHERE id = ?`,
    )
      .bind(
        result.error.kind === 'retryable' ? 1 : 0,
        result.error.code,
        result.error.message,
        now,
        row.id,
      )
      .run();
    await markDeliveryStageFailed(env, draft.taskId, result.error);
    const failed = await readDeliveryById(env, row.id);
    return { ok: false, record: failed ? toView(failed) : null, error: result.error };
  }

  const now = new Date().toISOString();
  await env.DB.prepare(
    `UPDATE delivery_records
     SET status = 'succeeded', retryable = 0, repository = ?, path = ?, commit_sha = ?,
         file_url = ?, error_code = NULL, error_message = NULL, delivered_at = ?, updated_at = ?
     WHERE id = ?`,
  )
    .bind(
      result.value.repository,
      result.value.path,
      result.value.commitSha,
      result.value.fileUrl,
      result.value.deliveredAt,
      now,
      row.id,
    )
    .run();
  await markDeliveryStageSucceeded(env, draft.taskId);
  const succeeded = await readDeliveryById(env, row.id);
  if (!succeeded) {
    return {
      ok: false,
      record: null,
      error: {
        kind: 'retryable',
        code: 'delivery_record_missing',
        message: 'Delivery succeeded but its evidence record could not be reloaded',
      },
    };
  }
  return { ok: true, record: toView(succeeded), delivery: result.value };
}

export async function deliverConfirmedFinalDraftToGithub(
  env: Mob022GithubEnv,
  draft: ConfirmedFinalDraftSnapshot,
  idempotencyKey: string,
): Promise<DeliveryExecutionResult> {
  const adapter = new GithubDestinationAdapter({
    token: env.GITHUB_DESTINATION_TOKEN,
    ...(env.GITHUB_DESTINATION_OWNER ? { owner: env.GITHUB_DESTINATION_OWNER } : {}),
    ...(env.GITHUB_DESTINATION_REPOSITORY
      ? { repository: env.GITHUB_DESTINATION_REPOSITORY }
      : {}),
    ...(env.GITHUB_DESTINATION_BRANCH ? { branch: env.GITHUB_DESTINATION_BRANCH } : {}),
    ...(env.GITHUB_DESTINATION_ROOT ? { contentRoot: env.GITHUB_DESTINATION_ROOT } : {}),
  });
  return executeDestinationDelivery(env, adapter, draft, idempotencyKey);
}

export async function handleMob022Request(
  request: Request,
  env: Mob022GithubEnv,
  device: { id: string },
  requestId: string,
): Promise<Response | null> {
  const url = new URL(request.url);
  const match = /^\/v1\/capture-tasks\/([^/]+)\/deliveries$/.exec(url.pathname);
  if (!match) return null;
  if (request.method !== 'GET' && request.method !== 'POST') {
    return errorResponse(requestId, 405, 'method_not_allowed', 'Method not allowed');
  }
  const taskId = parseTaskId(match[1]);
  if (!taskId) {
    return errorResponse(requestId, 400, 'invalid_task_id', 'Invalid CaptureTask id');
  }
  if (!(await taskOwnedByDevice(env, taskId, device.id))) {
    return errorResponse(requestId, 404, 'task_not_found', 'CaptureTask not found');
  }

  if (request.method === 'POST') {
    const body = await safeJson(request);
    const destination = typeof body?.destination === 'string' ? body.destination.trim() : '';
    const idempotencyKey =
      typeof body?.idempotencyKey === 'string' ? body.idempotencyKey.trim() : '';
    if (destination !== 'github' || !idempotencyKey || idempotencyKey.length > 128) {
      return errorResponse(
        requestId,
        400,
        'delivery_invalid_input',
        'destination github and idempotencyKey are required',
      );
    }

    const draft = await readConfirmedFinalDraft(env, taskId);
    if (!draft) {
      return errorResponse(
        requestId,
        409,
        'final_draft_not_ready',
        'A confirmed Final Draft is required before delivery',
        false,
        taskId,
      );
    }

    const result = await deliverConfirmedFinalDraftToGithub(env, draft, idempotencyKey);
    if (!result.ok) {
      const status =
        result.error.code === 'delivery_idempotency_conflict' ||
        result.error.code === 'github_path_conflict'
          ? 409
          : result.error.kind === 'retryable'
            ? 503
            : 502;
      return errorResponse(
        requestId,
        status,
        result.error.code,
        result.error.message,
        result.error.kind === 'retryable',
        taskId,
      );
    }
    return response({
      ok: true,
      data: { taskId, record: result.record, delivery: result.delivery },
      requestId,
    });
  }

  return response({
    ok: true,
    data: { taskId, deliveries: await listDeliveries(env, taskId) },
    requestId,
  });
}
