import assert from 'node:assert/strict';
import test from 'node:test';
import {
  handleMob020Request,
  runMob020Organize,
  type Mob020Env,
} from '../src/api/mob020';
import type { LlmOutcome, OrganizeSuccess } from '../src/shared/llm';

const TASK_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_DEVICE_TASK_ID = '33333333-3333-4333-8333-333333333333';
const DEVICE_ID = 'device-1';
const OTHER_DEVICE_ID = 'device-2';
const NOW = '2026-08-29T03:00:00.000Z';

const TRANSCRIPT_TEXT = '今天会议讨论了灰度计划。';
const TRANSCRIPT_LANGUAGE = 'zh';

type StageState = {
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped';
  retryable: number;
  retry_count: number;
  error_code: string | null;
  error_message: string | null;
};

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

type SceneRecord = {
  id: string;
  device_id: string;
  user_id: string | null;
  name: string;
  instruction: string;
  sections_json: string;
  created_at: string;
  updated_at: string;
};

class FakeStatement {
  values: unknown[] = [];

  constructor(
    readonly db: FakeDb,
    readonly sql: string,
  ) {}

  bind(...values: unknown[]): FakeStatement {
    this.values = values;
    return this;
  }

  async first<T>(): Promise<T | null> {
    return this.db.first(this.sql, this.values) as T | null;
  }

  async run(): Promise<{ success: boolean }> {
    this.db.run(this.sql, this.values);
    return { success: true };
  }

  async all<T>(): Promise<{ success: boolean; results?: T[] }> {
    return { success: true, results: this.db.all(this.sql, this.values) as T[] };
  }
}

class FakeDb {
  readonly statements: Array<{ sql: string; values: unknown[] }> = [];
  readonly tasks = new Map<
    string,
    {
      id: string;
      device_id: string;
      title: string;
      scene_id: string;
      lifecycle_status: string;
      current_stage: string;
    }
  >();
  readonly stages = new Map<string, StageState>();
  readonly drafts: DraftRow[] = [];
  readonly scenes = new Map<string, SceneRecord>();
  transcript: { task_id: string; text: string; language: string | null } | null = null;
  failNextDraftInsert = false;

  constructor() {
    this.tasks.set(TASK_ID, {
      id: TASK_ID,
      device_id: DEVICE_ID,
      title: '周会',
      scene_id: 'meeting',
      lifecycle_status: 'active',
      current_stage: 'organize',
    });
    this.tasks.set(OTHER_DEVICE_TASK_ID, {
      id: OTHER_DEVICE_TASK_ID,
      device_id: OTHER_DEVICE_ID,
      title: '别人家的会',
      scene_id: 'meeting',
      lifecycle_status: 'active',
      current_stage: 'organize',
    });
    this.transcript = {
      task_id: TASK_ID,
      text: TRANSCRIPT_TEXT,
      language: TRANSCRIPT_LANGUAGE,
    };
  }

  prepare(sql: string): FakeStatement {
    return new FakeStatement(this, sql);
  }

  async batch(statements: FakeStatement[]): Promise<Array<{ success: boolean }>> {
    for (const statement of statements) {
      this.run(statement.sql, statement.values);
    }
    return statements.map(() => ({ success: true }));
  }

  first(sql: string, values: unknown[]): unknown {
    if (sql.includes('FROM capture_tasks') && sql.includes('device_id = ?')) {
      const [taskId, deviceId] = values as [string, string];
      const task = this.tasks.get(taskId);
      return task && task.device_id === deviceId ? { id: taskId } : null;
    }

    if (sql.includes('FROM capture_tasks')) {
      const task = this.tasks.get(values[0] as string);
      return task
        ? {
            id: task.id,
            device_id: task.device_id,
            title: task.title,
            scene_id: task.scene_id,
          }
        : null;
    }

    if (sql.includes('FROM transcripts')) {
      if (!this.transcript || this.transcript.task_id !== values[0]) return null;
      return { text: this.transcript.text, language: this.transcript.language };
    }

    if (sql.includes('FROM drafts') && sql.includes("kind = 'ai'") && sql.includes('version = ?')) {
      const [taskId, version] = values as [string, number];
      const found = this.drafts.find(
        (draft) => draft.task_id === taskId && draft.version === version,
      );
      return found ? { ...found } : null;
    }

    if (sql.includes('FROM drafts') && sql.includes("kind = 'final'")) {
      const taskId = values[0] as string;
      const found = this.drafts.find(
        (draft) => draft.task_id === taskId && draft.kind === 'final',
      );
      return found ? { ...found } : null;
    }

    if (sql.includes('FROM drafts') && sql.includes("kind = 'ai'")) {
      const taskId = values[0] as string;
      const latest = this.drafts
        .filter((draft) => draft.task_id === taskId)
        .sort((a, b) => b.version - a.version)[0];
      return latest ? { ...latest } : null;
    }

    if (sql.includes('FROM drafts') && sql.includes('idempotency_key = ?')) {
      const [taskId, key] = values as [string, string];
      const found = this.drafts.find(
        (draft) => draft.task_id === taskId && draft.idempotency_key === key,
      );
      return found ? { ...found } : null;
    }

    if (sql.includes('FROM capture_stages') && sql.includes("stage = 'organize'")) {
      const stage = this.stages.get('organize');
      return stage ? { ...stage } : null;
    }

    if (sql.includes('FROM scenes') && sql.includes('id = ?')) {
      const [deviceId, sceneId] = values as [string, string];
      const scene = this.scenes.get(`${deviceId}:${sceneId}`);
      return scene ? { ...scene } : null;
    }

    return null;
  }

  all(sql: string, values: unknown[]): unknown[] {
    if (sql.includes('FROM scenes')) {
      const deviceId = values[0] as string;
      return [...this.scenes.values()].filter(
        (scene) => scene.device_id === deviceId,
      );
    }
    return [];
  }

  run(sql: string, values: unknown[]): void {
    this.statements.push({ sql, values: [...values] });

    if (sql.startsWith('INSERT OR IGNORE INTO drafts') || sql.startsWith('INSERT INTO drafts')) {
      if (sql.includes('ON CONFLICT')) {
        // Final Draft upsert: single working state at version 1.
        const existing = this.drafts.find(
          (draft) => draft.task_id === values[1] && draft.kind === 'final',
        );
        if (existing) {
          Object.assign(existing, {
            base_version: values[2] as number,
            title: values[3] as string,
            markdown: values[4] as string,
            structured_json: values[5] as string | null,
            correlation_id: values[7] as string,
            confirmed_at: values[8] as string,
            updated_at: values[10] as string,
          });
        } else {
          this.drafts.push({
            id: values[0] as string,
            task_id: values[1] as string,
            kind: 'final',
            version: 1,
            source: 'user-edit',
            base_version: values[2] as number,
            instruction: null,
            idempotency_key: null,
            title: values[3] as string,
            markdown: values[4] as string,
            structured_json: (values[5] as string | null) ?? null,
            scene_id: values[6] as string,
            provider: null,
            model: null,
            latency_ms: null,
            prompt_tokens: null,
            completion_tokens: null,
            total_tokens: null,
            provider_request_id: null,
            fallback_used: 0,
            correlation_id: values[7] as string,
            confirmed_at: values[8] as string,
            created_at: values[9] as string,
            updated_at: values[10] as string,
          });
        }
        return;
      }

      const draft: DraftRow = {
        id: values[0] as string,
        task_id: values[1] as string,
        kind: 'ai',
        version: values[2] as number,
        source: values[3] as 'organize' | 'adjust',
        base_version: (values[4] as number | null) ?? null,
        instruction: (values[5] as string | null) ?? null,
        idempotency_key: (values[6] as string | null) ?? null,
        title: null,
        markdown: values[7] as string,
        structured_json: values[8] as string,
        scene_id: values[9] as string,
        provider: values[10] as string,
        model: values[11] as string,
        latency_ms: values[12] as number,
        prompt_tokens: (values[13] as number | null) ?? null,
        completion_tokens: (values[14] as number | null) ?? null,
        total_tokens: (values[15] as number | null) ?? null,
        provider_request_id: (values[16] as string | null) ?? null,
        fallback_used: values[17] as number,
        correlation_id: values[18] as string,
        confirmed_at: null,
        created_at: values[19] as string,
        updated_at: values[20] as string,
      };
      const exists = this.drafts.some(
        (candidate) =>
          candidate.task_id === draft.task_id &&
          candidate.kind === 'ai' &&
          candidate.version === draft.version,
      );
      if (exists) {
        if (sql.startsWith('INSERT OR IGNORE')) return;
        throw new Error('UNIQUE constraint failed: drafts.task_id, drafts.kind, drafts.version');
      }
      if (this.failNextDraftInsert) {
        this.failNextDraftInsert = false;
        throw new Error('UNIQUE constraint failed: drafts.task_id, drafts.kind, drafts.version');
      }
      this.drafts.push(draft);
      return;
    }

    if (sql.startsWith('INSERT INTO scenes')) {
      const scene: SceneRecord = {
        id: values[0] as string,
        device_id: values[1] as string,
        user_id: (values[2] as string | null) ?? null,
        name: values[3] as string,
        instruction: values[4] as string,
        sections_json: values[5] as string,
        created_at: values[6] as string,
        updated_at: values[7] as string,
      };
      this.scenes.set(`${scene.device_id}:${scene.id}`, scene);
      return;
    }

    if (sql.includes('INSERT OR IGNORE INTO capture_stages')) {
      const hardcodedStage = /VALUES\s*\(\?,\s*'([^']+)'/u.exec(sql)?.[1];
      const stage = hardcodedStage ?? (values[1] as string);
      if (!this.stages.has(stage)) {
        this.stages.set(stage, {
          status: 'pending',
          retryable: 1,
          retry_count: 0,
          error_code: null,
          error_message: null,
        });
      }
      return;
    }

    if (sql.includes('UPDATE capture_stages')) {
      const hardcodedStage = /stage\s*=\s*'([^']+)'/u.exec(sql)?.[1];
      const stage = hardcodedStage ?? (values.at(-1) as string);
      const previous = this.stages.get(stage);
      if (sql.includes("SET status = 'failed'")) {
        this.stages.set(stage, {
          status: 'failed',
          retryable: values[0] as number,
          retry_count: previous?.retry_count ?? 0,
          error_code: values[1] as string,
          error_message: values[2] as string,
        });
      } else if (sql.includes("SET status = 'pending'")) {
        this.stages.set(stage, {
          status: 'pending',
          retryable: 1,
          retry_count: values[0] as number,
          error_code: null,
          error_message: null,
        });
      } else if (sql.includes("SET status = 'running'")) {
        this.stages.set(stage, {
          status: 'running',
          retryable: 1,
          retry_count: previous?.retry_count ?? 0,
          error_code: null,
          error_message: null,
        });
      } else if (sql.includes("SET status = 'succeeded'")) {
        this.stages.set(stage, {
          status: 'succeeded',
          retryable: 0,
          retry_count: previous?.retry_count ?? 0,
          error_code: null,
          error_message: null,
        });
      }
      return;
    }

    if (sql.includes('UPDATE capture_tasks')) {
      const taskId = values.at(-1) as string;
      const task = this.tasks.get(taskId);
      if (!task) return;
      if (sql.includes("lifecycle_status = 'ready'") && task.lifecycle_status === 'active') {
        task.lifecycle_status = 'ready';
      }
      const currentStage = /current_stage = '([a-z-]+)'/u.exec(sql);
      if (currentStage) task.current_stage = currentStage[1];
    }
  }
}

const organizeSuccess = (overrides: Partial<OrganizeSuccess> = {}): LlmOutcome => ({
  ok: true,
  value: {
    markdown: '# 周会\n\n## 摘要\n\n团队对齐了灰度计划。\n',
    structured: {
      summary: '团队对齐了灰度计划。',
      sections: [
        { id: 'decisions', items: ['灰度从 10% 流量开始'] },
        { id: 'todos', items: ['张三补充监控告警'] },
        { id: 'risks', items: [] },
        { id: 'open-questions', items: [] },
      ],
    },
    provider: 'deepseek',
    model: 'deepseek-chat',
    latencyMs: 1200,
    usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
    providerRequestId: 'chatcmpl-1',
    fallbackUsed: false,
    ...overrides,
  },
});

const llmFailure = (
  kind: 'retryable' | 'terminal',
  code: string,
  message = `${code} happened`,
): LlmOutcome => ({ ok: false, error: { kind, code, message } });

type LlmCall = { kind: 'generateStructured' | 'adjustDraft'; input: Record<string, unknown> };

const makeEnv = (options: {
  organize?: () => LlmOutcome;
  organizeThrows?: boolean;
  adjust?: () => LlmOutcome;
  adjustThrows?: boolean;
  sceneId?: string;
  noTranscript?: boolean;
  workflowFails?: boolean;
} = {}) => {
  const db = new FakeDb();
  if (options.sceneId) db.tasks.get(TASK_ID)!.scene_id = options.sceneId;
  if (options.noTranscript) db.transcript = null;

  const llmCalls: LlmCall[] = [];
  const workflowCreates: Array<{ id?: string; params?: Record<string, unknown> }> = [];

  const env = {
    DB: db,
    LLM: {
      async generateStructured(input: Record<string, unknown>): Promise<LlmOutcome> {
        llmCalls.push({ kind: 'generateStructured', input });
        if (options.organizeThrows) throw new Error('rpc exploded');
        return (options.organize ?? (() => organizeSuccess()))();
      },
      async adjustDraft(input: Record<string, unknown>): Promise<LlmOutcome> {
        llmCalls.push({ kind: 'adjustDraft', input });
        if (options.adjustThrows) throw new Error('rpc exploded');
        return (options.adjust ?? (() => organizeSuccess({ provider: 'moonshot', fallbackUsed: true })))();
      },
    },
    CAPTURE_WORKFLOW: {
      async create(input?: { id?: string; params?: Record<string, unknown> }) {
        if (options.workflowFails) throw new Error('workflow start failed');
        workflowCreates.push(input ?? {});
        return {};
      },
      async get() {
        if (options.workflowFails) throw new Error('workflow not found');
        return {};
      },
    },
  } as unknown as Mob020Env;

  return { env, db, llmCalls, workflowCreates };
};

const step = {
  async do<T>(_name: string, callback: () => Promise<T>): Promise<T> {
    return callback();
  },
};

const request = (path: string, init?: RequestInit): Request =>
  new Request(`https://example.test${path}`, init);

test('Workflow organizes the transcript into a versioned AI draft and marks the task ready', async () => {
  const { env, db, llmCalls } = makeEnv();

  const result = await runMob020Organize(env, { taskId: TASK_ID, requestId: 'req-1' }, step);

  assert.equal(result.ok, true);
  assert.equal(db.drafts.length, 1);
  const draft = db.drafts[0];
  assert.equal(draft.version, 1);
  assert.equal(draft.source, 'organize');
  assert.equal(draft.scene_id, 'meeting');
  assert.equal(draft.provider, 'deepseek');
  assert.equal(draft.model, 'deepseek-chat');
  assert.equal(draft.latency_ms, 1200);
  assert.equal(draft.total_tokens, 150);
  assert.equal(draft.fallback_used, 0);
  assert.equal(draft.correlation_id, 'req-1');
  assert.equal(draft.instruction, null);
  assert.equal(draft.idempotency_key, null);
  assert.equal(db.stages.get('organize')?.status, 'succeeded');
  assert.equal(db.stages.get('persist-ai-draft')?.status, 'succeeded');
  assert.equal(db.tasks.get(TASK_ID)?.lifecycle_status, 'ready');
  assert.equal(db.tasks.get(TASK_ID)?.current_stage, 'persist-ai-draft');

  assert.equal(llmCalls.length, 1);
  assert.equal(llmCalls[0].kind, 'generateStructured');
  assert.equal(llmCalls[0].input.transcriptText, TRANSCRIPT_TEXT);
  assert.equal(llmCalls[0].input.language, TRANSCRIPT_LANGUAGE);
  assert.equal((llmCalls[0].input.scene as { id: string }).id, 'meeting');
  assert.equal(llmCalls[0].input.title, '周会');
  assert.equal(llmCalls[0].input.correlationId, 'req-1');

  // The Transcript evidence layer is never rewritten by organize.
  assert.equal(
    db.statements.some(({ sql }) => sql.includes('INSERT INTO transcripts') || sql.includes('UPDATE transcripts')),
    false,
  );
});

test('Replaying persist-ai-draft keeps the original draft version', async () => {
  const { env, db } = makeEnv();

  await runMob020Organize(env, { taskId: TASK_ID, requestId: 'req-1' }, step);
  await runMob020Organize(env, { taskId: TASK_ID, requestId: 'req-2' }, step);

  assert.equal(db.drafts.length, 1);
  assert.equal(db.drafts[0].version, 1);
  assert.equal(db.drafts[0].correlation_id, 'req-1');
  assert.equal(db.stages.get('persist-ai-draft')?.status, 'succeeded');
});

test('Terminal LLM failures fail only the organize stage without touching the Transcript', async () => {
  const { env, db, llmCalls } = makeEnv({
    organize: () => llmFailure('terminal', 'invalid_response', 'structured output failed validation'),
  });

  const result = await runMob020Organize(env, { taskId: TASK_ID }, step);

  assert.equal(result.ok, false);
  assert.equal(db.drafts.length, 0);
  assert.equal(db.stages.get('organize')?.status, 'failed');
  assert.equal(db.stages.get('organize')?.retryable, 0);
  assert.equal(db.stages.get('organize')?.error_code, 'invalid_response');
  assert.equal(db.stages.get('persist-ai-draft'), undefined);
  assert.equal(db.tasks.get(TASK_ID)?.lifecycle_status, 'active');
  assert.equal(db.transcript?.text, TRANSCRIPT_TEXT);
  assert.equal(llmCalls.length, 1);
});

test('Retryable LLM failures keep the organize stage retryable', async () => {
  const { env, db } = makeEnv({
    organize: () => llmFailure('retryable', 'rate_limited'),
  });

  await runMob020Organize(env, { taskId: TASK_ID }, step);

  assert.equal(db.stages.get('organize')?.status, 'failed');
  assert.equal(db.stages.get('organize')?.retryable, 1);
  assert.equal(db.stages.get('organize')?.error_code, 'rate_limited');
  assert.equal(db.drafts.length, 0);
});

test('A crashing LLM binding surfaces as a retryable service failure', async () => {
  const { env, db } = makeEnv({ organizeThrows: true });

  await runMob020Organize(env, { taskId: TASK_ID }, step);

  assert.equal(db.stages.get('organize')?.status, 'failed');
  assert.equal(db.stages.get('organize')?.retryable, 1);
  assert.equal(db.stages.get('organize')?.error_code, 'llm_service_unavailable');
});

test('Unknown scenes fail organize terminally with a diagnosable error', async () => {
  const { env, db } = makeEnv({ sceneId: 'does-not-exist' });

  await runMob020Organize(env, { taskId: TASK_ID }, step);

  assert.equal(db.stages.get('organize')?.status, 'failed');
  assert.equal(db.stages.get('organize')?.retryable, 0);
  assert.equal(db.stages.get('organize')?.error_code, 'scene_not_found');
});

test('Custom scenes reach the LLM with only their allowed fields', async () => {
  const { env, db, llmCalls } = makeEnv({ sceneId: 'standup' });
  db.scenes.set(`${DEVICE_ID}:standup`, {
    id: 'standup',
    device_id: DEVICE_ID,
    user_id: null,
    name: '每日站会',
    instruction: '整理站会内容：昨天、今天、阻塞。',
    sections_json: JSON.stringify([
      { id: 'yesterday', title: '昨天', description: '昨天完成的工作' },
      { id: 'today', title: '今天', description: '今天计划的工作' },
      { id: 'blockers', title: '阻塞', description: '当前阻塞' },
    ]),
    created_at: NOW,
    updated_at: NOW,
  });

  await runMob020Organize(env, { taskId: TASK_ID, requestId: 'req-1' }, step);

  const scene = llmCalls[0].input.scene as {
    id: string;
    name: string;
    instruction: string;
    sections: Array<{ id: string }>;
  };
  assert.equal(scene.id, 'standup');
  assert.equal(scene.name, '每日站会');
  assert.deepEqual(
    scene.sections.map((section) => section.id),
    ['yesterday', 'today', 'blockers'],
  );
  assert.equal(db.stages.get('organize')?.status, 'succeeded');
});

test('Organize retry endpoint restarts the workflow without re-running STT', async () => {
  const { env, db, workflowCreates } = makeEnv();
  db.stages.set('organize', {
    status: 'failed',
    retryable: 1,
    retry_count: 0,
    error_code: 'rate_limited',
    error_message: 'rate limited',
  });

  const retry = await handleMob020Request(
    request(`/v1/capture-tasks/${TASK_ID}/organize/retry`, { method: 'POST' }),
    env,
    { id: DEVICE_ID },
    'request-retry',
  );

  assert.equal(retry?.status, 200);
  const body = (await retry?.json()) as { data: { retryCount: number } };
  assert.equal(body.data.retryCount, 1);
  assert.equal(db.stages.get('organize')?.status, 'pending');
  assert.equal(db.stages.get('organize')?.retry_count, 1);
  assert.equal(workflowCreates.length, 1);
  assert.equal(workflowCreates[0].id, `capture-${TASK_ID}-organize-1`);
  assert.equal(workflowCreates[0].params?.startStage, 'organize');
  // A successful retry already proves a persisted Transcript was available;
// separately assert that retry preserves that evidence and never restarts STT.
assert.equal(db.transcript?.text, TRANSCRIPT_TEXT);
  assert.equal(
    db.statements.some(({ sql }) => sql.includes("SET status = 'running'") && sql.includes('transcribe')),
    false,
  );
});

test('Organize retry endpoint guards invalid stage states', async () => {
  const noTranscript = makeEnv({ noTranscript: true });
  const missingTranscript = await handleMob020Request(
    request(`/v1/capture-tasks/${TASK_ID}/organize/retry`, { method: 'POST' }),
    noTranscript.env,
    { id: DEVICE_ID },
    'request-1',
  );
  assert.equal(missingTranscript?.status, 409);
  const missingTranscriptBody = (await missingTranscript?.json()) as {
    error: { code: string };
  };
  assert.equal(missingTranscriptBody.error.code, 'organize_retry_requires_transcript');

  const succeededEnv = makeEnv();
  succeededEnv.db.stages.set('organize', {
    status: 'succeeded',
    retryable: 0,
    retry_count: 0,
    error_code: null,
    error_message: null,
  });
  const succeeded = await handleMob020Request(
    request(`/v1/capture-tasks/${TASK_ID}/organize/retry`, { method: 'POST' }),
    succeededEnv.env,
    { id: DEVICE_ID },
    'request-2',
  );
  assert.equal(succeeded?.status, 409);
  const succeededBody = (await succeeded?.json()) as { error: { code: string } };
  assert.equal(succeededBody.error.code, 'organize_already_succeeded');

  const notStarted = makeEnv();
  const fresh = await handleMob020Request(
    request(`/v1/capture-tasks/${TASK_ID}/organize/retry`, { method: 'POST' }),
    notStarted.env,
    { id: DEVICE_ID },
    'request-3',
  );
  assert.equal(fresh?.status, 409);
  const freshBody = (await fresh?.json()) as { error: { code: string } };
  assert.equal(freshBody.error.code, 'organize_not_started');

  const workflowFail = makeEnv({ workflowFails: true });
  workflowFail.db.stages.set('organize', {
    status: 'failed',
    retryable: 1,
    retry_count: 0,
    error_code: 'rate_limited',
    error_message: 'rate limited',
  });
  const failed = await handleMob020Request(
    request(`/v1/capture-tasks/${TASK_ID}/organize/retry`, { method: 'POST' }),
    workflowFail.env,
    { id: DEVICE_ID },
    'request-4',
  );
  assert.equal(failed?.status, 503);
  const failedBody = (await failed?.json()) as { error: { code: string } };
  assert.equal(failedBody.error.code, 'workflow_start_failed');
  assert.equal(workflowFail.db.stages.get('organize')?.status, 'failed');
  assert.equal(workflowFail.db.stages.get('organize')?.error_code, 'workflow_start_failed');
});

test('AI draft endpoint returns 404 before organize and the draft afterwards', async () => {
  const { env, db } = makeEnv();

  const before = await handleMob020Request(
    request(`/v1/capture-tasks/${TASK_ID}/ai-draft`),
    env,
    { id: DEVICE_ID },
    'request-1',
  );
  assert.equal(before?.status, 404);
  const beforeBody = (await before?.json()) as { error: { code: string } };
  assert.equal(beforeBody.error.code, 'ai_draft_not_ready');

  await runMob020Organize(env, { taskId: TASK_ID, requestId: 'req-1' }, step);

  const after = await handleMob020Request(
    request(`/v1/capture-tasks/${TASK_ID}/ai-draft`),
    env,
    { id: DEVICE_ID },
    'request-2',
  );
  assert.equal(after?.status, 200);
  const afterBody = (await after?.json()) as {
    data: { draft: { version: number; provider: string; markdown: string } };
  };
  assert.equal(afterBody.data.draft.version, 1);
  assert.equal(afterBody.data.draft.provider, 'deepseek');
  assert.equal(afterBody.data.draft.markdown, db.drafts[0].markdown);

  const foreign = await handleMob020Request(
    request(`/v1/capture-tasks/${OTHER_DEVICE_TASK_ID}/ai-draft`),
    env,
    { id: DEVICE_ID },
    'request-3',
  );
  assert.equal(foreign?.status, 404);
  const foreignBody = (await foreign?.json()) as { error: { code: string } };
  assert.equal(foreignBody.error.code, 'task_not_found');
});

test('AI adjust appends new versions and never rewrites the Transcript', async () => {
  const { env, db, llmCalls } = makeEnv();
  await runMob020Organize(env, { taskId: TASK_ID, requestId: 'req-1' }, step);
  const transcriptWritesBefore = db.statements.filter(({ sql }) =>
    sql.includes('transcripts'),
  ).length;

  const first = await handleMob020Request(
    request(`/v1/capture-tasks/${TASK_ID}/ai-draft/adjust`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ instruction: '把待办写得更具体', idempotencyKey: 'adj-1' }),
    }),
    env,
    { id: DEVICE_ID },
    'request-adj-1',
  );
  assert.equal(first?.status, 200);
  const firstBody = (await first?.json()) as {
    data: { draft: { version: number; source: string; baseVersion: number; instruction: string } };
  };
  assert.equal(firstBody.data.draft.version, 2);
  assert.equal(firstBody.data.draft.source, 'adjust');
  assert.equal(firstBody.data.draft.baseVersion, 1);
  assert.equal(firstBody.data.draft.instruction, '把待办写得更具体');

  assert.equal(llmCalls.length, 2);
  assert.equal(llmCalls[1].kind, 'adjustDraft');
  assert.equal(llmCalls[1].input.instruction, '把待办写得更具体');
  const currentDraft = llmCalls[1].input.currentDraft as {
    structured: { summary: string };
    markdown: string;
  };
  assert.equal(currentDraft.structured.summary, '团队对齐了灰度计划。');

  const second = await handleMob020Request(
    request(`/v1/capture-tasks/${TASK_ID}/ai-draft/adjust`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ instruction: '风险一节合并到待确认', idempotencyKey: 'adj-2' }),
    }),
    env,
    { id: DEVICE_ID },
    'request-adj-2',
  );
  assert.equal(second?.status, 200);
  const secondBody = (await second?.json()) as { data: { draft: { version: number } } };
  assert.equal(secondBody.data.draft.version, 3);
  assert.equal(db.drafts.length, 3);
  assert.equal(db.tasks.get(TASK_ID)?.lifecycle_status, 'ready');

  // Two consecutive adjustments never touched the Transcript.
  assert.equal(db.transcript?.text, TRANSCRIPT_TEXT);
  assert.equal(
    db.statements.filter(({ sql }) => sql.includes('transcripts')).length,
    transcriptWritesBefore,
  );
});

test('AI adjust replays idempotency keys and rejects key reuse with new instructions', async () => {
  const { env, db, llmCalls } = makeEnv();
  await runMob020Organize(env, { taskId: TASK_ID, requestId: 'req-1' }, step);

  const payload = JSON.stringify({ instruction: '把待办写得更具体', idempotencyKey: 'adj-1' });
  const first = await handleMob020Request(
    request(`/v1/capture-tasks/${TASK_ID}/ai-draft/adjust`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: payload,
    }),
    env,
    { id: DEVICE_ID },
    'request-adj-1',
  );
  assert.equal(first?.status, 200);

  const replay = await handleMob020Request(
    request(`/v1/capture-tasks/${TASK_ID}/ai-draft/adjust`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: payload,
    }),
    env,
    { id: DEVICE_ID },
    'request-adj-replay',
  );
  assert.equal(replay?.status, 200);
  const replayBody = (await replay?.json()) as { data: { draft: { version: number } } };
  assert.equal(replayBody.data.draft.version, 2);
  assert.equal(db.drafts.length, 2);
  assert.equal(llmCalls.length, 2);

  const conflict = await handleMob020Request(
    request(`/v1/capture-tasks/${TASK_ID}/ai-draft/adjust`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ instruction: '完全不同的指令', idempotencyKey: 'adj-1' }),
    }),
    env,
    { id: DEVICE_ID },
    'request-adj-conflict',
  );
  assert.equal(conflict?.status, 409);
  const conflictBody = (await conflict?.json()) as { error: { code: string } };
  assert.equal(conflictBody.error.code, 'idempotency_content_conflict');
});

test('AI adjust guards missing drafts, invalid bodies, provider and version failures', async () => {
  const noDraft = makeEnv();
  const noDraftResponse = await handleMob020Request(
    request(`/v1/capture-tasks/${TASK_ID}/ai-draft/adjust`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ instruction: 'x', idempotencyKey: 'k' }),
    }),
    noDraft.env,
    { id: DEVICE_ID },
    'request-1',
  );
  assert.equal(noDraftResponse?.status, 409);
  const noDraftBody = (await noDraftResponse?.json()) as { error: { code: string } };
  assert.equal(noDraftBody.error.code, 'ai_draft_not_ready');

  const invalidBody = makeEnv();
  const invalid = await handleMob020Request(
    request(`/v1/capture-tasks/${TASK_ID}/ai-draft/adjust`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ idempotencyKey: 'k' }),
    }),
    invalidBody.env,
    { id: DEVICE_ID },
    'request-2',
  );
  assert.equal(invalid?.status, 400);

  const { env, db } = makeEnv();
  await runMob020Organize(env, { taskId: TASK_ID, requestId: 'req-1' }, step);

  env.LLM.adjustDraft = async () => llmFailure('terminal', 'invalid_response');
  const terminal = await handleMob020Request(
    request(`/v1/capture-tasks/${TASK_ID}/ai-draft/adjust`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ instruction: 'x', idempotencyKey: 'adj-t' }),
    }),
    env,
    { id: DEVICE_ID },
    'request-3',
  );
  assert.equal(terminal?.status, 409);
  const terminalBody = (await terminal?.json()) as { error: { code: string; retryable: boolean } };
  assert.equal(terminalBody.error.code, 'invalid_response');
  assert.equal(terminalBody.error.retryable, false);
  assert.equal(db.drafts.length, 1);

  env.LLM.adjustDraft = async () => llmFailure('retryable', 'rate_limited');
  const retryable = await handleMob020Request(
    request(`/v1/capture-tasks/${TASK_ID}/ai-draft/adjust`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ instruction: 'x', idempotencyKey: 'adj-r' }),
    }),
    env,
    { id: DEVICE_ID },
    'request-4',
  );
  assert.equal(retryable?.status, 502);
  const retryableBody = (await retryable?.json()) as { error: { code: string; retryable: boolean } };
  assert.equal(retryableBody.error.code, 'rate_limited');
  assert.equal(retryableBody.error.retryable, true);

  env.LLM.adjustDraft = async () => {
    throw new Error('rpc exploded');
  };
  const crashed = await handleMob020Request(
    request(`/v1/capture-tasks/${TASK_ID}/ai-draft/adjust`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ instruction: 'x', idempotencyKey: 'adj-c' }),
    }),
    env,
    { id: DEVICE_ID },
    'request-5',
  );
  assert.equal(crashed?.status, 502);
  const crashedBody = (await crashed?.json()) as { error: { code: string } };
  assert.equal(crashedBody.error.code, 'llm_service_unavailable');

  env.LLM.adjustDraft = async () => organizeSuccess();
  db.failNextDraftInsert = true;
  const conflicting = await handleMob020Request(
    request(`/v1/capture-tasks/${TASK_ID}/ai-draft/adjust`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ instruction: 'x', idempotencyKey: 'adj-v' }),
    }),
    env,
    { id: DEVICE_ID },
    'request-6',
  );
  assert.equal(conflicting?.status, 409);
  const conflictingBody = (await conflicting?.json()) as { error: { code: string; retryable: boolean } };
  assert.equal(conflictingBody.error.code, 'draft_version_conflict');
  assert.equal(conflictingBody.error.retryable, true);
});

test('Scene endpoints register custom scenes and keep built-ins first', async () => {
  const { env } = makeEnv();

  const create = await handleMob020Request(
    request('/v1/scenes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: 'standup',
        name: '每日站会',
        instruction: '整理站会内容：昨天、今天、阻塞。',
        sections: [
          { id: 'yesterday', title: '昨天', description: '昨天完成的工作' },
          { id: 'today', title: '今天', description: '今天计划的工作' },
          { id: 'blockers', title: '阻塞', description: '当前阻塞' },
        ],
      }),
    }),
    env,
    { id: DEVICE_ID },
    'request-scene-1',
  );
  assert.equal(create?.status, 201);
  const createBody = (await create?.json()) as {
    data: { scene: { id: string; builtIn: boolean; sections: Array<{ id: string }> } };
  };
  assert.equal(createBody.data.scene.id, 'standup');
  assert.equal(createBody.data.scene.builtIn, false);
  assert.equal(createBody.data.scene.sections.length, 3);

  const list = await handleMob020Request(
    request('/v1/scenes'),
    env,
    { id: DEVICE_ID },
    'request-scene-2',
  );
  assert.equal(list?.status, 200);
  const listBody = (await list?.json()) as {
    data: { scenes: Array<{ id: string; builtIn: boolean }> };
  };
  assert.deepEqual(
    listBody.data.scenes.map((scene) => scene.id),
    ['meeting', 'quick-note', 'reflection', 'standup'],
  );
  assert.equal(listBody.data.scenes[0].builtIn, true);
  assert.equal(listBody.data.scenes[3].builtIn, false);

  const foreignList = await handleMob020Request(
    request('/v1/scenes'),
    env,
    { id: OTHER_DEVICE_ID },
    'request-scene-3',
  );
  const foreignBody = (await foreignList?.json()) as {
    data: { scenes: Array<{ id: string }> };
  };
  assert.deepEqual(
    foreignBody.data.scenes.map((scene) => scene.id),
    ['meeting', 'quick-note', 'reflection'],
  );
});

test('Scene registration validates ids, reserved names and structure', async () => {
  const { env } = makeEnv();

  const reserved = await handleMob020Request(
    request('/v1/scenes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: 'meeting',
        name: 'x',
        instruction: 'y',
        sections: [{ id: 'a', title: 'A', description: '' }],
      }),
    }),
    env,
    { id: DEVICE_ID },
    'request-1',
  );
  assert.equal(reserved?.status, 400);
  const reservedBody = (await reserved?.json()) as { error: { code: string } };
  assert.equal(reservedBody.error.code, 'reserved_scene_id');

  const badId = await handleMob020Request(
    request('/v1/scenes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: 'Bad Id',
        name: 'x',
        instruction: 'y',
        sections: [{ id: 'a', title: 'A', description: '' }],
      }),
    }),
    env,
    { id: DEVICE_ID },
    'request-2',
  );
  assert.equal(badId?.status, 400);
  const badIdBody = (await badId?.json()) as { error: { code: string } };
  assert.equal(badIdBody.error.code, 'invalid_scene_id');

  const badSections = await handleMob020Request(
    request('/v1/scenes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: 'standup',
        name: '每日站会',
        instruction: '整理站会内容。',
        sections: [{ id: '1-bad', title: 'A', description: '' }],
      }),
    }),
    env,
    { id: DEVICE_ID },
    'request-3',
  );
  assert.equal(badSections?.status, 400);
  const badSectionsBody = (await badSections?.json()) as { error: { code: string; message: string } };
  assert.equal(badSectionsBody.error.code, 'invalid_request');
  assert.match(badSectionsBody.error.message, /sections\[0\]\.id/u);
});

test('Scene registration is idempotent per device and rejects content drift', async () => {
  const { env } = makeEnv();
  const payload = {
    id: 'standup',
    name: '每日站会',
    instruction: '整理站会内容：昨天、今天、阻塞。',
    sections: [{ id: 'today', title: '今天', description: '今天计划的工作' }],
  };

  const first = await handleMob020Request(
    request('/v1/scenes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    }),
    env,
    { id: DEVICE_ID },
    'request-1',
  );
  assert.equal(first?.status, 201);

  const replay = await handleMob020Request(
    request('/v1/scenes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    }),
    env,
    { id: DEVICE_ID },
    'request-2',
  );
  assert.equal(replay?.status, 200);

  const conflict = await handleMob020Request(
    request('/v1/scenes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...payload, name: '改名后的站会' }),
    }),
    env,
    { id: DEVICE_ID },
    'request-3',
  );
  assert.equal(conflict?.status, 409);
  const conflictBody = (await conflict?.json()) as { error: { code: string } };
  assert.equal(conflictBody.error.code, 'scene_id_conflict');
});

test('Final Draft save requires an AI draft and upserts a single working state', async () => {
  const { env, db } = makeEnv();

  const tooEarly = await handleMob020Request(
    request(`/v1/capture-tasks/${TASK_ID}/final-draft`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ markdown: '# 人工稿' }),
    }),
    env,
    { id: DEVICE_ID },
    'request-early',
  );
  assert.equal(tooEarly?.status, 409);
  const tooEarlyBody = (await tooEarly?.json()) as { error: { code: string } };
  assert.equal(tooEarlyBody.error.code, 'final_draft_requires_ai_draft');

  await runMob020Organize(env, { taskId: TASK_ID, requestId: 'req-1' }, step);

  const notSaved = await handleMob020Request(
    request(`/v1/capture-tasks/${TASK_ID}/final-draft`),
    env,
    { id: DEVICE_ID },
    'request-get-1',
  );
  assert.equal(notSaved?.status, 404);

  const save = await handleMob020Request(
    request(`/v1/capture-tasks/${TASK_ID}/final-draft`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ markdown: '# 周会\n\n人工确认后的最终稿。' }),
    }),
    env,
    { id: DEVICE_ID },
    'request-save-1',
  );
  assert.equal(save?.status, 200);
  const saveBody = (await save?.json()) as {
    data: {
      draft: {
        kind: string;
        version: number;
        title: string;
        markdown: string;
        baseVersion: number;
        confirmedAt: string;
        structured: { summary: string } | null;
      };
    };
  };
  assert.equal(saveBody.data.draft.kind, 'final');
  assert.equal(saveBody.data.draft.version, 1);
  assert.equal(saveBody.data.draft.title, '周会');
  assert.equal(saveBody.data.draft.baseVersion, 1);
  assert.equal(saveBody.data.draft.confirmedAt.length > 0, true);
  assert.equal(saveBody.data.draft.structured?.summary, '团队对齐了灰度计划。');

  const resave = await handleMob020Request(
    request(`/v1/capture-tasks/${TASK_ID}/final-draft`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ markdown: '# 周会\n\n第二次人工修改。', title: '周会（改）' }),
    }),
    env,
    { id: DEVICE_ID },
    'request-save-2',
  );
  assert.equal(resave?.status, 200);
  const resaveBody = (await resave?.json()) as {
    data: { draft: { title: string; markdown: string; confirmedAt: string } };
  };
  assert.equal(resaveBody.data.draft.title, '周会（改）');
  assert.equal(resaveBody.data.draft.markdown.includes('第二次人工修改'), true);
  assert.equal(resaveBody.data.draft.confirmedAt.length > 0, true);

  const finalRows = db.drafts.filter((draft) => draft.kind === 'final');
  assert.equal(finalRows.length, 1);
  assert.equal(finalRows[0].version, 1);
  assert.equal(db.drafts.filter((draft) => draft.kind === 'ai').length, 1);

  const invalidBase = await handleMob020Request(
    request(`/v1/capture-tasks/${TASK_ID}/final-draft`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ markdown: '# x', baseVersion: 9 }),
    }),
    env,
    { id: DEVICE_ID },
    'request-save-3',
  );
  assert.equal(invalidBase?.status, 409);
  const invalidBaseBody = (await invalidBase?.json()) as { error: { code: string } };
  assert.equal(invalidBaseBody.error.code, 'final_draft_base_version_invalid');
});

test('AI adjust after a saved Final Draft creates a candidate without overwriting it', async () => {
  const { env, db } = makeEnv();
  await runMob020Organize(env, { taskId: TASK_ID, requestId: 'req-1' }, step);

  const save = await handleMob020Request(
    request(`/v1/capture-tasks/${TASK_ID}/final-draft`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ markdown: '# 周会\n\n人工最终稿。' }),
    }),
    env,
    { id: DEVICE_ID },
    'request-final',
  );
  assert.equal(save?.status, 200);
  const finalBefore = db.drafts.find((draft) => draft.kind === 'final');

  const adjust = await handleMob020Request(
    request(`/v1/capture-tasks/${TASK_ID}/ai-draft/adjust`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ instruction: '再精简一点', idempotencyKey: 'adj-after-final' }),
    }),
    env,
    { id: DEVICE_ID },
    'request-adjust',
  );
  assert.equal(adjust?.status, 200);
  const adjustBody = (await adjust?.json()) as { data: { draft: { version: number } } };
  assert.equal(adjustBody.data.draft.version, 2);

  const finalAfter = db.drafts.find((draft) => draft.kind === 'final');
  assert.equal(finalAfter?.markdown, finalBefore?.markdown);
  assert.equal(finalAfter?.confirmed_at, finalBefore?.confirmed_at);
  assert.equal(
    db.drafts.filter((draft) => draft.kind === 'ai').length,
    2,
  );
  assert.equal(db.transcript?.text, TRANSCRIPT_TEXT);
});
