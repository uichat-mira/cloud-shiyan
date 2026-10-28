import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { env, exports } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import { resolveOwnedScene } from '../../src/shared/sceneOwner';
import {
  createTestSigningKey,
  shiyanClaims,
  signTestCredential,
  type TestSigningKey,
} from '../helpers/cloud-auth';

const runtime = env as typeof env & {
  DB: D1Database;
  MIGRATION_DB: D1Database;
  TEST_MIGRATIONS: D1Migration[];
  DEVICE_AUTH_PEPPER: string;
  CLOUD_AUTH_JWKS_URL: string;
};

const worker = exports.default as {
  fetch(request: Request): Promise<Response>;
};

const originalFetch = globalThis.fetch;
let signingKey: TestSigningKey;

// These fixtures deliberately share the canonical JWT claim/signing helpers.
const sha256Hex = async (value: string): Promise<string> =>
  Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))),
    (byte) => byte.toString(16).padStart(2, '0'),
  ).join('');

const tokenFor = (
  accountId: string,
  deviceId: string,
  overrides: Record<string, unknown> = {},
): Promise<string> => {
  const issuedAt = Math.floor(Date.now() / 1000);
  const claims = shiyanClaims({
    sub: accountId,
    device_id: deviceId,
    iat: issuedAt,
    nbf: issuedAt,
    exp: issuedAt + 300,
    ...overrides,
  });
  return signTestCredential(claims, signingKey);
};

const scenePayload = (id: string, instruction: string, name = 'Account scene') => ({
  id,
  name,
  instruction,
  sections: [{ id: 'points', title: 'Main points', description: 'Topics worth keeping' }],
});

const sceneRequest = (method: string, token: string, body?: unknown): Request =>
  new Request('https://shiyan.test/v1/scenes', {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const responseJson = async (response: Response): Promise<Record<string, any>> =>
  (await response.json()) as Record<string, any>;

beforeAll(async () => {
  signingKey = await createTestSigningKey('runtime-cloud-scene-key');

  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const raw =
      typeof input === 'string'
        ? input
        : input instanceof Request
          ? input.url
          : String(input);
    if (new URL(raw).href === new URL(runtime.CLOUD_AUTH_JWKS_URL).href) {
      return Promise.resolve(Response.json({ keys: [signingKey.publicJwk] }));
    }
    return originalFetch(input, init);
  }) as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});
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

describe.sequential('SHY-013 Cloud Scene HTTP API', () => {
  const sceneIn = (body: Record<string, any>, id: string) =>
    (body.data?.scenes as Array<Record<string, any>> | undefined)?.find(
      (scene) => scene.id === id,
    );

  it('stores account-owned Scenes idempotently across devices and isolates accounts', async () => {
    const accountA = `cloud-account-${crypto.randomUUID()}`;
    const accountB = `cloud-account-${crypto.randomUUID()}`;
    const deviceA1 = `mira-device-${crypto.randomUUID()}`;
    const deviceA2 = `mira-device-${crypto.randomUUID()}`;
    const deviceB = `mira-device-${crypto.randomUUID()}`;
    const tokenA1 = await tokenFor(accountA, deviceA1);
    const tokenA2 = await tokenFor(accountA, deviceA2);
    const tokenB = await tokenFor(accountB, deviceB);
    const sceneId = `scene-${crypto.randomUUID().slice(0, 8)}`;
    const instructionA = `private-A-${crypto.randomUUID()}`;
    const instructionB = `private-B-${crypto.randomUUID()}`;

    const created = await worker.fetch(
      sceneRequest('POST', tokenA1, scenePayload(sceneId, instructionA)),
    );
    expect(created.status).toBe(201);
    expect(await responseJson(created)).toMatchObject({
      ok: true,
      data: { scene: { id: sceneId, instruction: instructionA, builtIn: false } },
    });

    const replay = await worker.fetch(
      sceneRequest('POST', tokenA1, scenePayload(sceneId, instructionA)),
    );
    expect(replay.status).toBe(200);

    const crossDevice = await worker.fetch(
      sceneRequest('POST', tokenA2, scenePayload(sceneId, instructionA)),
    );
    expect(crossDevice.status).toBe(200);

    const conflict = await worker.fetch(
      sceneRequest('POST', tokenA2, scenePayload(sceneId, instructionA, 'Changed name')),
    );
    expect(conflict.status).toBe(409);
    expect(await responseJson(conflict)).toMatchObject({
      ok: false,
      error: { code: 'scene_id_conflict' },
    });

    const listA2 = await worker.fetch(sceneRequest('GET', tokenA2));
    expect(listA2.status).toBe(200);
    expect(sceneIn(await responseJson(listA2), sceneId)).toMatchObject({
      instruction: instructionA,
      builtIn: false,
    });

    const createdB = await worker.fetch(
      sceneRequest('POST', tokenB, scenePayload(sceneId, instructionB)),
    );
    expect(createdB.status).toBe(201);

    const listB = await responseJson(await worker.fetch(sceneRequest('GET', tokenB)));
    expect(sceneIn(listB, sceneId)).toMatchObject({ instruction: instructionB });
    expect(JSON.stringify(listB)).not.toContain(instructionA);

    const listAAgain = await responseJson(
      await worker.fetch(sceneRequest('GET', tokenA2)),
    );
    expect(sceneIn(listAAgain, sceneId)).toMatchObject({ instruction: instructionA });
    expect(JSON.stringify(listAAgain)).not.toContain(instructionB);

    const legacyRows = await runtime.DB.prepare(
      'SELECT COUNT(*) AS count FROM scenes WHERE id = ?',
    )
      .bind(sceneId)
      .first<{ count: number }>();
    expect(legacyRows?.count).toBe(0);

    const fakeDevices = await runtime.DB.prepare(
      'SELECT COUNT(*) AS count FROM devices WHERE id IN (?, ?, ?)',
    )
      .bind(deviceA1, deviceA2, deviceB)
      .first<{ count: number }>();
    expect(fakeDevices?.count).toBe(0);

    const rows = await runtime.DB.prepare(
      'SELECT cloud_account_id, instruction FROM cloud_scenes WHERE id = ? ORDER BY cloud_account_id ASC',
    )
      .bind(sceneId)
      .all<{ cloud_account_id: string; instruction: string }>();
    expect(rows.results).toEqual(
      expect.arrayContaining([
        { cloud_account_id: accountA, instruction: instructionA },
        { cloud_account_id: accountB, instruction: instructionB },
      ]),
    );
  });

  it('keeps built-ins and reserved ids unchanged and fails closed for wrong audience or scope', async () => {
    const account = `cloud-account-${crypto.randomUUID()}`;
    const device = `mira-device-${crypto.randomUUID()}`;
    const token = await tokenFor(account, device);

    const list = await worker.fetch(sceneRequest('GET', token));
    expect(list.status).toBe(200);
    const listBody = await responseJson(list);
    expect(listBody.data.scenes.map((scene: { id: string }) => scene.id)).toEqual([
      'meeting',
      'quick-note',
      'reflection',
    ]);
    expect(
      listBody.data.scenes.every((scene: { builtIn: boolean }) => scene.builtIn),
    ).toBe(true);

    const reserved = await worker.fetch(
      sceneRequest('POST', token, scenePayload('meeting', 'shadow built-in')),
    );
    expect(reserved.status).toBe(400);
    expect(await responseJson(reserved)).toMatchObject({
      error: { code: 'reserved_scene_id' },
    });

    const invalidId = await worker.fetch(
      sceneRequest('POST', token, scenePayload('Bad Id', 'invalid id')),
    );
    expect(invalidId.status).toBe(400);
    expect(await responseJson(invalidId)).toMatchObject({
      error: { code: 'invalid_scene_id' },
    });

    const relayToken = await tokenFor(account, device, {
      aud: 'mira:cloud-relay-transport',
      scope: ['relay:transport'],
    });
    const relayResponse = await worker.fetch(sceneRequest('GET', relayToken));
    expect(relayResponse.status).toBe(401);
    expect(await responseJson(relayResponse)).toMatchObject({
      error: { code: 'cloud_credential_unauthorized' },
    });

    const wrongScopeToken = await tokenFor(account, device, {
      scope: ['relay:transport'],
    });
    const wrongScopeResponse = await worker.fetch(
      sceneRequest('GET', wrongScopeToken),
    );
    expect(wrongScopeResponse.status).toBe(401);
    expect(await responseJson(wrongScopeResponse)).toMatchObject({
      error: { code: 'cloud_credential_unauthorized' },
    });
  });

  it('keeps legacy Scene create/list on the legacy table and isolated from Cloud accounts', async () => {
    const credential = `legacy-scene-credential-${crypto.randomUUID()}`;
    const deviceId = `legacy-scene-device-${crypto.randomUUID()}`;
    const timestamp = new Date().toISOString();
    await runtime.DB.prepare(
      `INSERT INTO devices
       (id, credential_hash, user_id, display_name, created_at, last_seen_at)
       VALUES (?, ?, NULL, ?, ?, ?)`,
    )
      .bind(
        deviceId,
        await sha256Hex(`${runtime.DEVICE_AUTH_PEPPER}:${credential}`),
        'Legacy Scene device',
        timestamp,
        timestamp,
      )
      .run();

    const sceneId = `scene-${crypto.randomUUID().slice(0, 8)}`;
    const legacyInstruction = `legacy-private-${crypto.randomUUID()}`;
    const legacyCreate = await worker.fetch(
      sceneRequest('POST', credential, scenePayload(sceneId, legacyInstruction)),
    );
    expect(legacyCreate.status).toBe(201);

    const legacyList = await responseJson(
      await worker.fetch(sceneRequest('GET', credential)),
    );
    expect(sceneIn(legacyList, sceneId)).toMatchObject({
      instruction: legacyInstruction,
      builtIn: false,
    });

    const account = `cloud-account-${crypto.randomUUID()}`;
    const cloudDevice = `mira-device-${crypto.randomUUID()}`;
    const cloudInstruction = `cloud-private-${crypto.randomUUID()}`;
    const cloudToken = await tokenFor(account, cloudDevice);
    const cloudCreate = await worker.fetch(
      sceneRequest('POST', cloudToken, scenePayload(sceneId, cloudInstruction)),
    );
    expect(cloudCreate.status).toBe(201);

    const cloudList = await responseJson(
      await worker.fetch(sceneRequest('GET', cloudToken)),
    );
    expect(sceneIn(cloudList, sceneId)).toMatchObject({ instruction: cloudInstruction });
    expect(JSON.stringify(cloudList)).not.toContain(legacyInstruction);

    const legacyListAgain = await responseJson(
      await worker.fetch(sceneRequest('GET', credential)),
    );
    expect(sceneIn(legacyListAgain, sceneId)).toMatchObject({
      instruction: legacyInstruction,
    });
    expect(JSON.stringify(legacyListAgain)).not.toContain(cloudInstruction);

    const legacyRow = await runtime.DB.prepare(
      'SELECT device_id, instruction FROM scenes WHERE id = ?',
    )
      .bind(sceneId)
      .first<{ device_id: string; instruction: string }>();
    expect(legacyRow).toEqual({ device_id: deviceId, instruction: legacyInstruction });

    const cloudRow = await runtime.DB.prepare(
      'SELECT cloud_account_id, instruction FROM cloud_scenes WHERE id = ?',
    )
      .bind(sceneId)
      .first<{ cloud_account_id: string; instruction: string }>();
    expect(cloudRow).toEqual({
      cloud_account_id: account,
      instruction: cloudInstruction,
    });

    const fakeDevice = await runtime.DB.prepare(
      'SELECT COUNT(*) AS count FROM devices WHERE id = ?',
    )
      .bind(cloudDevice)
      .first<{ count: number }>();
    expect(fakeDevice?.count).toBe(0);
  });
});
