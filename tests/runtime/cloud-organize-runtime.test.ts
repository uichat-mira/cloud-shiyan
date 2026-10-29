import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { env, exports } from 'cloudflare:workers';
import { runMob020Organize, type Mob020Env } from '../../src/api/mob020';
import type { LlmOutcome } from '../../src/shared/llm';
import {
  createTestSigningKey,
  shiyanClaims,
  signTestCredential,
  type TestSigningKey,
} from '../helpers/cloud-auth';

const runtime = env as typeof env & {
  DB: D1Database;
  CAPTURE_WORKFLOW: { get(id: string): Promise<unknown> };
  DEVICE_AUTH_PEPPER: string;
  CLOUD_AUTH_JWKS_URL: string;
};

const worker = exports.default as {
  fetch(request: Request): Promise<Response>;
};

const originalFetch = globalThis.fetch;
let signingKey: TestSigningKey;

const currentSeconds = (): number => Math.floor(Date.now() / 1000);

const sha256Hex = async (value: string): Promise<string> =>
  Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))),
    (byte) => byte.toString(16).padStart(2, '0'),
  ).join('');

const tokenFor = (
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
    signingKey,
  );

const requestWith = (path: string, token: string, method = 'GET'): Request =>
  new Request(`https://shiyan.test${path}`, {
    method,
    headers: { authorization: `Bearer ${token}` },
  });

const responseJson = async (response: Response): Promise<Record<string, any>> =>
  (await response.json()) as Record<string, any>;

const createTask = async (token: string, sceneId = 'meeting'): Promise<string> => {
  const response = await worker.fetch(
    new Request('https://shiyan.test/v1/capture-tasks', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        idempotencyKey: `organize-${crypto.randomUUID()}`,
        title: 'Cloud organize task',
        sceneId,
        audio: { contentType: 'audio/mpeg', sizeBytes: 32 },
      }),
    }),
  );
  expect(response.status).toBe(201);
  return (await responseJson(response)).data.task.id as string;
};

const createScene = async (
  token: string,
  id: string,
  instruction: string,
): Promise<void> => {
  const response = await worker.fetch(
    new Request('https://shiyan.test/v1/scenes', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        id,
        name: 'Runtime scene',
        instruction,
        sections: [{ id: 'points', title: 'Points', description: 'Worth keeping' }],
      }),
    }),
  );
  expect(response.status).toBe(201);
};

const seedTranscript = async (taskId: string): Promise<void> => {
  const asset = await runtime.DB.prepare(
    'SELECT id FROM audio_assets WHERE task_id = ? ORDER BY created_at ASC LIMIT 1',
  )
    .bind(taskId)
    .first<{ id: string }>();
  expect(asset?.id).toBeTruthy();
  await runtime.DB.prepare(
    `INSERT INTO transcripts
     (id, task_id, source_asset_id, text, language, provider, model,
      stt_artifact_key, created_at)
     VALUES (?, ?, ?, ?, 'en', 'test', 'test', ?, ?)`,
  )
    .bind(
      crypto.randomUUID(),
      taskId,
      asset!.id,
      'Owned transcript for organize',
      `stt/${taskId}.json`,
      new Date().toISOString(),
    )
    .run();
};

const llmSuccess = (): LlmOutcome => ({
  ok: true,
  value: {
    markdown: '# Organized\n',
    structured: { summary: 'Organized', sections: [] },
    provider: 'fixture',
    model: 'fixture-model',
    latencyMs: 1,
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    providerRequestId: null,
    fallbackUsed: false,
  },
});

const fakeLlm = (calls: Array<{ sceneId: string; instruction: string }>) => ({
  async generateStructured(input: { scene: { id: string; instruction: string } }) {
    calls.push({ sceneId: input.scene.id, instruction: input.scene.instruction });
    return llmSuccess();
  },
});

const organizeEnv = (
  calls: Array<{ sceneId: string; instruction: string }>,
): Mob020Env =>
  ({
    DB: runtime.DB,
    CAPTURE_WORKFLOW: runtime.CAPTURE_WORKFLOW,
    LLM: fakeLlm(calls),
  }) as unknown as Mob020Env;

const step = {
  async do<T>(_name: string, callback: () => Promise<T>): Promise<T> {
    return callback();
  },
};

const workflowExists = async (id: string): Promise<boolean> => {
  try {
    await runtime.CAPTURE_WORKFLOW.get(id);
    return true;
  } catch {
    return false;
  }
};

beforeAll(async () => {
  signingKey = await createTestSigningKey('runtime-cloud-organize-key');

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

describe.sequential('Cloud organize, AI Draft read and organize retry', () => {
  it('organizes with the owner Scenes, shares the draft across account devices and isolates foreign callers', async () => {
    const accountA = `cloud-account-${crypto.randomUUID()}`;
    const accountB = `cloud-account-${crypto.randomUUID()}`;
    const deviceA1 = `mira-device-${crypto.randomUUID()}`;
    const deviceA2 = `mira-device-${crypto.randomUUID()}`;
    const deviceB = `mira-device-${crypto.randomUUID()}`;
    const tokenA1 = await tokenFor(accountA, deviceA1);
    const tokenA2 = await tokenFor(accountA, deviceA2);
    const tokenB = await tokenFor(accountB, deviceB);

    const builtInTask = await createTask(tokenA1);
    await seedTranscript(builtInTask);
    const calls: Array<{ sceneId: string; instruction: string }> = [];
    const organized = await runMob020Organize(
      organizeEnv(calls),
      { taskId: builtInTask, requestId: 'runtime-built-in' },
      step,
    );
    expect(organized.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].sceneId).toBe('meeting');

    const shared = await worker.fetch(
      requestWith(`/v1/capture-tasks/${builtInTask}/ai-draft`, tokenA2),
    );
    expect(shared.status).toBe(200);
    expect(await responseJson(shared)).toMatchObject({
      ok: true,
      data: { draft: { taskId: builtInTask, version: 1, source: 'organize', sceneId: 'meeting' } },
    });

    for (const [token, label] of [
      [tokenB, 'foreign account'],
      [await tokenFor(accountB, deviceB), 'second foreign device'],
    ] as const) {
      const denied = await worker.fetch(
        requestWith(`/v1/capture-tasks/${builtInTask}/ai-draft`, token),
      );
      expect(denied.status, label).toBe(404);
      expect(await responseJson(denied)).toMatchObject({
        ok: false,
        error: { code: 'task_not_found' },
      });
    }

    const unknown = await worker.fetch(
      requestWith(`/v1/capture-tasks/${crypto.randomUUID()}/ai-draft`, tokenA1),
    );
    expect(unknown.status).toBe(404);

    const legacyCredential = `legacy-organize-${crypto.randomUUID()}`;
    const legacyDeviceId = `legacy-device-${crypto.randomUUID()}`;
    const timestamp = new Date().toISOString();
    await runtime.DB.prepare(
      `INSERT INTO devices
       (id, credential_hash, user_id, display_name, created_at, last_seen_at)
       VALUES (?, ?, NULL, ?, ?, ?)`,
    )
      .bind(
        legacyDeviceId,
        await sha256Hex(`${runtime.DEVICE_AUTH_PEPPER}:${legacyCredential}`),
        'Legacy organize device',
        timestamp,
        timestamp,
      )
      .run();
    const legacyRead = await worker.fetch(
      requestWith(`/v1/capture-tasks/${builtInTask}/ai-draft`, legacyCredential),
    );
    expect(legacyRead.status).toBe(404);
    expect(await responseJson(legacyRead)).toMatchObject({
      error: { code: 'task_not_found' },
    });

    for (const [path, method] of [
      [`/v1/capture-tasks/${builtInTask}/ai-draft/adjust`, 'POST'],
      [`/v1/capture-tasks/${builtInTask}/final-draft`, 'PUT'],
      [`/v1/capture-tasks/${builtInTask}/final-draft`, 'GET'],
    ] as const) {
      const closed = await worker.fetch(requestWith(path, tokenA1, method));
      expect(closed.status).toBe(403);
      expect(await responseJson(closed)).toMatchObject({
        error: { code: 'cloud_identity_unmapped' },
      });
    }
  });

  it('keeps Scene id collisions account-scoped and fails missing custom Scenes without fallback', async () => {
    const accountA = `cloud-account-${crypto.randomUUID()}`;
    const accountB = `cloud-account-${crypto.randomUUID()}`;
    const tokenA = await tokenFor(accountA, `mira-device-${crypto.randomUUID()}`);
    const tokenB = await tokenFor(accountB, `mira-device-${crypto.randomUUID()}`);
    const sceneId = `scene-${crypto.randomUUID().slice(0, 8)}`;

    await createScene(tokenA, sceneId, 'private-A');
    await createScene(tokenB, sceneId, 'private-B');

    const taskA = await createTask(tokenA, sceneId);
    const taskB = await createTask(tokenB, sceneId);
    await seedTranscript(taskA);
    await seedTranscript(taskB);

    const calls: Array<{ sceneId: string; instruction: string }> = [];
    const envForRun = organizeEnv(calls);
    expect(
      (await runMob020Organize(envForRun, { taskId: taskA }, step)).ok,
    ).toBe(true);
    expect(calls[0]).toMatchObject({ sceneId, instruction: 'private-A' });
    expect(
      (await runMob020Organize(envForRun, { taskId: taskB }, step)).ok,
    ).toBe(true);
    expect(calls[1]).toMatchObject({ sceneId, instruction: 'private-B' });

    const missingTask = await createTask(tokenA, 'missing-scene');
    await seedTranscript(missingTask);
    const before = calls.length;
    expect(
      (await runMob020Organize(envForRun, { taskId: missingTask }, step)).ok,
    ).toBe(false);
    expect(calls).toHaveLength(before);
    const draftCount = await runtime.DB.prepare(
      'SELECT COUNT(*) AS count FROM drafts WHERE task_id = ?',
    )
      .bind(missingTask)
      .first<{ count: number }>();
    expect(draftCount?.count).toBe(0);
    const stage = await runtime.DB.prepare(
      `SELECT status, retryable, error_code FROM capture_stages
       WHERE task_id = ? AND stage = 'organize'`,
    )
      .bind(missingTask)
      .first<{ status: string; retryable: number; error_code: string }>();
    expect(stage).toMatchObject({ status: 'failed', retryable: 0, error_code: 'scene_not_found' });
  });

  it('allows only the owning account to retry organize and keeps denied callers side-effect free', async () => {
    const accountA = `cloud-account-${crypto.randomUUID()}`;
    const accountB = `cloud-account-${crypto.randomUUID()}`;
    const tokenA = await tokenFor(accountA, `mira-device-${crypto.randomUUID()}`);
    const tokenB = await tokenFor(accountB, `mira-device-${crypto.randomUUID()}`);
    const task = await createTask(tokenA);
    await seedTranscript(task);
    expect(
      (await runMob020Organize(organizeEnv([]), { taskId: task }, step)).ok,
    ).toBe(true);

    const now = new Date().toISOString();
    await runtime.DB.prepare(
      `UPDATE capture_stages SET status = 'failed', retryable = 1, retry_count = 0,
         error_code = 'rate_limited', error_message = 'rate limited', updated_at = ?
       WHERE task_id = ? AND stage = 'organize'`,
    )
      .bind(now, task)
      .run();

    const retryPath = `/v1/capture-tasks/${task}/organize/retry`;
    const foreign = await worker.fetch(requestWith(retryPath, tokenB, 'POST'));
    expect(foreign.status).toBe(404);
    expect(await responseJson(foreign)).toMatchObject({
      error: { code: 'task_not_found' },
    });
    const untouched = await runtime.DB.prepare(
      `SELECT status, retry_count FROM capture_stages
       WHERE task_id = ? AND stage = 'organize'`,
    )
      .bind(task)
      .first<{ status: string; retry_count: number }>();
    expect(untouched).toEqual({ status: 'failed', retry_count: 0 });
    expect(await workflowExists(`capture-${task}-organize-1`)).toBe(false);

    const permitted = await worker.fetch(requestWith(retryPath, tokenA, 'POST'));
    expect(permitted.status).toBe(200);
    expect(await responseJson(permitted)).toMatchObject({
      ok: true,
      data: { taskId: task, stage: 'organize', retryCount: 1 },
    });
    const retried = await runtime.DB.prepare(
      `SELECT status, retry_count FROM capture_stages
       WHERE task_id = ? AND stage = 'organize'`,
    )
      .bind(task)
      .first<{ status: string; retry_count: number }>();
    expect(retried).toEqual({ status: 'pending', retry_count: 1 });
    expect(await workflowExists(`capture-${task}-organize-1`)).toBe(true);

    const draftBefore = await runtime.DB.prepare(
      'SELECT COUNT(*) AS count FROM drafts WHERE task_id = ?',
    )
      .bind(task)
      .first<{ count: number }>();
    expect(draftBefore?.count).toBe(1);
  });
});
