import { beforeAll, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import { resolveOwnedScene } from '../../src/shared/sceneOwner';

const runtime = env as typeof env & {
  DB: D1Database;
  MIGRATION_DB: D1Database;
  TEST_MIGRATIONS: D1Migration[];
};
const timestamp = '2026-10-29T00:00:00.000Z';
const sections = JSON.stringify([
  { id: 'points', title: 'Main points', description: 'Topics worth keeping' },
]);
const owner = (account: string, device = 'cloud-device-1') => ({
  kind: 'cloud-account' as const,
  cloudAccountId: account,
  cloudDeviceId: device,
});
const legacyOwner = { kind: 'legacy-device' as const, legacyDeviceId: 'legacy-scene-device' };

async function addScene(db: D1Database, account: string, sceneId: string, instruction: string, sectionsJson = sections): Promise<void> {
  await db.prepare(
    `INSERT INTO cloud_scenes
     (cloud_account_id, id, name, instruction, sections_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).bind(account, sceneId, 'Custom', instruction, sectionsJson, timestamp, timestamp).run();
}

describe('SHY-012 fresh D1 Scene ownership', () => {
  it('keeps independent account custom scenes even when ids collide, with same-account cross-device lookup', async () => {
    const id = `scene-${crypto.randomUUID().slice(0, 8)}`;
    const accA = `account-${crypto.randomUUID()}`;
    const accB = `account-${crypto.randomUUID()}`;
    await addScene(runtime.DB, accA, id, 'private-A');
    await addScene(runtime.DB, accB, id, 'private-B');
    expect((await resolveOwnedScene(runtime.DB, owner(accA), id))?.instruction).toBe('private-A');
    expect((await resolveOwnedScene(runtime.DB, owner(accA, 'cloud-device-2'), id))?.instruction).toBe('private-A');
    expect((await resolveOwnedScene(runtime.DB, owner(accB), id))?.instruction).toBe('private-B');
    expect(await resolveOwnedScene(runtime.DB, owner('foreign-account'), id)).toBeNull();
    expect(await resolveOwnedScene(runtime.DB, { kind: 'legacy-device', legacyDeviceId: accA }, id)).toBeNull();
    await expect(addScene(runtime.DB, accA, id, 'overwrite')).rejects.toThrow(/UNIQUE constraint failed/iu);
    expect((await resolveOwnedScene(runtime.DB, owner(accA), id))?.instruction).toBe('private-A');
  });

  it('prioritizes built-ins, fails closed for invalid custom definitions, and creates no fake devices', async () => {
    const account = `account-${crypto.randomUUID()}`;
    const id = `scene-${crypto.randomUUID().slice(0, 8)}`;
    await addScene(runtime.DB, account, 'meeting', 'malicious-shadow');
    await addScene(runtime.DB, account, id, 'bad-prompt', '{bad');
    expect((await resolveOwnedScene(runtime.DB, owner(account), 'meeting'))?.name).toBe('会议采集');
    expect(await resolveOwnedScene(runtime.DB, owner(account), id)).toBeNull();
    expect(await resolveOwnedScene(runtime.DB, owner(account), 'not-there')).toBeNull();
    const device = await runtime.DB.prepare('SELECT COUNT(*) AS count FROM devices WHERE id = ?')
      .bind('cloud-device-1').first<{ count: number }>();
    expect(device?.count).toBe(0);
    const idx = await runtime.DB.prepare(
      "SELECT sql FROM sqlite_schema WHERE name = 'idx_cloud_scenes_account_created'",
    ).first<{ sql: string }>();
    expect(idx?.sql).toContain('cloud_account_id');
    await expect(addScene(runtime.DB, '  ', 'bad-account', 'no')).rejects.toThrow(/CHECK constraint failed/iu);
  });
});

describe.sequential('SHY-012 populated legacy D1 migration', () => {
  const db = runtime.MIGRATION_DB;
  const migrationTable = 'scene_migrations';
  const before7 = runtime.TEST_MIGRATIONS.filter(m => Number.parseInt(m.name, 10) < 7);
  const sceneMigration = runtime.TEST_MIGRATIONS.find(m => m.name.startsWith('0007_'));
  if (!sceneMigration) throw new Error('0007 Cloud Scene migration missing');

  beforeAll(async () => {
    await applyD1Migrations(db, before7, migrationTable);
    await db.prepare(
      `INSERT INTO devices
       (id, credential_hash, display_name, created_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).bind(legacyOwner.legacyDeviceId, 'hash-scene-legacy', 'Legacy', timestamp, timestamp).run();
    await db.prepare(
      `INSERT INTO scenes
       (id, device_id, user_id, name, instruction, sections_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind('custom-legacy', legacyOwner.legacyDeviceId, null, 'Legacy scene', 'Legacy private text', sections, timestamp, timestamp).run();
    await db.prepare(
      `INSERT INTO capture_tasks
       (id, owner_kind, device_id, cloud_account_id, cloud_device_id, title, scene_id,
        create_idempotency_key, correlation_id, created_at, updated_at)
       VALUES (?, 'legacy-device', ?, NULL, NULL, ?, ?, ?, ?, ?, ?)`,
    ).bind('legacy-scene-task', legacyOwner.legacyDeviceId, 'History', 'custom-legacy', 'legacy-scene-create', 'legacy-scene-corr', timestamp, timestamp).run();
  });

  it('preserves legacy scene rows and task references while adding Cloud Scene table', async () => {
    const beforeScenes = (await db.prepare('SELECT * FROM scenes ORDER BY id').all()).results;
    const beforeTasks = (await db.prepare('SELECT * FROM capture_tasks ORDER BY id').all()).results;
    const oldSceneFk = (await db.prepare('PRAGMA foreign_key_list(scenes)').all()).results;
    expect(oldSceneFk).toEqual(expect.arrayContaining([expect.objectContaining({ table: 'devices', from: 'device_id' })]));

    await applyD1Migrations(db, [sceneMigration], migrationTable);

    expect((await db.prepare('SELECT * FROM scenes ORDER BY id').all()).results).toEqual(beforeScenes);
    expect((await db.prepare('SELECT * FROM capture_tasks ORDER BY id').all()).results).toEqual(beforeTasks);
    expect((await db.prepare('PRAGMA foreign_key_list(scenes)').all()).results).toEqual(oldSceneFk);
    expect((await resolveOwnedScene(db, legacyOwner, 'custom-legacy'))?.instruction).toBe('Legacy private text');

    await addScene(db, 'cloud-account-a', 'custom-legacy', 'Cloud text A');
    await addScene(db, 'cloud-account-b', 'custom-legacy', 'Cloud text B');
    expect((await resolveOwnedScene(db, owner('cloud-account-a'), 'custom-legacy'))?.instruction).toBe('Cloud text A');
    expect((await resolveOwnedScene(db, owner('cloud-account-b'), 'custom-legacy'))?.instruction).toBe('Cloud text B');
    expect((await resolveOwnedScene(db, legacyOwner, 'custom-legacy'))?.instruction).toBe('Legacy private text');

    const legacyDevices = await db.prepare('SELECT COUNT(*) AS count FROM devices').first<{ count: number }>();
    expect(legacyDevices?.count).toBe(1);
    const foreignKeys = (await db.prepare('PRAGMA foreign_key_check').all()).results ?? [];
    expect(foreignKeys).toEqual([]);
    await expect(
      db.prepare(
        `INSERT INTO scenes
         (id, device_id, name, instruction, sections_json, created_at, updated_at)
         VALUES ('bad-fk', 'unknown-device', 'Missing', 'Nope', ?, ?, ?)`,
      ).bind(sections, timestamp, timestamp).run(),
    ).rejects.toThrow(/FOREIGN KEY constraint failed/iu);
  });
});
