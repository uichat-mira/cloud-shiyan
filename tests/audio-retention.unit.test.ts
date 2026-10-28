import assert from 'node:assert/strict';
import test from 'node:test';
import { handleAudioRetentionRequest, type Mob019Env } from '../src/api/mob019';
import type { CaptureTaskOwner } from '../src/shared/captureTaskOwner';

const TASK_ID = '11111111-1111-4111-8111-111111111111';
const CONFIRMED_AT = '2026-10-20T03:00:00.000Z';

type Call = { sql: string; values: unknown[] };

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

  async all(): Promise<{ success: boolean; results: unknown[] }> {
    return { success: true, results: [] };
  }
}

class FakeDb {
  readonly calls: Call[] = [];

  constructor(readonly ownedTaskId: string | null) {}

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
    this.calls.push({ sql, values });
    if (sql.includes('FROM capture_tasks')) {
      return this.ownedTaskId && values[0] === this.ownedTaskId
        ? { id: this.ownedTaskId }
        : null;
    }
    if (sql.includes('SELECT confirmed_at, delete_after')) {
      return { confirmed_at: CONFIRMED_AT, delete_after: null };
    }
    if (sql.includes('FROM audio_assets')) {
      return {
        id: 'asset-1',
        task_id: TASK_ID,
        object_key: `audio/ephemeral/${TASK_ID}/asset-1`,
        content_type: 'audio/mpeg',
        expected_size_bytes: 32,
        actual_size_bytes: 32,
        etag: 'etag-1',
        status: 'confirmed',
        retained: 0,
        delete_after: null,
        deleted_at: null,
        confirmed_at: CONFIRMED_AT,
      };
    }
    return null;
  }

  run(sql: string, values: unknown[]): void {
    this.calls.push({ sql, values });
  }
}

const cloudOwner: CaptureTaskOwner = {
  kind: 'cloud-account',
  cloudAccountId: 'account-a',
  cloudDeviceId: 'mira-device-1',
};

const legacyOwner: CaptureTaskOwner = {
  kind: 'legacy-device',
  legacyDeviceId: 'legacy-device-a',
};

const envFor = (db: FakeDb): Mob019Env => ({ DB: db }) as unknown as Mob019Env;

const retentionRequest = (retained: unknown = true): Request =>
  new Request(`https://example.test/v1/capture-tasks/${TASK_ID}/audio/retention`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ retained }),
  });

const taskLookup = (db: FakeDb): Call | undefined =>
  db.calls.find((call) => call.sql.includes('FROM capture_tasks'));

test('cloud retention is scoped by account before the asset is read', async () => {
  const db = new FakeDb(TASK_ID);
  const response = await handleAudioRetentionRequest(
    retentionRequest(true),
    envFor(db),
    cloudOwner,
    'request-1',
  );

  assert.equal(response?.status, 200);
  const body = (await response?.json()) as {
    ok: boolean;
    data: { assetId: string; retained: boolean; deleteAfter: string | null };
  };
  assert.deepEqual(body.data, {
    assetId: 'asset-1',
    retained: true,
    deleteAfter: null,
    deletedAt: null,
  });

  const lookup = taskLookup(db);
  assert.ok(lookup);
  assert.match(
    lookup.sql,
    /owner_kind = 'cloud-account' AND cloud_account_id = \?/u,
  );
  assert.deepEqual(lookup.values, [TASK_ID, 'account-a']);

  const lookupIndex = db.calls.indexOf(lookup);
  const assetIndex = db.calls.findIndex((call) =>
    call.sql.includes('FROM audio_assets'),
  );
  assert.ok(assetIndex > lookupIndex);
});

test('foreign and unknown tasks fail before any audio asset access or mutation', async () => {
  for (const ownedTaskId of [null, 'another-task']) {
    const db = new FakeDb(ownedTaskId);
    const response = await handleAudioRetentionRequest(
      retentionRequest(true),
      envFor(db),
      cloudOwner,
      'request-1',
    );

    assert.equal(response?.status, 404);
    const body = (await response?.json()) as {
      ok: boolean;
      error: { code: string };
    };
    assert.deepEqual(body.error.code, 'task_not_found');
    assert.equal(
      db.calls.some((call) => call.sql.includes('FROM audio_assets')),
      false,
    );
    assert.equal(
      db.calls.some(
        (call) =>
          call.sql.startsWith('UPDATE audio_assets') ||
          call.sql.startsWith('INSERT INTO audio_assets'),
      ),
      false,
    );
  }
});

test('legacy retention keeps the device owner predicate', async () => {
  const db = new FakeDb(TASK_ID);
  const response = await handleAudioRetentionRequest(
    retentionRequest(false),
    envFor(db),
    legacyOwner,
    'request-1',
  );

  assert.equal(response?.status, 200);
  const lookup = taskLookup(db);
  assert.ok(lookup);
  assert.match(lookup.sql, /owner_kind = 'legacy-device' AND device_id = \?/u);
  assert.deepEqual(lookup.values, [TASK_ID, 'legacy-device-a']);
});

test('invalid task ids, methods and non-retention routes are rejected before ownership lookup', async () => {
  const db = new FakeDb(TASK_ID);

  const invalidId = await handleAudioRetentionRequest(
    new Request('https://example.test/v1/capture-tasks/not-a-task/audio/retention', {
      method: 'PUT',
      body: JSON.stringify({ retained: true }),
    }),
    envFor(db),
    cloudOwner,
    'request-1',
  );
  assert.equal(invalidId?.status, 400);

  const wrongMethod = await handleAudioRetentionRequest(
    new Request(`https://example.test/v1/capture-tasks/${TASK_ID}/audio/retention`),
    envFor(db),
    cloudOwner,
    'request-1',
  );
  assert.equal(wrongMethod?.status, 405);

  const otherRoute = await handleAudioRetentionRequest(
    new Request(`https://example.test/v1/capture-tasks/${TASK_ID}/transcript`),
    envFor(db),
    cloudOwner,
    'request-1',
  );
  assert.equal(otherRoute, null);

  assert.equal(taskLookup(db), undefined);
});
