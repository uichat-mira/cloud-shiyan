import { describe, expect, it } from 'vitest';
import { env, exports } from 'cloudflare:workers';
import {
  captureTaskOwnerFromRow,
  findCaptureTaskIdByCreateIdempotencyKey,
  type CaptureTaskOwner,
} from '../../src/shared/captureTaskOwner';

const runtime = env as typeof env & {
  DB: D1Database;
  DEVICE_AUTH_PEPPER: string;
};

const worker = exports.default as {
  fetch(request: Request): Promise<Response>;
};

const db = runtime.DB;
const now = (): string => new Date().toISOString();

const sha256Hex = async (value: string): Promise<string> => {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
};

type TaskRow = {
  id: string;
  ownerKind: 'legacy-device' | 'cloud-account';
  deviceId: string | null;
  cloudAccountId: string | null;
  cloudDeviceId: string | null;
  createIdempotencyKey: string;
};

const insertTaskRow = async (row: TaskRow): Promise<void> => {
  await db
    .prepare(
      `INSERT INTO capture_tasks
       (id, owner_kind, device_id, cloud_account_id, cloud_device_id, user_id,
        title, scene_id, create_idempotency_key, correlation_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, NULL, ?, 'meeting', ?, ?, ?, ?)`,
    )
    .bind(
      row.id,
      row.ownerKind,
      row.deviceId,
      row.cloudAccountId,
      row.cloudDeviceId,
      `task-${row.id}`,
      row.createIdempotencyKey,
      `corr-${row.id}`,
      now(),
      now(),
    )
    .run();
};

const insertTaskWithReferences = async (row: TaskRow): Promise<void> => {
  const timestamp = now();
  await db.batch([
    db
      .prepare(
        `INSERT INTO capture_tasks
         (id, owner_kind, device_id, cloud_account_id, cloud_device_id, user_id,
          title, scene_id, create_idempotency_key, correlation_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, NULL, ?, 'meeting', ?, ?, ?, ?)`,
      )
      .bind(
        row.id,
        row.ownerKind,
        row.deviceId,
        row.cloudAccountId,
        row.cloudDeviceId,
        `task-${row.id}`,
        row.createIdempotencyKey,
        `corr-${row.id}`,
        timestamp,
        timestamp,
      ),
    db
      .prepare(
        `INSERT INTO capture_stages
         (task_id, stage, status, retryable, retry_count, updated_at)
         VALUES (?, 'upload', 'running', 1, 0, ?)`,
      )
      .bind(row.id, timestamp),
    db
      .prepare(
        `INSERT INTO audio_assets
         (id, task_id, object_key, content_type, status, upload_expires_at, created_at)
         VALUES (?, ?, ?, 'audio/mpeg', 'awaiting_upload', ?, ?)`,
      )
      .bind(`asset-${row.id}`, row.id, `audio/${row.id}`, timestamp, timestamp),
  ]);
};

const insertLegacyDevice = async (deviceId: string): Promise<void> => {
  const timestamp = now();
  await db
    .prepare(
      `INSERT INTO devices
       (id, credential_hash, user_id, display_name, created_at, last_seen_at)
       VALUES (?, ?, NULL, 'Legacy device', ?, ?)`,
    )
    .bind(deviceId, `hash-${deviceId}`, timestamp, timestamp)
    .run();
};

const expectRejection = async (
  action: Promise<unknown>,
  pattern: RegExp,
): Promise<void> => {
  await expect(action).rejects.toThrow(pattern);
};

describe('CaptureTask ownership schema', () => {
  it('stores cloud-account tasks without a legacy device and keeps task references', async () => {
    const accountId = `account-${crypto.randomUUID()}`;
    const cloudDeviceId = `mira-device-${crypto.randomUUID()}`;
    const taskId = crypto.randomUUID();
    const owner: CaptureTaskOwner = {
      kind: 'cloud-account',
      cloudAccountId: accountId,
      cloudDeviceId,
    };

    await insertTaskWithReferences({
      id: taskId,
      ownerKind: 'cloud-account',
      deviceId: null,
      cloudAccountId: accountId,
      cloudDeviceId,
      createIdempotencyKey: 'cloud-create-key',
    });

    const job = await db
      .prepare(
        `SELECT owner_kind, device_id, cloud_account_id, cloud_device_id
         FROM capture_tasks WHERE id = ?`,
      )
      .bind(taskId)
      .first<{
        owner_kind: string;
        device_id: string | null;
        cloud_account_id: string | null;
        cloud_device_id: string | null;
      }>();
    expect(job).not.toBeNull();
    expect(captureTaskOwnerFromRow(job!)).toEqual(owner);

    const devices = await db
      .prepare('SELECT COUNT(*) AS count FROM devices WHERE id = ?')
      .bind(cloudDeviceId)
      .first<{ count: number }>();
    expect(devices?.count).toBe(0);

    const stage = await db
      .prepare('SELECT stage, status FROM capture_stages WHERE task_id = ?')
      .bind(taskId)
      .first<{ stage: string; status: string }>();
    expect(stage).toEqual({ stage: 'upload', status: 'running' });

    const asset = await db
      .prepare('SELECT id, task_id FROM audio_assets WHERE task_id = ?')
      .bind(taskId)
      .first<{ id: string; task_id: string }>();
    expect(asset).toEqual({ id: `asset-${taskId}`, task_id: taskId });

    expect(
      await findCaptureTaskIdByCreateIdempotencyKey(
        db,
        owner,
        'cloud-create-key',
      ),
    ).toBe(taskId);
    expect(
      await findCaptureTaskIdByCreateIdempotencyKey(
        db,
        { kind: 'cloud-account', cloudAccountId: accountId, cloudDeviceId: 'another-device' },
        'cloud-create-key',
      ),
    ).toBe(taskId);
  });

  it('enforces the exact legacy or cloud owner shape at the database boundary', async () => {
    const accountId = `account-${crypto.randomUUID()}`;
    const cloudDeviceId = `mira-device-${crypto.randomUUID()}`;
    const deviceId = `legacy-device-${crypto.randomUUID()}`;
    await insertLegacyDevice(deviceId);

    const base = (id: string): TaskRow => ({
      id,
      ownerKind: 'cloud-account',
      deviceId: null,
      cloudAccountId: accountId,
      cloudDeviceId,
      createIdempotencyKey: `key-${id}`,
    });

    await expectRejection(
      insertTaskRow({ ...base(crypto.randomUUID()), deviceId }),
      /CHECK constraint failed/iu,
    );
    await expectRejection(
      insertTaskRow({
        ...base(crypto.randomUUID()),
        ownerKind: 'legacy-device',
        deviceId: null,
        cloudAccountId: null,
        cloudDeviceId: null,
      }),
      /CHECK constraint failed/iu,
    );
    await expectRejection(
      insertTaskRow({ ...base(crypto.randomUUID()), cloudDeviceId: null }),
      /CHECK constraint failed/iu,
    );
    await expectRejection(
      insertTaskRow({
        ...base(crypto.randomUUID()),
        ownerKind: 'legacy-device',
        deviceId,
        cloudAccountId: accountId,
        cloudDeviceId,
      }),
      /CHECK constraint failed/iu,
    );
    await expectRejection(
      insertTaskRow({ ...base(crypto.randomUUID()), cloudDeviceId: ' ' }),
      /CHECK constraint failed/iu,
    );
    await expectRejection(
      insertTaskRow({ ...base(crypto.randomUUID()), ownerKind: 'shared-device' as never }),
      /CHECK constraint failed/iu,
    );
    await expectRejection(
      insertTaskRow({
        ...base(crypto.randomUUID()),
        ownerKind: 'legacy-device',
        deviceId: `missing-${crypto.randomUUID()}`,
        cloudAccountId: null,
        cloudDeviceId: null,
      }),
      /FOREIGN KEY constraint failed/iu,
    );
  });

  it('scopes create idempotency by Cloud Account, not by Cloud Device or another account', async () => {
    const accountA = `account-a-${crypto.randomUUID()}`;
    const accountB = `account-b-${crypto.randomUUID()}`;
    const device1 = `mira-device-1-${crypto.randomUUID()}`;
    const device2 = `mira-device-2-${crypto.randomUUID()}`;
    const taskA = crypto.randomUUID();

    await insertTaskRow({
      id: taskA,
      ownerKind: 'cloud-account',
      deviceId: null,
      cloudAccountId: accountA,
      cloudDeviceId: device1,
      createIdempotencyKey: 'shared-key',
    });

    await expectRejection(
      insertTaskRow({
        id: crypto.randomUUID(),
        ownerKind: 'cloud-account',
        deviceId: null,
        cloudAccountId: accountA,
        cloudDeviceId: device2,
        createIdempotencyKey: 'shared-key',
      }),
      /UNIQUE constraint failed/iu,
    );

    await insertTaskRow({
      id: crypto.randomUUID(),
      ownerKind: 'cloud-account',
      deviceId: null,
      cloudAccountId: accountB,
      cloudDeviceId: device1,
      createIdempotencyKey: 'shared-key',
    });

    expect(
      await findCaptureTaskIdByCreateIdempotencyKey(
        db,
        { kind: 'cloud-account', cloudAccountId: accountA, cloudDeviceId: device2 },
        'shared-key',
      ),
    ).toBe(taskA);
    expect(
      await findCaptureTaskIdByCreateIdempotencyKey(
        db,
        { kind: 'cloud-account', cloudAccountId: accountB, cloudDeviceId: device2 },
        'shared-key',
      ),
    ).not.toBe(taskA);
  });

  it('preserves legacy device idempotency and foreign-key behavior', async () => {
    const deviceA = `legacy-a-${crypto.randomUUID()}`;
    const deviceB = `legacy-b-${crypto.randomUUID()}`;
    await insertLegacyDevice(deviceA);
    await insertLegacyDevice(deviceB);

    const taskId = crypto.randomUUID();
    await insertTaskRow({
      id: taskId,
      ownerKind: 'legacy-device',
      deviceId: deviceA,
      cloudAccountId: null,
      cloudDeviceId: null,
      createIdempotencyKey: 'legacy-key',
    });

    await expectRejection(
      insertTaskRow({
        id: crypto.randomUUID(),
        ownerKind: 'legacy-device',
        deviceId: deviceA,
        cloudAccountId: null,
        cloudDeviceId: null,
        createIdempotencyKey: 'legacy-key',
      }),
      /UNIQUE constraint failed/iu,
    );

    await insertTaskRow({
      id: crypto.randomUUID(),
      ownerKind: 'legacy-device',
      deviceId: deviceB,
      cloudAccountId: null,
      cloudDeviceId: null,
      createIdempotencyKey: 'legacy-key',
    });

    expect(
      await findCaptureTaskIdByCreateIdempotencyKey(
        db,
        { kind: 'legacy-device', legacyDeviceId: deviceA },
        'legacy-key',
      ),
    ).toBe(taskId);

    await expectRejection(
      db
        .prepare(
          `INSERT INTO capture_stages
           (task_id, stage, status, retryable, retry_count, updated_at)
           VALUES (?, 'upload', 'running', 1, 0, ?)`,
        )
        .bind(crypto.randomUUID(), now())
        .run(),
      /FOREIGN KEY constraint failed/iu,
    );
  });

  it('publishes owner-kind, shape and account-idempotency schema constraints', async () => {
    const columns = await db
      .prepare('PRAGMA table_info(capture_tasks)')
      .all<{ name: string; notnull: number }>();
    const byName = new Map((columns.results ?? []).map((column) => [column.name, column]));
    expect(byName.get('owner_kind')?.notnull).toBe(1);
    expect(byName.get('device_id')?.notnull).toBe(0);
    expect(byName.get('cloud_account_id')?.notnull).toBe(0);
    expect(byName.get('cloud_device_id')?.notnull).toBe(0);

    const indexes = await db
      .prepare(
        `SELECT name, sql FROM sqlite_schema
         WHERE type = 'index' AND tbl_name = 'capture_tasks'`,
      )
      .all<{ name: string; sql: string | null }>();
    const cloudIndex = (indexes.results ?? []).find(
      (index) => index.name === 'idx_capture_tasks_cloud_account_idempotency',
    );
    expect(cloudIndex?.sql).toContain('UNIQUE');
    expect(cloudIndex?.sql).toContain('cloud_account_id');
    expect(cloudIndex?.sql).toContain("owner_kind = 'cloud-account'");
  });

  it('keeps the legacy device create endpoint and its idempotency behavior', async () => {
    const credential = `legacy-credential-${crypto.randomUUID()}`;
    const deviceId = `legacy-device-${crypto.randomUUID()}`;
    const idempotencyKey = `legacy-create-${crypto.randomUUID()}`;
    const timestamp = now();

    await db
      .prepare(
        `INSERT INTO devices
         (id, credential_hash, user_id, display_name, created_at, last_seen_at)
         VALUES (?, ?, NULL, 'Legacy create device', ?, ?)`,
      )
      .bind(
        deviceId,
        await sha256Hex(`${runtime.DEVICE_AUTH_PEPPER}:${credential}`),
        timestamp,
        timestamp,
      )
      .run();

    const createRequest = (): Request =>
      new Request('https://shiyan.test/v1/capture-tasks', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${credential}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          idempotencyKey,
          title: 'Legacy created task',
          sceneId: 'meeting',
          audio: { contentType: 'audio/mpeg', sizeBytes: 32 },
        }),
      });

    const first = await worker.fetch(createRequest());
    expect(first.status).toBe(201);
    const firstBody = (await first.json()) as {
      data: { task: { id: string; deviceId: string } };
    };
    expect(firstBody.data.task.deviceId).toBe(deviceId);

    const owner = await db
      .prepare(
        `SELECT owner_kind, device_id, cloud_account_id, cloud_device_id
         FROM capture_tasks WHERE id = ?`,
      )
      .bind(firstBody.data.task.id)
      .first<{
        owner_kind: string;
        device_id: string | null;
        cloud_account_id: string | null;
        cloud_device_id: string | null;
      }>();
    expect(owner).toEqual({
      owner_kind: 'legacy-device',
      device_id: deviceId,
      cloud_account_id: null,
      cloud_device_id: null,
    });

    const second = await worker.fetch(createRequest());
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as {
      data: { task: { id: string } };
    };
    expect(secondBody.data.task.id).toBe(firstBody.data.task.id);

    const created = await db
      .prepare(
        `SELECT COUNT(*) AS count FROM capture_tasks
         WHERE device_id = ? AND create_idempotency_key = ?`,
      )
      .bind(deviceId, idempotencyKey)
      .first<{ count: number }>();
    expect(created?.count).toBe(1);
  });
});
