import assert from 'node:assert/strict';
import test from 'node:test';
import {
  executeDestinationDelivery,
  handleMob022Request,
  type Mob022Env,
  type Mob022GithubEnv,
} from '../src/api/mob022';
import type {
  ConfirmedFinalDraftSnapshot,
  DestinationAdapter,
  DestinationResult,
} from '../src/shared/destination';
import type { Mob019D1 } from '../src/api/mob019';

const TASK_ID = '11111111-1111-4111-8111-111111111111';
const DRAFT: ConfirmedFinalDraftSnapshot = {
  id: 'final-1',
  taskId: TASK_ID,
  title: 'Weekly review',
  markdown: '# Weekly review\n\nDone.',
  confirmedAt: '2026-08-29T03:00:00.000Z',
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

class FakeStatement {
  values: Array<string | number | null> = [];
  constructor(readonly db: FakeDb, readonly sql: string) {}
  bind(...values: Array<string | number | null>): FakeStatement {
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
  readonly deliveries = new Map<string, DeliveryRow>();
  deliveryStage = { status: 'pending', retryable: 1, retry_count: 0, error_code: null as string | null };
  currentStage = 'ready';
  ownerDeviceId = 'device-1';
  finalDraft: ConfirmedFinalDraftSnapshot | null = DRAFT;

  prepare(sql: string): FakeStatement {
    return new FakeStatement(this, sql);
  }

  async batch(statements: FakeStatement[]): Promise<Array<{ success: boolean }>> {
    for (const statement of statements) this.run(statement.sql, statement.values);
    return statements.map(() => ({ success: true }));
  }

  first(sql: string, values: Array<string | number | null>): unknown {
    if (sql.includes('FROM capture_tasks') && sql.includes('device_id = ?')) {
      return values[0] === TASK_ID && values[1] === this.ownerDeviceId ? { id: TASK_ID } : null;
    }
    if (sql.includes('FROM capture_tasks') && sql.includes('WHERE id = ?')) {
      return values[0] === TASK_ID ? { id: TASK_ID } : null;
    }
    if (sql.includes('FROM drafts') && sql.includes("kind = 'final'")) {
      if (values[0] !== TASK_ID || !this.finalDraft) return null;
      return {
        id: this.finalDraft.id,
        task_id: this.finalDraft.taskId,
        title: this.finalDraft.title,
        markdown: this.finalDraft.markdown,
        confirmed_at: this.finalDraft.confirmedAt,
      };
    }
    if (sql.includes('FROM delivery_records') && sql.includes('idempotency_key = ?')) {
      const [taskId, key] = values;
      return [...this.deliveries.values()].find(
        (row) => row.task_id === taskId && row.idempotency_key === key,
      ) ?? null;
    }
    if (sql.includes('FROM delivery_records') && sql.includes('WHERE id = ?')) {
      return this.deliveries.get(String(values[0])) ?? null;
    }
    return null;
  }

  all(sql: string, values: Array<string | number | null>): unknown[] {
    if (sql.includes('FROM delivery_records') && sql.includes('WHERE task_id = ?')) {
      return [...this.deliveries.values()].filter((row) => row.task_id === values[0]);
    }
    return [];
  }

  run(sql: string, values: Array<string | number | null>): void {
    if (sql.includes('INSERT INTO delivery_records')) {
      const [id, taskId, finalDraftId, key, contentSha, createdAt, updatedAt] = values as string[];
      this.deliveries.set(id, {
        id,
        task_id: taskId,
        final_draft_id: finalDraftId,
        destination: 'github',
        idempotency_key: key,
        status: 'pending',
        retryable: 1,
        retry_count: 0,
        content_sha256: contentSha,
        repository: null,
        path: null,
        commit_sha: null,
        file_url: null,
        error_code: null,
        error_message: null,
        delivered_at: null,
        created_at: createdAt,
        updated_at: updatedAt,
      });
      return;
    }

    if (sql.includes('UPDATE delivery_records') && sql.includes("SET status = 'pending'")) {
      const [retryCount, updatedAt, id] = values;
      const row = this.deliveries.get(String(id));
      if (row) Object.assign(row, { status: 'pending', retryable: 1, retry_count: retryCount, error_code: null, error_message: null, updated_at: updatedAt });
      return;
    }

    if (sql.includes('UPDATE delivery_records') && sql.includes("SET status = 'failed'")) {
      const [retryable, code, message, updatedAt, id] = values;
      const row = this.deliveries.get(String(id));
      if (row) Object.assign(row, { status: 'failed', retryable, error_code: code, error_message: message, updated_at: updatedAt });
      return;
    }

    if (sql.includes('UPDATE delivery_records') && sql.includes("SET status = 'succeeded'")) {
      const [repository, path, commitSha, fileUrl, deliveredAt, updatedAt, id] = values;
      const row = this.deliveries.get(String(id));
      if (row) Object.assign(row, { status: 'succeeded', retryable: 0, repository, path, commit_sha: commitSha, file_url: fileUrl, error_code: null, error_message: null, delivered_at: deliveredAt, updated_at: updatedAt });
      return;
    }

    if (sql.includes("stage = 'delivery'") || sql.includes("VALUES (?, 'delivery'")) {
      if (sql.includes("SET status = 'running'")) {
        this.deliveryStage = { status: 'running', retryable: 1, retry_count: Number(values[0]), error_code: null };
      } else if (sql.includes("SET status = 'succeeded'")) {
        this.deliveryStage = { ...this.deliveryStage, status: 'succeeded', retryable: 0, error_code: null };
      } else if (sql.includes("SET status = 'failed'")) {
        this.deliveryStage = { ...this.deliveryStage, status: 'failed', retryable: Number(values[0]), error_code: String(values[1]) };
      }
      return;
    }

    if (sql.includes('UPDATE capture_tasks SET current_stage')) {
      this.currentStage = String(values[0]);
    }
  }
}

const envFor = (db: FakeDb): Mob022Env => ({ DB: db as unknown as Mob019D1 });

const githubEnvFor = (db: FakeDb): Mob022GithubEnv => ({
  DB: db as unknown as Mob019D1,
  GITHUB_DESTINATION_TOKEN: 'test-token',
});

const successResult = (): DestinationResult => ({
  ok: true,
  value: {
    destination: 'github',
    repository: 'dangjingtao/mira-shiyan',
    path: `entries/2026/08/${TASK_ID}.md`,
    commitSha: 'commit-1',
    fileUrl: `https://github.com/dangjingtao/mira-shiyan/blob/main/entries/2026/08/${TASK_ID}.md`,
    deliveredAt: '2026-08-29T03:01:00.000Z',
  },
});

test('same successful idempotency key returns saved evidence without a second destination call', async () => {
  const db = new FakeDb();
  let calls = 0;
  const adapter: DestinationAdapter = {
    async deliver() {
      calls += 1;
      return successResult();
    },
  };

  const first = await executeDestinationDelivery(envFor(db), adapter, DRAFT, 'deliver-1');
  const second = await executeDestinationDelivery(envFor(db), adapter, DRAFT, 'deliver-1');

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(calls, 1);
  assert.equal(db.deliveries.size, 1);
  assert.equal(db.deliveryStage.status, 'succeeded');
  if (second.ok) assert.equal(second.delivery.commitSha, 'commit-1');
});

test('retryable destination failure reuses the delivery record and recovers', async () => {
  const db = new FakeDb();
  const results: DestinationResult[] = [
    { ok: false, error: { kind: 'retryable', code: 'github_unavailable', message: 'temporary' } },
    successResult(),
  ];
  let calls = 0;
  const adapter: DestinationAdapter = {
    async deliver() {
      calls += 1;
      return results.shift() ?? successResult();
    },
  };

  const failed = await executeDestinationDelivery(envFor(db), adapter, DRAFT, 'deliver-2');
  assert.equal(failed.ok, false);
  assert.equal(db.deliveryStage.status, 'failed');
  assert.equal(db.deliveryStage.retryable, 1);

  const recovered = await executeDestinationDelivery(envFor(db), adapter, DRAFT, 'deliver-2');
  assert.equal(recovered.ok, true);
  assert.equal(calls, 2);
  assert.equal(db.deliveries.size, 1);
  const record = [...db.deliveries.values()][0];
  assert.equal(record?.retry_count, 1);
  assert.equal(record?.status, 'succeeded');
});

test('terminal delivery failure is not silently retried', async () => {
  const db = new FakeDb();
  let calls = 0;
  const adapter: DestinationAdapter = {
    async deliver() {
      calls += 1;
      return { ok: false, error: { kind: 'terminal', code: 'github_permission_denied', message: 'denied' } };
    },
  };

  const first = await executeDestinationDelivery(envFor(db), adapter, DRAFT, 'deliver-3');
  const second = await executeDestinationDelivery(envFor(db), adapter, DRAFT, 'deliver-3');

  assert.equal(first.ok, false);
  assert.equal(second.ok, false);
  assert.equal(calls, 1);
  assert.equal(db.deliveryStage.retryable, 0);
});

test('one idempotency key cannot be rebound to different confirmed content', async () => {
  const db = new FakeDb();
  let calls = 0;
  const adapter: DestinationAdapter = {
    async deliver() {
      calls += 1;
      return { ok: false, error: { kind: 'retryable', code: 'github_unavailable', message: 'temporary' } };
    },
  };

  await executeDestinationDelivery(envFor(db), adapter, DRAFT, 'deliver-4');
  const conflict = await executeDestinationDelivery(
    envFor(db),
    adapter,
    { ...DRAFT, id: 'final-2', markdown: '# Different' },
    'deliver-4',
  );

  assert.equal(conflict.ok, false);
  if (!conflict.ok) assert.equal(conflict.error.code, 'delivery_idempotency_conflict');
  assert.equal(calls, 1);
});

test('POST deliveries publishes the confirmed Final Draft and replays saved evidence', async () => {
  const db = new FakeDb();
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) return new Response(null, { status: 404 });
    return Response.json(
      {
        content: {
          path: `entries/2026/08/${TASK_ID}.md`,
          html_url: `https://github.com/dangjingtao/mira-shiyan/blob/main/entries/2026/08/${TASK_ID}.md`,
        },
        commit: { sha: 'commit-route-1' },
      },
      { status: 201 },
    );
  };

  try {
    const request = () =>
      new Request(`https://api.example/v1/capture-tasks/${TASK_ID}/deliveries`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ destination: 'github', idempotencyKey: 'mobile-deliver-1' }),
      });
    const first = await handleMob022Request(request(), githubEnvFor(db), { id: 'device-1' }, 'req-1');
    const replay = await handleMob022Request(request(), githubEnvFor(db), { id: 'device-1' }, 'req-2');
    assert.equal(first?.status, 200);
    assert.equal(replay?.status, 200);
    assert.equal(calls, 2);
    const body = (await replay?.json()) as { data: { record: DeliveryRow } };
    assert.equal(body.data.record.commit_sha ?? body.data.record.commitSha, 'commit-route-1');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('POST deliveries requires a confirmed Final Draft', async () => {
  const db = new FakeDb();
  db.finalDraft = null;
  const response = await handleMob022Request(
    new Request(`https://api.example/v1/capture-tasks/${TASK_ID}/deliveries`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ destination: 'github', idempotencyKey: 'mobile-deliver-2' }),
    }),
    githubEnvFor(db),
    { id: 'device-1' },
    'req-3',
  );
  assert.equal(response?.status, 409);
  assert.equal(((await response?.json()) as { error: { code: string } }).error.code, 'final_draft_not_ready');
});

test('delivery routes conceal tasks owned by another device', async () => {
  const db = new FakeDb();
  const response = await handleMob022Request(
    new Request(`https://api.example/v1/capture-tasks/${TASK_ID}/deliveries`),
    githubEnvFor(db),
    { id: 'device-2' },
    'req-4',
  );
  assert.equal(response?.status, 404);
  assert.equal(((await response?.json()) as { error: { code: string } }).error.code, 'task_not_found');
});
