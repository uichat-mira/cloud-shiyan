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
  AUDIO: R2Bucket;
  CAPTURE_WORKFLOW: { get(id: string): Promise<unknown> };
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

const seedLegacyDevice = async (credential: string): Promise<string> => {
  const deviceId = `legacy-device-${crypto.randomUUID()}`;
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

  return deviceId;
};

const seedLegacyTask = async (
  credential: string,
): Promise<{ deviceId: string; taskId: string }> => {
  const deviceId = await seedLegacyDevice(credential);
  const taskId = crypto.randomUUID();
  const timestamp = new Date().toISOString();

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

type CreatedCaptureTask = {
  taskId: string;
  assetId: string;
  objectKey: string;
};

const createOwnedTask = async (
  token: string,
  title = 'Cloud audio task',
): Promise<CreatedCaptureTask> => {
  const response = await worker.fetch(
    createRequest(token, `cloud-audio-${crypto.randomUUID()}`, title),
  );
  expect(response.status).toBe(201);
  const body = await responseJson(response);
  return {
    taskId: body.data.task.id as string,
    assetId: body.data.upload.assetId as string,
    objectKey: body.data.upload.objectKey as string,
  };
};

const uploadAudio = async (
  objectKey: string,
  options: { contentType?: string; sizeBytes?: number } = {},
): Promise<void> => {
  await runtime.AUDIO.put(objectKey, new Uint8Array(options.sizeBytes ?? 32), {
    httpMetadata: { contentType: options.contentType ?? 'audio/mpeg' },
  });
};

const confirmAudioRequest = (
  token: string,
  taskId: string,
  assetId: string,
  idempotencyKey = `confirm-${crypto.randomUUID()}`,
): Request =>
  new Request(`https://shiyan.test/v1/capture-tasks/${taskId}/audio/confirm`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ assetId, idempotencyKey }),
  });

const retentionRequest = (
  token: string,
  taskId: string,
  retained: boolean,
  method = 'PUT',
): Request =>
  new Request(`https://shiyan.test/v1/capture-tasks/${taskId}/audio/retention`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ retained }),
  });

type AudioAssetState = {
  status: string;
  actual_size_bytes: number | null;
  retained: number;
  delete_after: string | null;
  deleted_at: string | null;
  confirm_idempotency_key: string | null;
};

const readAudioAsset = async (taskId: string): Promise<AudioAssetState | null> =>
  runtime.DB.prepare(
    `SELECT status, actual_size_bytes, retained, delete_after, deleted_at,
            confirm_idempotency_key
     FROM audio_assets WHERE task_id = ? ORDER BY created_at ASC LIMIT 1`,
  )
    .bind(taskId)
    .first<AudioAssetState>();

const captureWorkflowExists = async (taskId: string): Promise<boolean> => {
  try {
    await runtime.CAPTURE_WORKFLOW.get(`capture-${taskId}`);
    return true;
  } catch {
    return false;
  }
};

describe('Cloud-owned audio confirmation and retention', () => {
  it('confirms, idempotently replays and sets retention for the owning account', async () => {
    const accountId = `cloud-account-${crypto.randomUUID()}`;
    const deviceId = `mira-device-${crypto.randomUUID()}`;
    const token = await tokenFor(accountId, deviceId);
    const created = await createOwnedTask(token);

    await uploadAudio(created.objectKey);

    const idempotencyKey = `confirm-${crypto.randomUUID()}`;
    const confirmed = await worker.fetch(
      confirmAudioRequest(token, created.taskId, created.assetId, idempotencyKey),
    );
    expect(confirmed.status).toBe(200);
    const confirmedBody = await responseJson(confirmed);
    expect(confirmedBody.ok).toBe(true);

    const stages = confirmedBody.data.task.stages as Array<{
      stage: string;
      status: string;
    }>;
    expect(stages.find((stage) => stage.stage === 'upload')?.status).toBe('succeeded');
    expect(stages.some((stage) => stage.stage === 'verify-audio')).toBe(true);

    expect(await readAudioAsset(created.taskId)).toMatchObject({
      status: 'confirmed',
      actual_size_bytes: 32,
      confirm_idempotency_key: idempotencyKey,
      deleted_at: null,
    });
    expect(await captureWorkflowExists(created.taskId)).toBe(true);

    const replay = await worker.fetch(
      confirmAudioRequest(token, created.taskId, created.assetId, idempotencyKey),
    );
    expect(replay.status).toBe(200);

    const conflict = await worker.fetch(
      confirmAudioRequest(token, created.taskId, created.assetId, 'other-key'),
    );
    expect(conflict.status).toBe(409);
    expect(await responseJson(conflict)).toMatchObject({
      ok: false,
      error: { code: 'asset_already_confirmed' },
    });

    const retained = await worker.fetch(
      retentionRequest(token, created.taskId, true),
    );
    expect(retained.status).toBe(200);
    const retainedBody = await responseJson(retained);
    expect(retainedBody).toMatchObject({
      ok: true,
      data: { assetId: created.assetId, retained: true, deletedAt: null },
    });
    expect(retainedBody.data.deleteAfter).toEqual(expect.any(String));
    expect((await readAudioAsset(created.taskId))?.retained).toBe(1);

    const released = await worker.fetch(
      retentionRequest(token, created.taskId, false),
    );
    expect(released.status).toBe(200);
    expect(await responseJson(released)).toMatchObject({
      ok: true,
      data: { retained: false },
    });
    expect((await readAudioAsset(created.taskId))?.retained).toBe(0);
  });

  it('lets another device of the same account confirm and retain the task', async () => {
    const accountId = `cloud-account-${crypto.randomUUID()}`;
    const creatorDevice = `mira-device-${crypto.randomUUID()}`;
    const secondDevice = `mira-device-${crypto.randomUUID()}`;
    const created = await createOwnedTask(
      await tokenFor(accountId, creatorDevice),
    );
    await uploadAudio(created.objectKey);

    const secondToken = await tokenFor(accountId, secondDevice);
    const confirmed = await worker.fetch(
      confirmAudioRequest(secondToken, created.taskId, created.assetId),
    );
    expect(confirmed.status).toBe(200);
    expect(await responseJson(confirmed)).toMatchObject({
      ok: true,
      data: { task: { id: created.taskId, deviceId: creatorDevice } },
    });

    const retained = await worker.fetch(
      retentionRequest(secondToken, created.taskId, true),
    );
    expect(retained.status).toBe(200);
  });

  it('denies foreign accounts, unknown ids, legacy tasks and wrong asset pairing without mutation', async () => {
    const accountA = `cloud-account-${crypto.randomUUID()}`;
    const accountB = `cloud-account-${crypto.randomUUID()}`;
    const tokenA = await tokenFor(accountA, `mira-device-${crypto.randomUUID()}`);
    const tokenB = await tokenFor(accountB, `mira-device-${crypto.randomUUID()}`);

    const taskA = await createOwnedTask(tokenA, 'Account A audio');
    const taskA2 = await createOwnedTask(tokenA, 'Account A second audio');
    await uploadAudio(taskA.objectKey);

    const foreignConfirm = await worker.fetch(
      confirmAudioRequest(tokenB, taskA.taskId, taskA.assetId),
    );
    expect(foreignConfirm.status).toBe(404);
    expect(await responseJson(foreignConfirm)).toMatchObject({
      ok: false,
      error: { code: 'task_not_found', retryable: false },
    });

    const foreignRetention = await worker.fetch(
      retentionRequest(tokenB, taskA.taskId, true),
    );
    expect(foreignRetention.status).toBe(404);
    expect(await responseJson(foreignRetention)).toMatchObject({
      ok: false,
      error: { code: 'task_not_found' },
    });

    const foreignAsset = await worker.fetch(
      confirmAudioRequest(tokenA, taskA.taskId, crypto.randomUUID()),
    );
    expect(foreignAsset.status).toBe(404);
    expect(await responseJson(foreignAsset)).toMatchObject({
      ok: false,
      error: { code: 'asset_not_found' },
    });

    const wrongPairing = await worker.fetch(
      confirmAudioRequest(tokenA, taskA.taskId, taskA2.assetId),
    );
    expect(wrongPairing.status).toBe(404);
    expect(await responseJson(wrongPairing)).toMatchObject({
      ok: false,
      error: { code: 'asset_not_found' },
    });

    for (const target of [crypto.randomUUID(), taskA.taskId]) {
      const unknownConfirm = await worker.fetch(
        confirmAudioRequest(tokenA, target, crypto.randomUUID()),
      );
      expect(unknownConfirm.status).toBe(404);
    }

    const unknownRetention = await worker.fetch(
      retentionRequest(tokenA, crypto.randomUUID(), true),
    );
    expect(unknownRetention.status).toBe(404);

    const legacyCredential = `legacy-credential-${crypto.randomUUID()}`;
    const legacy = await seedLegacyTask(legacyCredential);
    const cloudConfirmLegacy = await worker.fetch(
      confirmAudioRequest(tokenA, legacy.taskId, crypto.randomUUID()),
    );
    expect(cloudConfirmLegacy.status).toBe(404);
    expect(await responseJson(cloudConfirmLegacy)).toMatchObject({
      ok: false,
      error: { code: 'task_not_found' },
    });
    const cloudRetentionLegacy = await worker.fetch(
      retentionRequest(tokenA, legacy.taskId, true),
    );
    expect(cloudRetentionLegacy.status).toBe(404);

    expect(await readAudioAsset(taskA.taskId)).toMatchObject({
      status: 'awaiting_upload',
      retained: 0,
      confirm_idempotency_key: null,
    });
    expect(await captureWorkflowExists(taskA.taskId)).toBe(false);

    const wrongScope = await worker.fetch(
      confirmAudioRequest(
        await tokenFor(accountA, `mira-device-${crypto.randomUUID()}`, {
          scope: ['relay:transport'],
        }),
        taskA.taskId,
        taskA.assetId,
      ),
    );
    expect(wrongScope.status).toBe(401);

    const wrongAudience = await worker.fetch(
      confirmAudioRequest(
        await tokenFor(accountA, `mira-device-${crypto.randomUUID()}`, {
          aud: 'mira:cloud-relay-transport',
        }),
        taskA.taskId,
        taskA.assetId,
      ),
    );
    expect(wrongAudience.status).toBe(401);

    const unauthenticated = await worker.fetch(
      new Request(
        `https://shiyan.test/v1/capture-tasks/${taskA.taskId}/audio/confirm`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            assetId: taskA.assetId,
            idempotencyKey: 'unauth',
          }),
        },
      ),
    );
    expect(unauthenticated.status).toBe(401);
    expect(await readAudioAsset(taskA.taskId)).toMatchObject({
      status: 'awaiting_upload',
      retained: 0,
      confirm_idempotency_key: null,
    });
  });

  it('keeps established size, content-type and missing-object confirm errors', async () => {
    const token = await tokenFor(
      `cloud-account-${crypto.randomUUID()}`,
      `mira-device-${crypto.randomUUID()}`,
    );

    const sizeTask = await createOwnedTask(token, 'Size mismatch');
    await uploadAudio(sizeTask.objectKey, { sizeBytes: 16 });
    const sizeMismatch = await worker.fetch(
      confirmAudioRequest(token, sizeTask.taskId, sizeTask.assetId),
    );
    expect(sizeMismatch.status).toBe(409);
    expect(await responseJson(sizeMismatch)).toMatchObject({
      ok: false,
      error: { code: 'audio_size_mismatch', retryable: true },
    });
    expect((await readAudioAsset(sizeTask.taskId))?.status).toBe('awaiting_upload');

    const typeTask = await createOwnedTask(token, 'Type mismatch');
    await uploadAudio(typeTask.objectKey, { contentType: 'audio/mp4' });
    const typeMismatch = await worker.fetch(
      confirmAudioRequest(token, typeTask.taskId, typeTask.assetId),
    );
    expect(typeMismatch.status).toBe(409);
    expect(await responseJson(typeMismatch)).toMatchObject({
      ok: false,
      error: { code: 'audio_content_type_mismatch', retryable: false },
    });
    expect((await readAudioAsset(typeTask.taskId))?.status).toBe('awaiting_upload');

    const missingTask = await createOwnedTask(token, 'Missing object');
    const missingObject = await worker.fetch(
      confirmAudioRequest(token, missingTask.taskId, missingTask.assetId),
    );
    expect(missingObject.status).toBe(409);
    expect(await responseJson(missingObject)).toMatchObject({
      ok: false,
      error: { code: 'audio_object_missing', retryable: true },
    });
    expect((await readAudioAsset(missingTask.taskId))?.status).toBe('awaiting_upload');
    expect(await captureWorkflowExists(missingTask.taskId)).toBe(false);
  });

  it('keeps legacy confirm/retention behavior and leaves other Cloud routes closed', async () => {
    const credential = `legacy-credential-${crypto.randomUUID()}`;
    const deviceId = await seedLegacyDevice(credential);

    const created = await worker.fetch(
      createRequest(credential, `legacy-audio-${crypto.randomUUID()}`),
    );
    expect(created.status).toBe(201);
    const createdBody = await responseJson(created);
    const legacyTaskId = createdBody.data.task.id as string;
    expect(createdBody.data.task.deviceId).toBe(deviceId);
    const upload = createdBody.data.upload as {
      assetId: string;
      objectKey: string;
    };
    await uploadAudio(upload.objectKey);

    const confirmed = await worker.fetch(
      confirmAudioRequest(credential, legacyTaskId, upload.assetId),
    );
    expect(confirmed.status).toBe(200);
    expect(await responseJson(confirmed)).toMatchObject({
      ok: true,
      data: { task: { id: legacyTaskId, deviceId } },
    });

    const retained = await worker.fetch(
      retentionRequest(credential, legacyTaskId, true),
    );
    expect(retained.status).toBe(200);
    expect(await responseJson(retained)).toMatchObject({
      ok: true,
      data: { retained: true },
    });

    const cloudToken = await tokenFor(
      `cloud-account-${crypto.randomUUID()}`,
      `mira-device-${crypto.randomUUID()}`,
    );
    const closedRoutes: Array<{ method: string; path: string }> = [
      { method: 'GET', path: `/v1/capture-tasks/${legacyTaskId}/transcript` },
      { method: 'POST', path: `/v1/capture-tasks/${legacyTaskId}/stt/retry` },
      { method: 'GET', path: `/v1/capture-tasks/${legacyTaskId}/scenes` },
      { method: 'POST', path: `/v1/capture-tasks/${legacyTaskId}/destination` },
    ];
    for (const route of closedRoutes) {
      const response = await worker.fetch(
        new Request(`https://shiyan.test${route.path}`, {
          method: route.method,
          headers: { authorization: `Bearer ${cloudToken}` },
        }),
      );
      expect(response.status).toBe(403);
      expect(await responseJson(response)).toMatchObject({
        ok: false,
        error: { code: 'cloud_identity_unmapped' },
      });
    }
  });
});
