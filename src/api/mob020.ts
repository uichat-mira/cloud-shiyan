import type { Mob019D1, Mob019D1Statement, Mob019WorkflowStep } from './mob019';
import type {
  LlmOutcome,
  OrganizeSuccess,
  SceneSectionSpec,
  SceneSpec,
  ShiyanLlmBinding,
  StructuredOrganization,
} from '../shared/llm';
import {
  BUILT_IN_SCENES,
  findBuiltInScene,
  isReservedSceneId,
  SCENE_ID_PATTERN,
  validateSceneSpec,
} from '../shared/scenes';

export interface Mob019WorkflowBinding {
  create(input?: { id?: string; params?: Record<string, unknown> }): Promise<unknown>;
  get(id: string): Promise<unknown>;
}

export interface Mob020Env {
  DB: Mob019D1;
  LLM: ShiyanLlmBinding;
  CAPTURE_WORKFLOW: Mob019WorkflowBinding;
}

export interface AiDraftView {
  id: string;
  taskId: string;
  kind: 'ai';
  version: number;
  source: 'organize' | 'adjust';
  baseVersion: number | null;
  instruction: string | null;
  markdown: string;
  structured: StructuredOrganization;
  sceneId: string;
  provider: string;
  model: string;
  latencyMs: number;
  usage: {
    promptTokens: number | null;
    completionTokens: number | null;
    totalTokens: number | null;
  };
  providerRequestId: string | null;
  fallbackUsed: boolean;
  correlationId: string;
  createdAt: string;
}

export interface FinalDraftView {
  id: string;
  taskId: string;
  kind: 'final';
  version: number;
  title: string;
  markdown: string;
  structured: StructuredOrganization | null;
  sceneId: string;
  baseVersion: number | null;
  correlationId: string;
  confirmedAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface SceneView {
  id: string;
  name: string;
  instruction: string;
  sections: SceneSectionSpec[];
  builtIn: boolean;
}

type DraftRow = {
  id: string;
  task_id: string;
  kind: string;
  version: number;
  source: 'organize' | 'adjust' | 'user-edit';
  base_version: number | null;
  instruction: string | null;
  idempotency_key: string | null;
  title: string | null;
  markdown: string;
  structured_json: string | null;
  scene_id: string;
  provider: string | null;
  model: string | null;
  latency_ms: number | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  total_tokens: number | null;
  provider_request_id: string | null;
  fallback_used: number;
  correlation_id: string;
  confirmed_at: string | null;
  created_at: string;
  updated_at: string;
};

type TaskSceneRow = {
  id: string;
  device_id: string;
  title: string;
  scene_id: string;
};

// AI draft rows always carry provider telemetry: they only come from the
// organize / adjust LLM path. Final drafts never do.
type AiDraftRow = DraftRow & {
  kind: 'ai';
  provider: string;
  model: string;
  latency_ms: number;
  structured_json: string;
};

type TranscriptTextRow = {
  text: string;
  language: string | null;
};

type OrganizeStageRow = {
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped';
  retryable: number;
  retry_count: number;
};

type SceneRow = {
  id: string;
  name: string;
  instruction: string;
  sections_json: string;
};

const TASK_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

const DRAFT_COLUMNS = `id, task_id, kind, version, source, base_version, instruction,
     idempotency_key, title, markdown, structured_json, scene_id, provider, model,
     latency_ms, prompt_tokens, completion_tokens, total_tokens, provider_request_id,
     fallback_used, correlation_id, confirmed_at, created_at, updated_at`;

const FINAL_DRAFT_MARKDOWN_MAX_LENGTH = 2_000_000;
const FINAL_DRAFT_TITLE_MAX_LENGTH = 300;

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

const parseStructured = (value: string | null): StructuredOrganization | null => {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      Array.isArray((parsed as StructuredOrganization).sections)
    ) {
      return parsed as StructuredOrganization;
    }
  } catch {
    // fall through
  }
  return null;
};

const toAiDraftView = (row: AiDraftRow): AiDraftView => ({
  id: row.id,
  taskId: row.task_id,
  kind: 'ai',
  version: row.version,
  source: row.source === 'adjust' ? 'adjust' : 'organize',
  baseVersion: row.base_version,
  instruction: row.instruction,
  markdown: row.markdown,
  structured: parseStructured(row.structured_json) ?? { summary: '', sections: [] },
  sceneId: row.scene_id,
  provider: row.provider,
  model: row.model,
  latencyMs: row.latency_ms,
  usage: {
    promptTokens: row.prompt_tokens,
    completionTokens: row.completion_tokens,
    totalTokens: row.total_tokens,
  },
  providerRequestId: row.provider_request_id,
  fallbackUsed: row.fallback_used === 1,
  correlationId: row.correlation_id,
  createdAt: row.created_at,
});

const toFinalDraftView = (row: DraftRow): FinalDraftView => ({
  id: row.id,
  taskId: row.task_id,
  kind: 'final',
  version: row.version,
  title: row.title ?? '',
  markdown: row.markdown,
  structured: parseStructured(row.structured_json),
  sceneId: row.scene_id,
  baseVersion: row.base_version,
  correlationId: row.correlation_id,
  confirmedAt: row.confirmed_at ?? row.updated_at,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const toSceneView = (scene: SceneSpec, builtIn: boolean): SceneView => ({
  id: scene.id,
  name: scene.name,
  instruction: scene.instruction,
  sections: scene.sections,
  builtIn,
});

async function taskOwnedByDevice(
  env: Mob020Env,
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

async function readTaskScene(env: Mob020Env, taskId: string): Promise<TaskSceneRow | null> {
  return env.DB.prepare(
    `SELECT id, device_id, title, scene_id FROM capture_tasks WHERE id = ? LIMIT 1`,
  )
    .bind(taskId)
    .first<TaskSceneRow>();
}

async function readTranscriptText(
  env: Mob020Env,
  taskId: string,
): Promise<TranscriptTextRow | null> {
  return env.DB.prepare(
    'SELECT text, language FROM transcripts WHERE task_id = ? LIMIT 1',
  )
    .bind(taskId)
    .first<TranscriptTextRow>();
}

async function readLatestAiDraft(
  env: Mob020Env,
  taskId: string,
): Promise<AiDraftRow | null> {
  return env.DB.prepare(
    `SELECT ${DRAFT_COLUMNS}
     FROM drafts WHERE task_id = ? AND kind = 'ai'
     ORDER BY version DESC LIMIT 1`,
  )
    .bind(taskId)
    .first<AiDraftRow>();
}

async function readAiDraftByVersion(
  env: Mob020Env,
  taskId: string,
  version: number,
): Promise<AiDraftRow | null> {
  return env.DB.prepare(
    `SELECT ${DRAFT_COLUMNS}
     FROM drafts WHERE task_id = ? AND kind = 'ai' AND version = ? LIMIT 1`,
  )
    .bind(taskId, version)
    .first<AiDraftRow>();
}

async function readFinalDraft(
  env: Mob020Env,
  taskId: string,
): Promise<DraftRow | null> {
  return env.DB.prepare(
    `SELECT ${DRAFT_COLUMNS}
     FROM drafts WHERE task_id = ? AND kind = 'final' LIMIT 1`,
  )
    .bind(taskId)
    .first<DraftRow>();
}

async function readDraftByIdempotencyKey(
  env: Mob020Env,
  taskId: string,
  idempotencyKey: string,
): Promise<AiDraftRow | null> {
  return env.DB.prepare(
    `SELECT ${DRAFT_COLUMNS}
     FROM drafts WHERE task_id = ? AND idempotency_key = ? LIMIT 1`,
  )
    .bind(taskId, idempotencyKey)
    .first<AiDraftRow>();
}

async function resolveScene(
  env: Mob020Env,
  deviceId: string,
  sceneId: string,
): Promise<SceneSpec | null> {
  const builtIn = findBuiltInScene(sceneId);
  if (builtIn) return builtIn;

  const row = await env.DB.prepare(
    'SELECT id, name, instruction, sections_json FROM scenes WHERE device_id = ? AND id = ? LIMIT 1',
  )
    .bind(deviceId, sceneId)
    .first<SceneRow>();
  if (!row) return null;

  let sections: unknown;
  try {
    sections = JSON.parse(row.sections_json);
  } catch {
    return null;
  }
  const scene = validateSceneSpec({
    id: row.id,
    name: row.name,
    instruction: row.instruction,
    sections,
  });
  return scene.ok ? scene.value : null;
}

async function ensureStage(
  env: Mob020Env,
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

type StageFailure = {
  kind: 'retryable' | 'terminal';
  code: string;
  message: string;
};

async function markStageFailed(
  env: Mob020Env,
  taskId: string,
  stage: string,
  failure: StageFailure,
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

const llmServiceFailure = (): StageFailure => ({
  kind: 'retryable',
  code: 'llm_service_unavailable',
  message: 'The shiyan-llm service could not be reached',
});

const draftInsertStatement = (
  env: Mob020Env,
  options: {
    taskId: string;
    version: number;
    source: 'organize' | 'adjust';
    baseVersion: number | null;
    instruction: string | null;
    idempotencyKey: string | null;
    sceneId: string;
    correlationId: string;
    now: string;
    value: OrganizeSuccess;
  },
): Mob019D1Statement =>
  env.DB.prepare(
    `INSERT OR IGNORE INTO drafts
     (id, task_id, kind, version, source, base_version, instruction, idempotency_key,
      title, markdown, structured_json, scene_id, provider, model, latency_ms,
      prompt_tokens, completion_tokens, total_tokens, provider_request_id,
      fallback_used, correlation_id, confirmed_at, created_at, updated_at)
     VALUES (?, ?, 'ai', ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
  ).bind(
    crypto.randomUUID(),
    options.taskId,
    options.version,
    options.source,
    options.baseVersion,
    options.instruction,
    options.idempotencyKey,
    options.value.markdown,
    JSON.stringify(options.value.structured),
    options.sceneId,
    options.value.provider,
    options.value.model,
    options.value.latencyMs,
    options.value.usage?.promptTokens ?? null,
    options.value.usage?.completionTokens ?? null,
    options.value.usage?.totalTokens ?? null,
    options.value.providerRequestId ?? null,
    options.value.fallbackUsed ? 1 : 0,
    options.correlationId,
    options.now,
    options.now,
  );

export interface Mob020OrganizeResult {
  ok: boolean;
}

type OrganizeStepOutcome =
  | { ok: true; value: OrganizeSuccess; sceneId: string }
  | { ok: false; errorCode: string };

/**
 * Workflow steps for the MOB-020 organize chain:
 *
 * ```text
 * organize (LLM structured organization) -> persist-ai-draft (D1 + mark ready)
 * ```
 *
 * The step results only carry ids and small metadata; the draft payload is
 * persisted directly from the organize step result and never flows through
 * large workflow state.
 */
export async function runMob020Organize(
  env: Mob020Env,
  payload: { taskId: string; requestId?: string },
  step: Mob019WorkflowStep,
): Promise<Mob020OrganizeResult> {
  const organized = await step.do('organize', () =>
    runOrganizeStep(env, {
      taskId: payload.taskId,
      correlationId: payload.requestId ?? `organize-${payload.taskId}`,
    }),
  );
  if (!organized.ok) return { ok: false };

  const persisted = await step.do('persist-ai-draft', () =>
    runPersistAiDraftStep(env, payload, organized),
  );
  return { ok: persisted.ok };
}

async function runOrganizeStep(
  env: Mob020Env,
  input: { taskId: string; correlationId: string },
): Promise<OrganizeStepOutcome> {
  const now = new Date().toISOString();
  await ensureStage(env, input.taskId, 'organize', now);
  await env.DB.prepare(
    `UPDATE capture_stages
     SET status = 'running', retryable = 1, error_code = NULL, error_message = NULL,
         started_at = ?, finished_at = NULL, updated_at = ?
     WHERE task_id = ? AND stage = 'organize'`,
  )
    .bind(now, now, input.taskId)
    .run();

  const failed = async (failure: StageFailure): Promise<OrganizeStepOutcome> => {
    await markStageFailed(env, input.taskId, 'organize', failure);
    return { ok: false, errorCode: failure.code };
  };

  const task = await readTaskScene(env, input.taskId);
  if (!task) {
    return failed({
      kind: 'terminal',
      code: 'capture_task_missing',
      message: 'CaptureTask disappeared before organize could run',
    });
  }

  const transcript = await readTranscriptText(env, input.taskId);
  if (!transcript) {
    return failed({
      kind: 'terminal',
      code: 'transcript_missing',
      message: 'Organize requires a persisted Transcript',
    });
  }

  const scene = await resolveScene(env, task.device_id, task.scene_id);
  if (!scene) {
    return failed({
      kind: 'terminal',
      code: 'scene_not_found',
      message: `Scene "${task.scene_id}" is not a built-in or registered custom scene`,
    });
  }

  let outcome: LlmOutcome;
  try {
    outcome = await env.LLM.generateStructured({
      taskId: input.taskId,
      correlationId: input.correlationId,
      scene,
      title: task.title,
      transcriptText: transcript.text,
      ...(transcript.language ? { language: transcript.language } : {}),
    });
  } catch {
    return failed(llmServiceFailure());
  }

  if (!outcome.ok) {
    // Provider failures are already normalized by shiyan-llm: retryable kinds
    // keep the stage retryable; schema/prompt errors stay terminal so they are
    // never masked by an automatic fallback.
    return failed({
      kind: outcome.error.kind,
      code: outcome.error.code,
      message: outcome.error.message,
    });
  }

  const finishedAt = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE capture_stages
       SET status = 'succeeded', retryable = 0, error_code = NULL,
           error_message = NULL, finished_at = ?, updated_at = ?
       WHERE task_id = ? AND stage = 'organize'`,
    ).bind(finishedAt, finishedAt, input.taskId),
    env.DB.prepare(
      `INSERT OR IGNORE INTO capture_stages
       (task_id, stage, status, retryable, retry_count, updated_at)
       VALUES (?, 'persist-ai-draft', 'pending', 1, 0, ?)`,
    ).bind(input.taskId, finishedAt),
    env.DB.prepare(
      `UPDATE capture_tasks SET current_stage = 'persist-ai-draft', updated_at = ?
       WHERE id = ?`,
    ).bind(finishedAt, input.taskId),
  ]);

  return { ok: true, value: outcome.value, sceneId: task.scene_id };
}

async function runPersistAiDraftStep(
  env: Mob020Env,
  payload: { taskId: string; requestId?: string },
  organized: { value: OrganizeSuccess; sceneId: string },
): Promise<{ ok: boolean }> {
  const now = new Date().toISOString();
  await ensureStage(env, payload.taskId, 'persist-ai-draft', now);
  await env.DB.prepare(
    `UPDATE capture_stages
     SET status = 'running', retryable = 1, error_code = NULL, error_message = NULL,
         started_at = ?, finished_at = NULL, updated_at = ?
     WHERE task_id = ? AND stage = 'persist-ai-draft'`,
  )
    .bind(now, now, payload.taskId)
    .run();

  try {
    // Version 1 is owned by the organize stage; INSERT OR IGNORE keeps the
    // original draft when a recovered workflow replays this step.
    await draftInsertStatement(env, {
      taskId: payload.taskId,
      version: 1,
      source: 'organize',
      baseVersion: null,
      instruction: null,
      idempotencyKey: null,
      sceneId: organized.sceneId,
      correlationId: payload.requestId ?? `organize-${payload.taskId}`,
      now,
      value: organized.value,
    }).run();

    const finishedAt = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE capture_stages
         SET status = 'succeeded', retryable = 0, error_code = NULL,
             error_message = NULL, finished_at = ?, updated_at = ?
         WHERE task_id = ? AND stage = 'persist-ai-draft'`,
      ).bind(finishedAt, finishedAt, payload.taskId),
      env.DB.prepare(
        `UPDATE capture_tasks SET current_stage = 'persist-ai-draft', updated_at = ?
         WHERE id = ?`,
      ).bind(finishedAt, payload.taskId),
      // Reaching a persisted AI Draft moves the task into the user-facing
      // review state. Cancelled tasks are never resurrected.
      env.DB.prepare(
        `UPDATE capture_tasks SET lifecycle_status = 'ready', updated_at = ?
         WHERE id = ? AND lifecycle_status = 'active'`,
      ).bind(finishedAt, payload.taskId),
    ]);
    return { ok: true };
  } catch (error) {
    await markStageFailed(env, payload.taskId, 'persist-ai-draft', {
      kind: 'retryable',
      code: 'ai_draft_persist_failed',
      message:
        error instanceof Error
          ? error.message
          : 'AI Draft could not be persisted',
    });
    return { ok: false };
  }
}

async function retryOrganize(
  env: Mob020Env,
  taskId: string,
  requestId: string,
): Promise<Response> {
  const transcript = await readTranscriptText(env, taskId);
  if (!transcript) {
    return errorResponse(
      requestId,
      409,
      'organize_retry_requires_transcript',
      'Organize retry requires a persisted Transcript',
      false,
      taskId,
    );
  }

  const stage = await env.DB.prepare(
    `SELECT status, retryable, retry_count
     FROM capture_stages WHERE task_id = ? AND stage = 'organize' LIMIT 1`,
  )
    .bind(taskId)
    .first<OrganizeStageRow>();

  if (!stage) {
    return errorResponse(
      requestId,
      409,
      'organize_not_started',
      'Organize has not started yet',
      true,
      taskId,
    );
  }
  if (stage.status === 'running') {
    return errorResponse(
      requestId,
      409,
      'organize_in_progress',
      'Organize is currently running',
      true,
      taskId,
    );
  }
  if (stage.status === 'succeeded') {
    return errorResponse(
      requestId,
      409,
      'organize_already_succeeded',
      'Organize already produced a draft; use AI adjust instead',
      false,
      taskId,
    );
  }
  // Failed (retryable or terminal) and stuck pending stages may re-run:
  // the user retries explicitly after fixing the underlying cause, which is
  // different from the automatic provider fallback inside one call.

  const retryCount = stage.retry_count + 1;
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE capture_stages
       SET status = 'pending', retryable = 1, retry_count = ?, error_code = NULL,
           error_message = NULL, started_at = NULL, finished_at = NULL, updated_at = ?
       WHERE task_id = ? AND stage = 'organize'`,
    ).bind(retryCount, now, taskId),
    env.DB.prepare(
      `UPDATE capture_tasks SET current_stage = 'organize', updated_at = ? WHERE id = ?`,
    ).bind(now, taskId),
  ]);

  const workflowId = `capture-${taskId}-organize-${retryCount}`;
  let started = false;
  try {
    await env.CAPTURE_WORKFLOW.create({
      id: workflowId,
      params: { taskId, requestId, startStage: 'organize' },
    });
    started = true;
  } catch {
    try {
      await env.CAPTURE_WORKFLOW.get(workflowId);
      started = true;
    } catch {
      started = false;
    }
  }

  if (!started) {
    await markStageFailed(env, taskId, 'organize', {
      kind: 'retryable',
      code: 'workflow_start_failed',
      message: 'Organize retry workflow could not be started',
    });
    return errorResponse(
      requestId,
      503,
      'workflow_start_failed',
      'Organize retry could not start yet',
      true,
      taskId,
    );
  }

  return response({
    ok: true,
    data: { taskId, stage: 'organize', retryCount },
    requestId,
  });
}

async function getAiDraft(
  env: Mob020Env,
  taskId: string,
  requestId: string,
): Promise<Response> {
  const draft = await readLatestAiDraft(env, taskId);
  if (!draft) {
    return errorResponse(
      requestId,
      404,
      'ai_draft_not_ready',
      'AI Draft is not available yet',
      true,
      taskId,
    );
  }
  return response({ ok: true, data: { draft: toAiDraftView(draft) }, requestId });
}

type AdjustInput = { instruction: string; idempotencyKey: string } | null;

const parseAdjustInput = (value: Record<string, unknown>): AdjustInput => {
  const instruction =
    typeof value.instruction === 'string' ? value.instruction.trim() : '';
  const idempotencyKey =
    typeof value.idempotencyKey === 'string' ? value.idempotencyKey.trim() : '';
  if (!instruction || instruction.length > 2000) return null;
  if (!idempotencyKey || idempotencyKey.length > 128) return null;
  return { instruction, idempotencyKey };
};

async function adjustAiDraft(
  request: Request,
  env: Mob020Env,
  taskId: string,
  requestId: string,
): Promise<Response> {
  const raw = await safeJson(request);
  const input = raw ? parseAdjustInput(raw) : null;
  if (!input) {
    return errorResponse(
      requestId,
      400,
      'invalid_request',
      'instruction and idempotencyKey are required',
      false,
      taskId,
    );
  }

  const task = await readTaskScene(env, taskId);
  if (!task) {
    return errorResponse(requestId, 404, 'task_not_found', 'CaptureTask not found');
  }

  const transcript = await readTranscriptText(env, taskId);
  if (!transcript) {
    return errorResponse(
      requestId,
      409,
      'transcript_not_ready',
      'AI adjust requires a persisted Transcript',
      true,
      taskId,
    );
  }

  const base = await readLatestAiDraft(env, taskId);
  if (!base) {
    return errorResponse(
      requestId,
      409,
      'ai_draft_not_ready',
      'AI adjust requires an existing AI Draft',
      true,
      taskId,
    );
  }

  // Idempotency: the same key replays the previously generated candidate;
  // the same key with a different instruction is a conflict. A replay always
  // returns the original candidate, even if newer versions exist.
  const existing = await readDraftByIdempotencyKey(env, taskId, input.idempotencyKey);
  if (existing) {
    if (existing.instruction === input.instruction) {
      return response({
        ok: true,
        data: { draft: toAiDraftView(existing) },
        requestId,
      });
    }
    return errorResponse(
      requestId,
      409,
      'idempotency_content_conflict',
      'This idempotency key was already used with a different adjustment request',
      false,
      taskId,
    );
  }

  const scene = await resolveScene(env, task.device_id, task.scene_id);
  if (!scene) {
    return errorResponse(
      requestId,
      409,
      'scene_not_found',
      `Scene "${task.scene_id}" is no longer available`,
      false,
      taskId,
    );
  }

  let outcome: LlmOutcome;
  try {
    outcome = await env.LLM.adjustDraft({
      taskId,
      correlationId: requestId,
      scene,
      title: task.title,
      transcriptText: transcript.text,
      ...(transcript.language ? { language: transcript.language } : {}),
      currentDraft: {
        structured: parseStructured(base.structured_json) ?? { summary: '', sections: [] },
        markdown: base.markdown,
      },
      instruction: input.instruction,
    });
  } catch {
    return errorResponse(
      requestId,
      502,
      'llm_service_unavailable',
      'The shiyan-llm service could not be reached',
      true,
      taskId,
    );
  }

  if (!outcome.ok) {
    const retryable = outcome.error.kind === 'retryable';
    return errorResponse(
      requestId,
      retryable ? 502 : 409,
      outcome.error.code,
      outcome.error.message,
      retryable,
      taskId,
    );
  }

  // Adjustments only ever append new AI draft versions. The Transcript and
  // any Final Draft stay untouched: AI never overwrites human content.
  const now = new Date().toISOString();
  try {
    await draftInsertStatement(env, {
      taskId,
      version: base.version + 1,
      source: 'adjust',
      baseVersion: base.version,
      instruction: input.instruction,
      idempotencyKey: input.idempotencyKey,
      sceneId: task.scene_id,
      correlationId: requestId,
      now,
      value: outcome.value,
    }).run();
  } catch {
    return errorResponse(
      requestId,
      409,
      'draft_version_conflict',
      'A newer AI Draft version was created concurrently; retry the adjustment',
      true,
      taskId,
    );
  }

  const draft = await readDraftByIdempotencyKey(env, taskId, input.idempotencyKey);
  if (!draft) {
    return errorResponse(
      requestId,
      500,
      'canonical_state_missing',
      'Adjusted AI Draft could not be read back',
      false,
      taskId,
    );
  }
  return response({ ok: true, data: { draft: toAiDraftView(draft) }, requestId });
}

type FinalDraftInput = { markdown: string; title: string | null; baseVersion: number | null } | null;

const parseFinalDraftInput = (value: Record<string, unknown>): FinalDraftInput => {
  const markdown = typeof value.markdown === 'string' ? value.markdown : '';
  if (!markdown.trim() || markdown.length > FINAL_DRAFT_MARKDOWN_MAX_LENGTH) return null;
  const title = typeof value.title === 'string' ? value.title.trim() : '';
  if (title.length > FINAL_DRAFT_TITLE_MAX_LENGTH) return null;
  if (
    value.baseVersion !== undefined &&
    (!Number.isSafeInteger(value.baseVersion) || (value.baseVersion as number) < 1)
  ) {
    return null;
  }
  return {
    markdown,
    title: title || null,
    baseVersion:
      typeof value.baseVersion === 'number' ? (value.baseVersion as number) : null,
  };
};

/**
 * Final Draft storage/confirmation contract (owned by MOB-020).
 *
 * The user's final edit is a single working state per task (version 1,
 * upserted on every save). AI paths never write kind='final', so no
 * background refresh can silently overwrite human content. The stored
 * title/markdown/confirmedAt triple is the confirmed snapshot that the
 * MOB-022 delivery layer consumes.
 */
async function saveFinalDraft(
  request: Request,
  env: Mob020Env,
  taskId: string,
  requestId: string,
): Promise<Response> {
  const raw = await safeJson(request);
  const input = raw ? parseFinalDraftInput(raw) : null;
  if (!input) {
    return errorResponse(
      requestId,
      400,
      'invalid_request',
      'markdown is required; baseVersion must be a positive integer when present',
      false,
      taskId,
    );
  }

  const task = await readTaskScene(env, taskId);
  if (!task) {
    return errorResponse(requestId, 404, 'task_not_found', 'CaptureTask not found');
  }

  const latestAiDraft = await readLatestAiDraft(env, taskId);
  if (!latestAiDraft) {
    return errorResponse(
      requestId,
      409,
      'final_draft_requires_ai_draft',
      'The Final Draft can only be saved after an AI Draft exists',
      true,
      taskId,
    );
  }

  const baseVersion = input.baseVersion ?? latestAiDraft.version;
  if (baseVersion > latestAiDraft.version) {
    return errorResponse(
      requestId,
      409,
      'final_draft_base_version_invalid',
      'baseVersion refers to an AI Draft version that does not exist',
      false,
      taskId,
    );
  }

  const baseDraft =
    baseVersion === latestAiDraft.version
      ? latestAiDraft
      : await readAiDraftByVersion(env, taskId, baseVersion);
  const structuredJson = baseDraft?.structured_json ?? null;

  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO drafts
     (id, task_id, kind, version, source, base_version, instruction, idempotency_key,
      title, markdown, structured_json, scene_id, provider, model, latency_ms,
      prompt_tokens, completion_tokens, total_tokens, provider_request_id,
      fallback_used, correlation_id, confirmed_at, created_at, updated_at)
     VALUES (?, ?, 'final', 1, 'user-edit', ?, NULL, NULL, ?, ?, ?, ?,
             NULL, NULL, NULL, NULL, NULL, NULL, NULL, 0, ?, ?, ?, ?)
     ON CONFLICT(task_id, kind, version) DO UPDATE SET
       base_version = excluded.base_version,
       title = excluded.title,
       markdown = excluded.markdown,
       structured_json = excluded.structured_json,
       correlation_id = excluded.correlation_id,
       confirmed_at = excluded.confirmed_at,
       updated_at = excluded.updated_at`,
  )
    .bind(
      crypto.randomUUID(),
      taskId,
      baseVersion,
      input.title ?? task.title,
      input.markdown,
      structuredJson,
      task.scene_id,
      requestId,
      now,
      now,
      now,
    )
    .run();

  const draft = await readFinalDraft(env, taskId);
  if (!draft) {
    return errorResponse(
      requestId,
      500,
      'canonical_state_missing',
      'Final Draft could not be read back',
      false,
      taskId,
    );
  }
  return response({ ok: true, data: { draft: toFinalDraftView(draft) }, requestId });
}

async function getFinalDraft(
  env: Mob020Env,
  taskId: string,
  requestId: string,
): Promise<Response> {
  const draft = await readFinalDraft(env, taskId);
  if (!draft) {
    return errorResponse(
      requestId,
      404,
      'final_draft_not_ready',
      'Final Draft has not been saved yet',
      false,
      taskId,
    );
  }
  return response({ ok: true, data: { draft: toFinalDraftView(draft) }, requestId });
}

const scenesMatch = (
  row: { name: string; instruction: string; sections_json: string },
  scene: SceneSpec,
): boolean => {
  try {
    const sections = JSON.parse(row.sections_json) as SceneSectionSpec[];
    return (
      row.name === scene.name &&
      row.instruction === scene.instruction &&
      JSON.stringify(sections) === JSON.stringify(scene.sections)
    );
  } catch {
    return false;
  }
};

async function createScene(
  request: Request,
  env: Mob020Env,
  device: { id: string; user_id?: string | null },
  requestId: string,
): Promise<Response> {
  const raw = await safeJson(request);
  if (!raw || typeof raw.id !== 'string') {
    return errorResponse(requestId, 400, 'invalid_request', 'scene id is required');
  }
  const sceneId = raw.id.trim();
  if (!SCENE_ID_PATTERN.test(sceneId)) {
    return errorResponse(
      requestId,
      400,
      'invalid_scene_id',
      `scene id must match ${SCENE_ID_PATTERN.source}`,
    );
  }
  if (isReservedSceneId(sceneId)) {
    return errorResponse(
      requestId,
      400,
      'reserved_scene_id',
      `"${sceneId}" is reserved for a built-in scene`,
    );
  }

  const validated = validateSceneSpec({
    id: sceneId,
    name: raw.name,
    instruction: raw.instruction,
    sections: raw.sections,
  });
  if (!validated.ok) {
    return errorResponse(
      requestId,
      400,
      'invalid_request',
      `Invalid scene: ${validated.issues.join('; ')}`,
    );
  }
  const scene = validated.value;

  const existing = await env.DB.prepare(
    'SELECT id, name, instruction, sections_json FROM scenes WHERE device_id = ? AND id = ? LIMIT 1',
  )
    .bind(device.id, sceneId)
    .first<SceneRow>();
  if (existing) {
    if (scenesMatch(existing, scene)) {
      return response({
        ok: true,
        data: { scene: toSceneView(scene, false) },
        requestId,
      });
    }
    return errorResponse(
      requestId,
      409,
      'scene_id_conflict',
      'This scene id already exists with different content',
    );
  }

  const now = new Date().toISOString();
  try {
    await env.DB.prepare(
      `INSERT INTO scenes
       (id, device_id, user_id, name, instruction, sections_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        sceneId,
        device.id,
        device.user_id ?? null,
        scene.name,
        scene.instruction,
        JSON.stringify(scene.sections),
        now,
        now,
      )
      .run();
  } catch {
    const winner = await env.DB.prepare(
      'SELECT id, name, instruction, sections_json FROM scenes WHERE device_id = ? AND id = ? LIMIT 1',
    )
      .bind(device.id, sceneId)
      .first<SceneRow>();
    if (winner && scenesMatch(winner, scene)) {
      return response({
        ok: true,
        data: { scene: toSceneView(scene, false) },
        requestId,
      });
    }
    return errorResponse(
      requestId,
      409,
      'scene_id_conflict',
      'This scene id already exists with different content',
    );
  }

  return response(
    { ok: true, data: { scene: toSceneView(scene, false) }, requestId },
    201,
  );
}

async function listScenes(
  env: Mob020Env,
  device: { id: string },
  requestId: string,
): Promise<Response> {
  const rows = await env.DB.prepare(
    'SELECT id, name, instruction, sections_json FROM scenes WHERE device_id = ? ORDER BY created_at ASC',
  )
    .bind(device.id)
    .all<SceneRow>();

  const scenes: SceneView[] = BUILT_IN_SCENES.map((scene) =>
    toSceneView(scene, true),
  );
  for (const row of rows.results ?? []) {
    let sections: unknown;
    try {
      sections = JSON.parse(row.sections_json);
    } catch {
      continue;
    }
    const validated = validateSceneSpec({
      id: row.id,
      name: row.name,
      instruction: row.instruction,
      sections,
    });
    if (validated.ok) scenes.push(toSceneView(validated.value, false));
  }

  return response({ ok: true, data: { scenes }, requestId });
}

export async function handleMob020Request(
  request: Request,
  env: Mob020Env,
  device: { id: string; user_id?: string | null },
  requestId: string,
): Promise<Response | null> {
  const url = new URL(request.url);

  if (request.method === 'POST' && url.pathname === '/v1/scenes') {
    return createScene(request, env, device, requestId);
  }
  if (request.method === 'GET' && url.pathname === '/v1/scenes') {
    return listScenes(env, device, requestId);
  }

  const aiDraftMatch = /^\/v1\/capture-tasks\/([^/]+)\/ai-draft$/.exec(url.pathname);
  const adjustMatch = /^\/v1\/capture-tasks\/([^/]+)\/ai-draft\/adjust$/.exec(
    url.pathname,
  );
  const retryMatch = /^\/v1\/capture-tasks\/([^/]+)\/organize\/retry$/.exec(
    url.pathname,
  );
  const finalDraftMatch = /^\/v1\/capture-tasks\/([^/]+)\/final-draft$/.exec(
    url.pathname,
  );
  const match = aiDraftMatch ?? adjustMatch ?? retryMatch ?? finalDraftMatch;
  if (!match) return null;

  const taskId = parseTaskId(match[1]);
  if (!taskId) {
    return errorResponse(requestId, 400, 'invalid_task_id', 'Invalid CaptureTask id');
  }
  if (!(await taskOwnedByDevice(env, taskId, device.id))) {
    return errorResponse(requestId, 404, 'task_not_found', 'CaptureTask not found');
  }

  if (aiDraftMatch && request.method === 'GET') {
    return getAiDraft(env, taskId, requestId);
  }
  if (adjustMatch && request.method === 'POST') {
    return adjustAiDraft(request, env, taskId, requestId);
  }
  if (retryMatch && request.method === 'POST') {
    return retryOrganize(env, taskId, requestId);
  }
  if (finalDraftMatch && request.method === 'PUT') {
    return saveFinalDraft(request, env, taskId, requestId);
  }
  if (finalDraftMatch && request.method === 'GET') {
    return getFinalDraft(env, taskId, requestId);
  }

  return errorResponse(
    requestId,
    405,
    'method_not_allowed',
    'Method not allowed',
    false,
    taskId,
  );
}
