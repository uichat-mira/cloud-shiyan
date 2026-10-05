import assert from 'node:assert/strict';
import test from 'node:test';
import {
  cleanupExpiredAudio,
  handleMob019Request,
  runMob019Workflow,
  type Mob019Env,
} from '../src/api/mob019';

const TASK_ID = '11111111-1111-4111-8111-111111111111';
const RETAINED_TASK_ID = '22222222-2222-4222-8222-222222222222';
const DEVICE_ID = 'device-1';
const NOW = '2026-08-29T03:00:00.000Z';

type Asset = {
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

type Transcript = {
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

type Stage = {
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped';
  retryable: number;
  retry_count: number;
  error_code: string | null;
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

  async run<T>(): Promise<{ success: boolean; results?: T[] }> {
    this.db.run(this.sql, this.values);
    return { success: true };
  }

  async all<T>(): Promise<{ success: boolean; results?: T[] }> {
    return { success: true, results: this.db.all(this.sql, this.values) as T[] };
  }
}

class FakeDb {
  readonly statements: Array<{ sql: string; values: unknown[] }> = [];
  readonly tasks = new Map([
    [TASK_ID, { id: TASK_ID, device_id: DEVICE_ID }],
    [RETAINED_TASK_ID, { id: RETAINED_TASK_ID, device_id: DEVICE_ID }],
  ]);
  readonly assets = new Map<string, Asset>();
  readonly segments = new Map<string, Array<{ segment_index: number; start_ms: number; end_ms: number; text: string }>>();
  transcript: Transcript | null = null;
  stage: Stage = { status: 'failed', retryable: 1, retry_count: 0, error_code: 'stt_provider_retryable' };

  constructor() {
    this.assets.set(TASK_ID, {
      id: 'asset-1',
      task_id: TASK_ID,
      object_key: 'audio/ephemeral/task-1/audio',
      content_type: 'audio/mp4',
      expected_size_bytes: 4,
      actual_size_bytes: 4,
      etag: 'etag-1',
      status: 'confirmed',
      retained: 0,
      delete_after: '2026-08-28T03:00:00.000Z',
      deleted_at: null,
      confirmed_at: '2026-08-25T03:00:00.000Z',
    });
    this.assets.set(RETAINED_TASK_ID, {
      id: 'asset-2',
      task_id: RETAINED_TASK_ID,
      object_key: 'audio/ephemeral/task-2/audio',
      content_type: 'audio/mp4',
      expected_size_bytes: 4,
      actual_size_bytes: 4,
      etag: 'etag-2',
      status: 'confirmed',
      retained: 1,
      delete_after: '2026-08-28T03:00:00.000Z',
      deleted_at: null,
      confirmed_at: '2026-08-25T03:00:00.000Z',
    });
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
      return task?.device_id === deviceId ? { id: taskId } : null;
    }

    if (sql.includes('FROM audio_assets')) {
      const taskId = values[0] as string;
      const asset = [...this.assets.values()].find(
        (candidate) => candidate.task_id === taskId || candidate.id === taskId,
      );
      if (!asset) return null;
      if (sql.includes('SELECT confirmed_at, delete_after')) {
        return { confirmed_at: asset.confirmed_at, delete_after: asset.delete_after };
      }
      if (sql.includes('object_key = ?') && values[1] !== asset.object_key) return null;
      return { ...asset };
    }

    if (sql.includes("FROM capture_stages") && sql.includes("stage = 'transcribe'")) {
      return { ...this.stage };
    }

    if (sql.includes('FROM transcripts')) {
      if (!this.transcript || this.transcript.task_id !== values[0]) return null;
      if (sql.trimStart().startsWith('SELECT id FROM transcripts')) {
        return { id: this.transcript.id };
      }
      return { ...this.transcript };
    }

    return null;
  }

  all(sql: string, values: unknown[]): unknown[] {
    if (sql.includes('FROM transcript_segments')) {
      return this.segments.get(values[0] as string) ?? [];
    }

    if (sql.includes('FROM audio_assets') && sql.includes('retained = 0')) {
      const cutoff = values[0] as string;
      return [...this.assets.values()]
        .filter(
          (asset) =>
            asset.status === 'confirmed' &&
            asset.retained === 0 &&
            asset.deleted_at === null &&
            asset.delete_after !== null &&
            asset.delete_after <= cutoff,
        )
        .map((asset) => ({ id: asset.id, object_key: asset.object_key }));
    }

    return [];
  }

  run(sql: string, values: unknown[]): void {
    this.statements.push({ sql, values: [...values] });

    if (sql.startsWith('INSERT INTO transcripts')) {
      this.transcript = {
        id: values[0] as string,
        task_id: values[1] as string,
        source_asset_id: values[2] as string,
        text: values[3] as string,
        language: (values[4] as string | null) ?? null,
        duration_ms: (values[5] as number | null) ?? null,
        provider: values[6] as string,
        model: values[7] as string,
        provider_request_id: (values[8] as string | null) ?? null,
        provider_metadata_json: (values[9] as string | null) ?? null,
        stt_artifact_key: values[10] as string,
        created_at: values[11] as string,
      };
      return;
    }

    if (sql.startsWith('INSERT INTO transcript_segments')) {
      const transcriptId = values[0] as string;
      const list = this.segments.get(transcriptId) ?? [];
      list.push({
        segment_index: values[1] as number,
        start_ms: values[2] as number,
        end_ms: values[3] as number,
        text: values[4] as string,
      });
      this.segments.set(transcriptId, list);
      return;
    }

    if (sql.includes("WHERE task_id = ? AND stage = 'transcribe'")) {
      if (sql.includes("SET status = 'pending'")) {
        this.stage = {
          status: 'pending',
          retryable: 1,
          retry_count: values[0] as number,
          error_code: null,
        };
      } else if (sql.includes("SET status = 'running'")) {
        this.stage = { ...this.stage, status: 'running', retryable: 1, error_code: null };
      } else if (sql.includes("SET status = 'succeeded'")) {
        this.stage = { ...this.stage, status: 'succeeded', retryable: 0, error_code: null };
      }
      return;
    }

    if (sql.includes("SET status = 'failed'") && values.at(-1) === 'transcribe') {
      this.stage = {
        status: 'failed',
        retryable: values[0] as number,
        retry_count: this.stage.retry_count,
        error_code: values[1] as string,
      };
      return;
    }

    if (sql.startsWith('UPDATE audio_assets SET deleted_at = ?')) {
      const assetId = values[1] as string;
      const asset = [...this.assets.values()].find((candidate) => candidate.id === assetId);
      if (asset) asset.deleted_at = values[0] as string;
    }
  }
}

class FakeR2 {
  readonly objects = new Map<string, string | ArrayBuffer>();
  readonly deleted: string[] = [];
  headFailures = 0;
  headCalls = 0;

  constructor(db: FakeDb) {
    for (const asset of db.assets.values()) {
      this.objects.set(asset.object_key, new Uint8Array([1, 2, 3, 4]).buffer);
    }
  }

  async head(key: string) {
    this.headCalls += 1;
    if (this.headFailures > 0) {
      this.headFailures -= 1;
      throw new Error('temporary R2 outage');
    }
    const value = this.objects.get(key);
    if (value === undefined) return null;
    return { size: 4, etag: 'etag', httpMetadata: { contentType: key.includes('audio/') ? 'audio/mp4' : 'application/json' } };
  }

  async get(key: string) {
    const value = this.objects.get(key);
    if (value === undefined) return null;
    return {
      size: typeof value === 'string' ? value.length : value.byteLength,
      etag: 'etag',
      httpMetadata: { contentType: key.includes('audio/') ? 'audio/mp4' : 'application/json' },
      async arrayBuffer() {
        if (typeof value === 'string') return new TextEncoder().encode(value).buffer;
        return value;
      },
      async text() {
        if (typeof value === 'string') return value;
        return new TextDecoder().decode(value);
      },
    };
  }

  async put(key: string, value: string | ArrayBuffer | ArrayBufferView) {
    if (typeof value === 'string' || value instanceof ArrayBuffer) {
      this.objects.set(key, value);
    } else {
      this.objects.set(key, value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
    }
    return {};
  }

  async delete(key: string) {
    this.deleted.push(key);
    this.objects.delete(key);
  }
}

const makeEnv = (options: { aiError?: Error; headFailures?: number } = {}) => {
  const db = new FakeDb();
  const r2 = new FakeR2(db);
  r2.headFailures = options.headFailures ?? 0;
  let aiCalls = 0;
  const workflowIds: string[] = [];

  const env = {
    DB: db,
    AUDIO: r2,
    AI: {
      async run() {
        aiCalls += 1;
        if (options.aiError) throw options.aiError;
        return {
          text: '会议转写结果',
          language: 'zh',
          request_id: 'provider-request-1',
          segments: [{ start: 0, end: 1.5, text: '会议转写结果' }],
        };
      },
    },
    CAPTURE_WORKFLOW: {
      async create(input?: { id?: string }) {
        if (input?.id) workflowIds.push(input.id);
        return {};
      },
      async get() {
        return {};
      },
    },
  } as unknown as Mob019Env;

  return { env, db, r2, workflowIds, getAiCalls: () => aiCalls };
};

test('Workflow retries transient verify-audio failure, persists Transcript, and reaches organize pending', async () => {
  const { env, db, r2, getAiCalls } = makeEnv({ headFailures: 1 });
  let verifyAttempts = 0;

  const step = {
    async do<T>(name: string, callback: () => Promise<T>): Promise<T> {
      if (name !== 'verify-audio') return callback();
      try {
        verifyAttempts += 1;
        return await callback();
      } catch {
        verifyAttempts += 1;
        return callback();
      }
    },
  };

  await runMob019Workflow(
    env,
    { taskId: TASK_ID, objectKey: 'audio/ephemeral/task-1/audio' },
    step,
  );

  assert.equal(verifyAttempts, 2);
  assert.equal(getAiCalls(), 1);
  assert.equal(db.transcript?.text, '会议转写结果');
  assert.equal(db.transcript?.source_asset_id, 'asset-1');
  assert.equal(r2.objects.has('audio/ephemeral/task-1/audio'), true);
  assert.equal(
    db.statements.some(
      ({ sql }) => sql.includes("current_stage = 'organize'") && !sql.includes('lifecycle_status'),
    ),
    true,
  );
});

test('Provider 5xx fails only STT stage and keeps the confirmed audio for recovery', async () => {
  const { env, db, r2, getAiCalls } = makeEnv({ aiError: new Error('503 upstream timeout') });

  await runMob019Workflow(
    env,
    { taskId: TASK_ID, objectKey: 'audio/ephemeral/task-1/audio' },
    { async do<T>(_name: string, callback: () => Promise<T>) { return callback(); } },
  );

  assert.equal(getAiCalls(), 1);
  assert.equal(db.stage.status, 'failed');
  assert.equal(db.stage.retryable, 1);
  assert.equal(db.stage.error_code, 'stt_provider_retryable');
  assert.equal(db.transcript, null);
  assert.equal(r2.objects.has('audio/ephemeral/task-1/audio'), true);
  assert.equal(db.statements.some(({ sql }) => sql.includes('lifecycle_status')), false);
});

test('Non-retryable provider input error does not loop inside the Workflow', async () => {
  const { env, db, getAiCalls } = makeEnv({ aiError: new Error('400 invalid audio payload') });

  await runMob019Workflow(
    env,
    { taskId: TASK_ID, objectKey: 'audio/ephemeral/task-1/audio' },
    { async do<T>(_name: string, callback: () => Promise<T>) { return callback(); } },
  );

  assert.equal(getAiCalls(), 1);
  assert.equal(db.stage.status, 'failed');
  assert.equal(db.stage.retryable, 0);
  assert.equal(db.stage.error_code, 'stt_provider_error');
});

test('Repeated STT retries reuse the same CaptureTask and AudioAsset while incrementing retry count', async () => {
  const { env, db, workflowIds } = makeEnv();

  const first = await handleMob019Request(
    new Request(`https://example.test/v1/capture-tasks/${TASK_ID}/stt/retry`, { method: 'POST' }),
    env,
    { id: DEVICE_ID },
    'request-1',
  );
  assert.equal(first?.status, 200);
  assert.equal(db.stage.retry_count, 1);

  db.stage = {
    status: 'failed',
    retryable: 1,
    retry_count: 1,
    error_code: 'stt_provider_retryable',
  };

  const second = await handleMob019Request(
    new Request(`https://example.test/v1/capture-tasks/${TASK_ID}/stt/retry`, { method: 'POST' }),
    env,
    { id: DEVICE_ID },
    'request-2',
  );
  assert.equal(second?.status, 200);
  assert.equal(db.stage.retry_count, 2);
  assert.deepEqual(workflowIds, [
    `capture-${TASK_ID}-stt-1`,
    `capture-${TASK_ID}-stt-2`,
  ]);
  assert.equal(db.assets.size, 2);
  assert.equal(db.tasks.size, 2);
});

test('Expired raw audio cleanup preserves Transcript and skips retained recordings', async () => {
  const { env, db, r2 } = makeEnv();
  db.transcript = {
    id: 'transcript-1',
    task_id: TASK_ID,
    source_asset_id: 'asset-1',
    text: '长期 Transcript',
    language: 'zh',
    duration_ms: 1500,
    provider: 'cloudflare-workers-ai',
    model: '@cf/openai/whisper-large-v3-turbo',
    provider_request_id: 'provider-request-1',
    provider_metadata_json: '{"wordCount":2}',
    stt_artifact_key: 'stt/normalized/task-1/attempt.json',
    created_at: NOW,
  };
  db.segments.set('transcript-1', [
    { segment_index: 0, start_ms: 0, end_ms: 1500, text: '长期 Transcript' },
  ]);

  const result = await cleanupExpiredAudio(env, new Date(NOW));
  assert.deepEqual(result, { deleted: 1, failed: 0 });
  assert.deepEqual(r2.deleted, ['audio/ephemeral/task-1/audio']);
  assert.equal(r2.objects.has('audio/ephemeral/task-2/audio'), true, 'retained audio must survive cleanup');
  assert.equal(db.transcript.text, '长期 Transcript');

  const transcriptResponse = await handleMob019Request(
    new Request(`https://example.test/v1/capture-tasks/${TASK_ID}/transcript`),
    env,
    { id: DEVICE_ID },
    'request-transcript',
  );
  assert.equal(transcriptResponse?.status, 200);
  const body = (await transcriptResponse?.json()) as { data: { transcript: { text: string; segments: unknown[] } } };
  assert.equal(body.data.transcript.text, '长期 Transcript');
  assert.equal(body.data.transcript.segments.length, 1);
});
