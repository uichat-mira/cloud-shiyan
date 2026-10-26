import { beforeAll, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import {
  findCaptureTaskIdByCreateIdempotencyKey,
  type CaptureTaskOwner,
} from '../../src/shared/captureTaskOwner';

const runtime = env as typeof env & {
  DB: D1Database;
  MIGRATION_DB: D1Database;
  TEST_MIGRATIONS: D1Migration[];
};

const db = runtime.MIGRATION_DB;
const timestamp = '2026-01-02T03:04:05.000Z';
const migrationsTable = 'legacy_migrations';
const ownershipMigration = runtime.TEST_MIGRATIONS.find((migration) =>
  migration.name.startsWith('0006_'),
);

if (!ownershipMigration) {
  throw new Error('0006 capture task ownership migration is missing');
}

const preOwnershipMigrations = runtime.TEST_MIGRATIONS.filter(
  (migration) => Number.parseInt(migration.name, 10) < 6,
);

const seedLegacyData = async (): Promise<void> => {
  await db.batch([
    db
      .prepare(
        `INSERT INTO devices
         (id, credential_hash, user_id, display_name, created_at, last_seen_at)
         VALUES (?, ?, NULL, ?, ?, ?)`,
      )
      .bind('legacy-device-1', 'hash-legacy-device-1', 'Legacy one', timestamp, timestamp),
    db
      .prepare(
        `INSERT INTO devices
         (id, credential_hash, user_id, display_name, created_at, last_seen_at)
         VALUES (?, ?, 'user-legacy-2', ?, ?, ?)`,
      )
      .bind('legacy-device-2', 'hash-legacy-device-2', 'Legacy two', timestamp, timestamp),
    db
      .prepare(
        `INSERT INTO capture_tasks
         (id, device_id, user_id, title, scene_id, lifecycle_status, current_stage,
          create_idempotency_key, correlation_id, created_at, updated_at)
         VALUES (?, ?, NULL, ?, ?, 'ready', 'organize', ?, ?, ?, ?)`,
      )
      .bind(
        'legacy-task-1',
        'legacy-device-1',
        'Legacy task one',
        'meeting',
        'legacy-create-key',
        'legacy-correlation-1',
        timestamp,
        timestamp,
      ),
    db
      .prepare(
        `INSERT INTO capture_tasks
         (id, device_id, user_id, title, scene_id, lifecycle_status, current_stage,
          create_idempotency_key, correlation_id, created_at, updated_at)
         VALUES (?, ?, 'user-legacy-2', ?, ?, 'active', 'upload', ?, ?, ?, ?)`,
      )
      .bind(
        'legacy-task-2',
        'legacy-device-2',
        'Legacy task two',
        'note',
        'legacy-create-key',
        'legacy-correlation-2',
        timestamp,
        timestamp,
      ),
    db
      .prepare(
        `INSERT INTO capture_stages
         (task_id, stage, status, retryable, retry_count, started_at, finished_at, updated_at)
         VALUES (?, 'upload', 'succeeded', 0, 0, ?, ?, ?)`,
      )
      .bind('legacy-task-1', timestamp, timestamp, timestamp),
    db
      .prepare(
        `INSERT INTO capture_stages
         (task_id, stage, status, retryable, retry_count, updated_at)
         VALUES (?, 'verify-audio', 'pending', 1, 0, ?)`,
      )
      .bind('legacy-task-1', timestamp),
    db
      .prepare(
        `INSERT INTO audio_assets
         (id, task_id, object_key, content_type, expected_size_bytes, actual_size_bytes,
          etag, status, upload_expires_at, confirm_idempotency_key, created_at, confirmed_at,
          retained, delete_after)
         VALUES (?, ?, ?, 'audio/mpeg', 1234, 1234, 'etag-legacy-1', 'confirmed',
                 ?, 'legacy-confirm-key', ?, ?, 0, ?)`,
      )
      .bind(
        'legacy-asset-1',
        'legacy-task-1',
        'audio/legacy-task-1/legacy-asset-1',
        timestamp,
        timestamp,
        timestamp,
        '2026-01-05T03:04:05.000Z',
      ),
    db
      .prepare(
        `INSERT INTO transcripts
         (id, task_id, source_asset_id, text, language, duration_ms, provider, model,
          provider_request_id, provider_metadata_json, stt_artifact_key, created_at)
         VALUES (?, ?, ?, ?, 'zh', 5000, 'workers-ai', 'test-stt', 'stt-request-1', '{}', ?, ?)`,
      )
      .bind(
        'legacy-transcript-1',
        'legacy-task-1',
        'legacy-asset-1',
        'Legacy transcript body',
        'audio/legacy-task-1/transcript.json',
        timestamp,
      ),
    db
      .prepare(
        `INSERT INTO transcript_segments
         (transcript_id, segment_index, start_ms, end_ms, text)
         VALUES (?, 0, 0, 2000, ?), (?, 1, 2000, 5000, ?)`,
      )
      .bind(
        'legacy-transcript-1',
        'First segment',
        'legacy-transcript-1',
        'Second segment',
      ),
    db
      .prepare(
        `INSERT INTO drafts
         (id, task_id, kind, version, source, title, markdown, scene_id,
          fallback_used, correlation_id, confirmed_at, created_at, updated_at)
         VALUES (?, ?, 'final', 1, 'user-edit', ?, ?, 'meeting', 0, ?, ?, ?, ?)`,
      )
      .bind(
        'legacy-draft-final-1',
        'legacy-task-1',
        'Legacy final draft',
        '# Final',
        'legacy-correlation-1',
        timestamp,
        timestamp,
        timestamp,
      ),
    db
      .prepare(
        `INSERT INTO delivery_records
         (id, task_id, final_draft_id, destination, idempotency_key, status, retryable,
          retry_count, content_sha256, delivered_at, created_at, updated_at)
         VALUES (?, ?, ?, 'github', 'legacy-delivery-key', 'succeeded', 0, 0, ?, ?, ?, ?)`,
      )
      .bind(
        'legacy-delivery-1',
        'legacy-task-1',
        'legacy-draft-final-1',
        'sha256-legacy',
        timestamp,
        timestamp,
        timestamp,
      ),
  ]);
};

const tableColumns = async (table: string): Promise<string[]> => {
  const result = await db.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>();
  return (result.results ?? []).map((column) => column.name);
};

const snapshotLegacyRows = async (): Promise<Record<string, unknown>> => ({
  tasks: (
    await db
      .prepare(
        `SELECT id, device_id, user_id, title, scene_id, lifecycle_status, current_stage,
                create_idempotency_key, correlation_id, created_at, updated_at
         FROM capture_tasks ORDER BY id`,
      )
      .all()
  ).results,
  stages: (
    await db.prepare('SELECT * FROM capture_stages ORDER BY task_id, stage').all()
  ).results,
  assets: (
    await db.prepare('SELECT * FROM audio_assets ORDER BY id').all()
  ).results,
  transcripts: (
    await db.prepare('SELECT * FROM transcripts ORDER BY id').all()
  ).results,
  segments: (
    await db
      .prepare('SELECT * FROM transcript_segments ORDER BY transcript_id, segment_index')
      .all()
  ).results,
  deliveries: (
    await db.prepare('SELECT * FROM delivery_records ORDER BY id').all()
  ).results,
  drafts: (await db.prepare('SELECT * FROM drafts ORDER BY id').all()).results,
});

beforeAll(async () => {
  await applyD1Migrations(db, preOwnershipMigrations, migrationsTable);
  await seedLegacyData();
});

describe.sequential('CaptureTask ownership migration', () => {
  it('rolls back atomically when a migration statement fails', async () => {
    const before = await snapshotLegacyRows();

    await expect(
      db.batch([
        ...ownershipMigration.queries.map((query) => db.prepare(query)),
        db.prepare('SELECT * FROM table_that_does_not_exist'),
      ]),
    ).rejects.toThrow(/no such table/iu);

    expect(await tableColumns('capture_tasks')).not.toContain('owner_kind');
    expect(await snapshotLegacyRows()).toEqual(before);
  });

  it('preserves pre-migration legacy ownership and all task references', async () => {
    const before = await snapshotLegacyRows();

    await applyD1Migrations(db, [ownershipMigration], migrationsTable);

    const after = await snapshotLegacyRows();
    expect(after).toEqual(before);

    const owners = await db
      .prepare(
        `SELECT id, owner_kind, device_id, cloud_account_id, cloud_device_id
         FROM capture_tasks ORDER BY id`,
      )
      .all<{
        id: string;
        owner_kind: string;
        device_id: string | null;
        cloud_account_id: string | null;
        cloud_device_id: string | null;
      }>();
    expect(owners.results).toEqual([
      {
        id: 'legacy-task-1',
        owner_kind: 'legacy-device',
        device_id: 'legacy-device-1',
        cloud_account_id: null,
        cloud_device_id: null,
      },
      {
        id: 'legacy-task-2',
        owner_kind: 'legacy-device',
        device_id: 'legacy-device-2',
        cloud_account_id: null,
        cloud_device_id: null,
      },
    ]);

    expect(await tableColumns('capture_tasks')).toEqual(
      expect.arrayContaining([
        'owner_kind',
        'device_id',
        'cloud_account_id',
        'cloud_device_id',
      ]),
    );
  });

  it('keeps legacy idempotency and referential integrity after the rebuild', async () => {
    await expect(
      db
        .prepare(
          `INSERT INTO capture_tasks
           (id, owner_kind, device_id, cloud_account_id, cloud_device_id, user_id,
            title, scene_id, create_idempotency_key, correlation_id, created_at, updated_at)
           VALUES (?, 'legacy-device', 'legacy-device-1', NULL, NULL, NULL,
                   'Duplicate', 'meeting', 'legacy-create-key', 'duplicate-correlation', ?, ?)`,
        )
        .bind(crypto.randomUUID(), timestamp, timestamp)
        .run(),
    ).rejects.toThrow(/UNIQUE constraint failed/iu);

    await expect(
      db
        .prepare(
          `INSERT INTO capture_stages
           (task_id, stage, status, retryable, retry_count, updated_at)
           VALUES (?, 'organize', 'pending', 1, 0, ?)`,
        )
        .bind('missing-task', timestamp)
        .run(),
    ).rejects.toThrow(/FOREIGN KEY constraint failed/iu);

    expect(
      await findCaptureTaskIdByCreateIdempotencyKey(
        db,
        { kind: 'legacy-device', legacyDeviceId: 'legacy-device-1' },
        'legacy-create-key',
      ),
    ).toBe('legacy-task-1');
    expect(
      await findCaptureTaskIdByCreateIdempotencyKey(
        db,
        { kind: 'legacy-device', legacyDeviceId: 'legacy-device-2' },
        'legacy-create-key',
      ),
    ).toBe('legacy-task-2');
  });

  it('accepts a new cloud-account task without a legacy device row', async () => {
    const accountId = `account-${crypto.randomUUID()}`;
    const cloudDeviceId = `mira-device-${crypto.randomUUID()}`;
    const taskId = crypto.randomUUID();
    const owner: CaptureTaskOwner = {
      kind: 'cloud-account',
      cloudAccountId: accountId,
      cloudDeviceId,
    };

    await db.batch([
      db
        .prepare(
          `INSERT INTO capture_tasks
           (id, owner_kind, device_id, cloud_account_id, cloud_device_id, user_id,
            title, scene_id, create_idempotency_key, correlation_id, created_at, updated_at)
           VALUES (?, 'cloud-account', NULL, ?, ?, NULL, ?, 'meeting', ?, ?, ?, ?)`,
        )
        .bind(
          taskId,
          accountId,
          cloudDeviceId,
          'Cloud task',
          'cloud-create-key',
          'cloud-correlation',
          timestamp,
          timestamp,
        ),
      db
        .prepare(
          `INSERT INTO capture_stages
           (task_id, stage, status, retryable, retry_count, updated_at)
           VALUES (?, 'upload', 'running', 1, 0, ?)`,
        )
        .bind(taskId, timestamp),
      db
        .prepare(
          `INSERT INTO audio_assets
           (id, task_id, object_key, content_type, status, upload_expires_at, created_at)
           VALUES (?, ?, ?, 'audio/mpeg', 'awaiting_upload', ?, ?)`,
        )
        .bind(`asset-${taskId}`, taskId, `audio/${taskId}`, timestamp, timestamp),
    ]);

    const devices = await db
      .prepare('SELECT COUNT(*) AS count FROM devices WHERE id = ?')
      .bind(cloudDeviceId)
      .first<{ count: number }>();
    expect(devices?.count).toBe(0);

    expect(
      await findCaptureTaskIdByCreateIdempotencyKey(
        db,
        { kind: 'cloud-account', cloudAccountId: accountId, cloudDeviceId: 'same-account-other-device' },
        'cloud-create-key',
      ),
    ).toBe(taskId);

    const references = await db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM capture_stages WHERE task_id = ?) AS stages,
           (SELECT COUNT(*) FROM audio_assets WHERE task_id = ?) AS assets`,
      )
      .bind(taskId, taskId)
      .first<{ stages: number; assets: number }>();
    expect(references).toEqual({ stages: 1, assets: 1 });
  });
});
