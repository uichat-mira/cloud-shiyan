import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { env, exports } from 'cloudflare:workers';
import {
  createTestSigningKey,
  shiyanClaims,
  signTestCredential,
  type TestSigningKey,
} from '../helpers/cloud-auth';

const runtime = env as typeof env & {
  DB: D1Database;
  DEVICE_AUTH_PEPPER: string;
  CLOUD_AUTH_JWKS_URL: string;
};

const worker = exports.default as {
  fetch(request: Request): Promise<Response>;
};

const originalFetch = globalThis.fetch;
let key: TestSigningKey;

const currentSeconds = (): number => Math.floor(Date.now() / 1000);

const sha256Hex = async (value: string): Promise<string> => {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
};

const tokenFor = async (
  accountId: string,
  deviceId: string,
  overrides: Record<string, unknown> = {},
): Promise<string> =>
  signTestCredential(
    shiyanClaims({
      sub: accountId,
      device_id: deviceId,
      iat: currentSeconds(),
      nbf: currentSeconds(),
      exp: currentSeconds() + 300,
      ...overrides,
    }),
    key,
  );

const requestWith = (path: string, token: string): Request =>
  new Request(`https://shiyan.test${path}`, {
    headers: { authorization: `Bearer ${token}` },
  });

const createRequest = (
  token: string,
  idempotencyKey: string,
  title = 'Cloud-owned task',
): Request =>
  new Request('https://shiyan.test/v1/capture-tasks', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      idempotencyKey,
      title,
      sceneId: 'meeting',
      audio: { contentType: 'audio/mpeg', sizeBytes: 32 },
    }),
  });

const responseJson = async (response: Response): Promise<Record<string, any>> =>
  (await response.json()) as Record<string, any>;

type OwnerRow = {
  owner_kind: string;
  device_id: string | null;
  cloud_account_id: string | null;
  cloud_device_id: string | null;
};

const readOwner = async (taskId: string): Promise<OwnerRow | null> =>
  runtime.DB.prepare(
    `SELECT owner_kind, device_id, cloud_account_id, cloud_device_id
     FROM capture_tasks WHERE id = ?`,
  )
    .bind(taskId)
    .first<OwnerRow>();

const seedLegacyTask = async (
  credential: string,
): Promise<{ deviceId: string; taskId: string }> => {
  const deviceId = `legacy-device-${crypto.randomUUID()}`;
  const taskId = crypto.randomUUID();
  const timestamp = new Date().toISOString();

  await runtime.DB.prepare(
    `INSERT INTO devices
     (id, credential_hash, user_id, display_name, created_at, last_seen_at)
     VALUES (?, ?, NULL, ?, ?, ?)`,
  )
    .bind(
      deviceId,
      await sha256Hex(`${runtime.DEVICE_AUTH_PEPPER}:${credential}`),
      'Legacy isolation device',
      timestamp,
      timestamp,
    )
    .run();

  await runtime.DB.prepare(
    `INSERT INTO capture_tasks
     (id, owner_kind, device_id, cloud_account_id, cloud_device_id, user_id,
      title, scene_id, lifecycle_status, current_stage,
      create_idempotency_key, correlation_id, created_at, updated_at)
     VALUES (?, 'legacy-device', ?, NULL, NULL, NULL, ?, 'meeting', 'active',
             'upload', ?, ?, ?, ?)`,
  )
    .bind(
      taskId,
      deviceId,
      'Legacy owned task',
      `legacy-${taskId}`,
      `corr-${taskId}`,
      timestamp,
      timestamp,
    )
    .run();

  return { deviceId, taskId };
};

beforeAll(async () => {
  key = await createTestSigningKey('runtime-cloud-capture-key');

  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const raw =
      typeof input === 'string'
        ? input
        : input instanceof Request
          ? input.url
          : String(input);
    if (new URL(raw).href === new URL(runtime.CLOUD_AUTH_JWKS_URL).href) {
      return Promise.resolve(Response.json({ keys: [key.publicJwk] }));
    }
    return originalFetch(input, init);
  }) as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

describe('Cloud account-owned CaptureTask routes', () => {
  it('creates and reads an account-owned task without a legacy device row', async () => {
    const accountId = `cloud-account-${crypto.randomUUID()}`;
    const deviceId = `mira-device-${crypto.randomUUID()}`;
    const idempotencyKey = `cloud-create-${crypto.randomUUID()}`;
    const token = await tokenFor(accountId, deviceId);

    const created = await worker.fetch(createRequest(token, idempotencyKey));
    expect(created.status).toBe(201);
    const createdBody = await responseJson(created);
    expect(createdBody).toMatchObject({ ok: true, data: { task: { sceneId: 'meeting' } } });

    const task = createdBody.data.task as {
      id: string;
      deviceId: string;
      userId: string | null;
      stages: Array<{ stage: string }>;
    };
    expect(task.deviceId).toBe(deviceId);
    expect(task.userId).toBeNull();
    expect(task.stages.map((stage) => stage.stage)).toEqual(['upload']);

    const upload = createdBody.data.upload as {
      assetId: string;
      objectKey: string;
      method: string;
      url: string;
    };
    expect(upload.method).toBe('PUT');
    expect(upload.url.length).toBeGreaterThan(0);
    expect(upload.objectKey).toBe(`audio/ephemeral/${task.id}/${upload.assetId}`);

    expect(await readOwner(task.id)).toEqual({
      owner_kind: 'cloud-account',
      device_id: null,
      cloud_account_id: accountId,
      cloud_device_id: deviceId,
    });

    const deviceRows = await runtime.DB.prepare(
      'SELECT COUNT(*) AS count FROM devices WHERE id = ?',
    )
      .bind(deviceId)
      .first<{ count: number }>();
    expect(deviceRows?.count).toBe(0);

    const read = await worker.fetch(
      requestWith(`/v1/capture-tasks/${task.id}`, token),
    );
    expect(read.status).toBe(200);
    expect(await responseJson(read)).toMatchObject({
      ok: true,
      data: { task: { id: task.id, deviceId, userId: null } },
    });
  });

  it('shares one idempotent create result across two devices of the same account without rewriting the creator device', async () => {
    const accountId = `cloud-account-${crypto.randomUUID()}`;
    const creatorDevice = `mira-device-${crypto.randomUUID()}`;
    const secondDevice = `mira-device-${crypto.randomUUID()}`;
    const idempotencyKey = `cloud-create-${crypto.randomUUID()}`;

    const first = await worker.fetch(
      createRequest(await tokenFor(accountId, creatorDevice), idempotencyKey, 'First'),
    );
    expect(first.status).toBe(201);
    const firstBody = await responseJson(first);
    const taskId = firstBody.data.task.id as string;
    const firstAssetId = firstBody.data.upload.assetId as string;

    const second = await worker.fetch(
      createRequest(await tokenFor(accountId, secondDevice), idempotencyKey, 'Second'),
    );
    expect(second.status).toBe(200);
    const secondBody = await responseJson(second);
    expect(secondBody.data.task.id).toBe(taskId);
    expect(secondBody.data.task.deviceId).toBe(creatorDevice);
    expect(secondBody.data.upload.assetId).toBe(firstAssetId);
    expect(await readOwner(taskId)).toMatchObject({
      device_id: null,
      cloud_account_id: accountId,
      cloud_device_id: creatorDevice,
    });

    const rows = await runtime.DB.prepare(
      `SELECT COUNT(*) AS count FROM capture_tasks
       WHERE cloud_account_id = ? AND create_idempotency_key = ?`,
    )
      .bind(accountId, idempotencyKey)
      .first<{ count: number }>();
    expect(rows?.count).toBe(1);

    const read = await worker.fetch(
      requestWith(
        `/v1/capture-tasks/${taskId}`,
        await tokenFor(accountId, secondDevice),
      ),
    );
    expect(read.status).toBe(200);
    expect(await responseJson(read)).toMatchObject({
      ok: true,
      data: { task: { id: taskId, deviceId: creatorDevice } },
    });
  });

  it('keeps accounts, unknown ids and legacy tasks non-disclosing to each other', async () => {
    const accountA = `cloud-account-${crypto.randomUUID()}`;
    const accountB = `cloud-account-${crypto.randomUUID()}`;
    const deviceA = `mira-device-${crypto.randomUUID()}`;
    const deviceB = `mira-device-${crypto.randomUUID()}`;
    const sharedKey = `cloud-create-${crypto.randomUUID()}`;

    const createdA = await worker.fetch(
      createRequest(await tokenFor(accountA, deviceA), sharedKey, 'Account A task'),
    );
    expect(createdA.status).toBe(201);
    const bodyA = await responseJson(createdA);
    const taskA = bodyA.data.task as { id: string };
    const assetA = bodyA.data.upload as { assetId: string; objectKey: string };

    const createdB = await worker.fetch(
      createRequest(await tokenFor(accountB, deviceB), sharedKey, 'Account B task'),
    );
    expect(createdB.status).toBe(201);
    const bodyB = await responseJson(createdB);
    const taskB = bodyB.data.task as { id: string };
    const assetB = bodyB.data.upload as { assetId: string; objectKey: string };

    expect(taskB.id).not.toBe(taskA.id);
    expect(assetB.assetId).not.toBe(assetA.assetId);
    expect(assetB.objectKey).not.toBe(assetA.objectKey);

    const tokenA = await tokenFor(accountA, deviceA);
    const tokenB = await tokenFor(accountB, deviceB);

    const bReadsA = await worker.fetch(
      requestWith(`/v1/capture-tasks/${taskA.id}`, tokenB),
    );
    expect(bReadsA.status).toBe(404);
    expect(await responseJson(bReadsA)).toMatchObject({
      ok: false,
      error: { code: 'task_not_found', retryable: false },
    });

    const aReadsB = await worker.fetch(
      requestWith(`/v1/capture-tasks/${taskB.id}`, tokenA),
    );
    expect(aReadsB.status).toBe(404);
    expect(await responseJson(aReadsB)).toMatchObject({
      ok: false,
      error: { code: 'task_not_found' },
    });

    const unknown = await worker.fetch(
      requestWith(`/v1/capture-tasks/${crypto.randomUUID()}`, tokenA),
    );
    expect(unknown.status).toBe(404);
    expect(await responseJson(unknown)).toMatchObject({
      ok: false,
      error: { code: 'task_not_found' },
    });

    const legacyCredential = `legacy-credential-${crypto.randomUUID()}`;
    const legacy = await seedLegacyTask(legacyCredential);

    const aReadsLegacy = await worker.fetch(
      requestWith(`/v1/capture-tasks/${legacy.taskId}`, tokenA),
    );
    expect(aReadsLegacy.status).toBe(404);
    expect(await responseJson(aReadsLegacy)).toMatchObject({
      ok: false,
      error: { code: 'task_not_found' },
    });

    const legacyReadsOwn = await worker.fetch(
      requestWith(`/v1/capture-tasks/${legacy.taskId}`, legacyCredential),
    );
    expect(legacyReadsOwn.status).toBe(200);
    expect(await responseJson(legacyReadsOwn)).toMatchObject({
      ok: true,
      data: { task: { id: legacy.taskId, deviceId: legacy.deviceId } },
    });

    const legacyReadsCloud = await worker.fetch(
      requestWith(`/v1/capture-tasks/${taskA.id}`, legacyCredential),
    );
    expect(legacyReadsCloud.status).toBe(404);
    expect(await responseJson(legacyReadsCloud)).toMatchObject({
      ok: false,
      error: { code: 'task_not_found' },
    });
  });

  it('converges duplicate racing create calls on one account-owned task', async () => {
    const accountId = `cloud-account-${crypto.randomUUID()}`;
    const deviceOne = `mira-device-${crypto.randomUUID()}`;
    const deviceTwo = `mira-device-${crypto.randomUUID()}`;
    const idempotencyKey = `cloud-race-${crypto.randomUUID()}`;
    const tokenOne = await tokenFor(accountId, deviceOne);
    const tokenTwo = await tokenFor(accountId, deviceTwo);

    const responses = await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        worker.fetch(
          createRequest(
            index % 2 === 0 ? tokenOne : tokenTwo,
            idempotencyKey,
            `Race ${index}`,
          ),
        ),
      ),
    );

    const statuses = responses.map((response) => response.status);
    expect(statuses.every((status) => status === 200 || status === 201)).toBe(true);

    const bodies = await Promise.all(responses.map(responseJson));
    const taskIds = new Set(bodies.map((body) => body.data.task.id));
    const assetIds = new Set(bodies.map((body) => body.data.upload.assetId));
    expect(taskIds.size).toBe(1);
    expect(assetIds.size).toBe(1);

    const [taskId] = [...taskIds];
    const rows = await runtime.DB.prepare(
      `SELECT COUNT(*) AS count FROM capture_tasks
       WHERE cloud_account_id = ? AND create_idempotency_key = ?`,
    )
      .bind(accountId, idempotencyKey)
      .first<{ count: number }>();
    expect(rows?.count).toBe(1);

    const owner = await readOwner(taskId);
    expect(owner?.owner_kind).toBe('cloud-account');
    expect(owner?.device_id).toBeNull();
    expect(owner?.cloud_account_id).toBe(accountId);
    expect([deviceOne, deviceTwo]).toContain(owner?.cloud_device_id);
  });

  it('rejects wrong audience, wrong scope and missing credentials before creating a task', async () => {
    const accountId = `cloud-account-${crypto.randomUUID()}`;
    const deviceId = `mira-device-${crypto.randomUUID()}`;
    const idempotencyKey = `cloud-reject-${crypto.randomUUID()}`;

    const wrongAudience = await worker.fetch(
      createRequest(
        await tokenFor(accountId, deviceId, { aud: 'mira:cloud-relay-transport' }),
        idempotencyKey,
      ),
    );
    expect(wrongAudience.status).toBe(401);
    expect(await responseJson(wrongAudience)).toMatchObject({
      ok: false,
      error: { code: 'cloud_credential_unauthorized' },
    });

    const wrongScope = await worker.fetch(
      createRequest(
        await tokenFor(accountId, deviceId, { scope: ['relay:transport'] }),
        idempotencyKey,
      ),
    );
    expect(wrongScope.status).toBe(401);
    expect(await responseJson(wrongScope)).toMatchObject({
      ok: false,
      error: { code: 'cloud_credential_unauthorized' },
    });

    const missing = await worker.fetch(
      new Request('https://shiyan.test/v1/capture-tasks', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          idempotencyKey,
          title: 'No credential',
          sceneId: 'meeting',
          audio: { contentType: 'audio/mpeg' },
        }),
      }),
    );
    expect(missing.status).toBe(401);
    expect(await responseJson(missing)).toMatchObject({
      ok: false,
      error: { code: 'device_unauthorized' },
    });

    const rows = await runtime.DB.prepare(
      'SELECT COUNT(*) AS count FROM capture_tasks WHERE create_idempotency_key = ?',
    )
      .bind(idempotencyKey)
      .first<{ count: number }>();
    expect(rows?.count).toBe(0);
  });
});
