import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { env, exports } from 'cloudflare:workers';
import {
  createTestSigningKey,
  shiyanClaims,
  signTestCredential,
  replaceJwtPayload,
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

const requestWith = (path: string, token: string): Request =>
  new Request(`https://shiyan.test${path}`, {
    headers: { authorization: `Bearer ${token}` },
  });

const responseJson = async (response: Response): Promise<Record<string, any>> =>
  (await response.json()) as Record<string, any>;

const seedLegacyDevice = async (
  credential: string,
): Promise<{ deviceId: string; taskId: string }> => {
  const deviceId = `legacy-device-${crypto.randomUUID()}`;
  const taskId = crypto.randomUUID();
  const timestamp = new Date().toISOString();
  const credentialHash = await sha256Hex(
    `${runtime.DEVICE_AUTH_PEPPER}:${credential}`,
  );

  await runtime.DB.prepare(
    `INSERT INTO devices
     (id, credential_hash, user_id, display_name, created_at, last_seen_at)
     VALUES (?, ?, NULL, ?, ?, ?)`,
  )
    .bind(deviceId, credentialHash, 'Legacy test device', timestamp, timestamp)
    .run();

  await runtime.DB.prepare(
    `INSERT INTO capture_tasks
     (id, device_id, user_id, title, scene_id, lifecycle_status, current_stage,
      create_idempotency_key, correlation_id, created_at, updated_at)
     VALUES (?, ?, NULL, ?, ?, 'active', 'upload', ?, ?, ?, ?)`,
  )
    .bind(
      taskId,
      deviceId,
      'Legacy owned task',
      'meeting',
      `idem-${taskId}`,
      `corr-${taskId}`,
      timestamp,
      timestamp,
    )
    .run();

  return { deviceId, taskId };
};

beforeAll(async () => {
  key = await createTestSigningKey('runtime-cloud-auth-key');

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

const validShiyanToken = async (overrides: Record<string, unknown> = {}) =>
  signTestCredential(
    shiyanClaims({
      iat: currentSeconds(),
      nbf: currentSeconds(),
      exp: currentSeconds() + 300,
      ...overrides,
    }),
    key,
  );

describe('Cloud Auth identity boundary', () => {
  it('accepts a valid aud=shiyan credential as Cloud identity but denies unmapped Shiyan authorization', async () => {
    const idempotencyKey = `cloud-unmapped-${crypto.randomUUID()}`;
    const response = await worker.fetch(
      new Request('https://shiyan.test/v1/capture-tasks', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${await validShiyanToken()}`,
        },
        body: JSON.stringify({
          idempotencyKey,
          title: 'Cloud identity must not create this task',
          sceneId: 'meeting',
          audio: { contentType: 'audio/mpeg', sizeBytes: 1 },
        }),
      }),
    );

    expect(response.status).toBe(403);
    expect(await responseJson(response)).toMatchObject({
      ok: false,
      error: {
        code: 'cloud_identity_unmapped',
        retryable: false,
      },
    });

    const created = await runtime.DB.prepare(
      'SELECT id FROM capture_tasks WHERE create_idempotency_key = ?',
    )
      .bind(idempotencyKey)
      .all<{ id: string }>();
    expect(created.results ?? []).toHaveLength(0);
  });

  it('rejects Relay audience, expired, and tampered credentials as identity failures', async () => {
    const relayToken = await signTestCredential(
      shiyanClaims({
        aud: 'mira:cloud-relay-transport',
        scope: ['relay:transport'],
        relay: { room: 'room-1', role: 'client' },
        iat: currentSeconds(),
        nbf: currentSeconds(),
        exp: currentSeconds() + 300,
      }),
      key,
    );
    const relayResponse = await worker.fetch(
      requestWith('/v1/capture-tasks', relayToken),
    );
    expect(relayResponse.status).toBe(401);
    expect(await responseJson(relayResponse)).toMatchObject({
      ok: false,
      error: { code: 'cloud_credential_unauthorized', retryable: false },
    });

    const expiredToken = await validShiyanToken({
      iat: currentSeconds() - 600,
      nbf: currentSeconds() - 600,
      exp: currentSeconds() - 1,
    });
    const expiredResponse = await worker.fetch(
      requestWith('/v1/capture-tasks', expiredToken),
    );
    expect(expiredResponse.status).toBe(401);
    expect(await responseJson(expiredResponse)).toMatchObject({
      ok: false,
      error: { code: 'cloud_credential_unauthorized' },
    });

    const tamperedToken = replaceJwtPayload(
      await validShiyanToken(),
      shiyanClaims({
        sub: 'tampered-account',
        iat: currentSeconds(),
        nbf: currentSeconds(),
        exp: currentSeconds() + 300,
      }),
    );
    const tamperedResponse = await worker.fetch(
      requestWith('/v1/capture-tasks', tamperedToken),
    );
    expect(tamperedResponse.status).toBe(401);
    expect(await responseJson(tamperedResponse)).toMatchObject({
      ok: false,
      error: { code: 'cloud_credential_unauthorized' },
    });
  });

  it('keeps legacy device access working while Cloud identity cannot read legacy resources', async () => {
    const legacyCredential = `legacy-runtime-secret-${crypto.randomUUID()}`;
    const seeded = await seedLegacyDevice(legacyCredential);

    const legacyResponse = await worker.fetch(
      requestWith(`/v1/capture-tasks/${seeded.taskId}`, legacyCredential),
    );
    expect(legacyResponse.status).toBe(200);
    expect(await responseJson(legacyResponse)).toMatchObject({
      ok: true,
      data: {
        task: { id: seeded.taskId, deviceId: seeded.deviceId },
      },
    });

    // Even if the Cloud device id matches a legacy D1 device id, the Cloud
    // principal must not inherit that legacy resource ownership.
    const cloudResponse = await worker.fetch(
      requestWith(
        `/v1/capture-tasks/${seeded.taskId}`,
        await validShiyanToken({ device_id: seeded.deviceId }),
      ),
    );
    expect(cloudResponse.status).toBe(403);
    expect(await responseJson(cloudResponse)).toMatchObject({
      ok: false,
      error: { code: 'cloud_identity_unmapped' },
    });

    const stillLegacy = await worker.fetch(
      requestWith(`/v1/capture-tasks/${seeded.taskId}`, legacyCredential),
    );
    expect(stillLegacy.status).toBe(200);
  });

  it('does not accept a compact-JWS-shaped legacy credential through the legacy path', async () => {
    const jwsShapedLegacyCredential = 'aaa.bbb.ccc';
    const seeded = await seedLegacyDevice(jwsShapedLegacyCredential);

    const response = await worker.fetch(
      requestWith(
        `/v1/capture-tasks/${seeded.taskId}`,
        jwsShapedLegacyCredential,
      ),
    );

    expect(response.status).toBe(401);
    expect(await responseJson(response)).toMatchObject({
      ok: false,
      error: { code: 'cloud_credential_unauthorized' },
    });
  });
});
