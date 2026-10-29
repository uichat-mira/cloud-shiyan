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
let signingKey: TestSigningKey;
let githubCalls: Array<{ url: string; method: string; body: string | null }> = [];

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

const tokenFor = async (accountId: string, deviceId: string): Promise<string> =>
  signTestCredential(
    shiyanClaims({
      sub: accountId,
      device_id: deviceId,
      iat: currentSeconds(),
      nbf: currentSeconds(),
      exp: currentSeconds() + 300,
    }),
    signingKey,
  );

const requestWith = (
  path: string,
  token: string,
  method = 'GET',
  body?: unknown,
): Request =>
  new Request(`https://shiyan.test${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const responseJson = async (response: Response): Promise<Record<string, any>> =>
  (await response.json()) as Record<string, any>;

const createTask = async (token: string, title: string): Promise<string> => {
  const response = await worker.fetch(
    new Request('https://shiyan.test/v1/capture-tasks', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        idempotencyKey: `delivery-${crypto.randomUUID()}`,
        title,
        sceneId: 'meeting',
        audio: { contentType: 'audio/mpeg', sizeBytes: 32 },
      }),
    }),
  );
  expect(response.status).toBe(201);
  return (await responseJson(response)).data.task.id as string;
};

const seedAiDraft = async (taskId: string): Promise<void> => {
  const now = new Date().toISOString();
  await runtime.DB.prepare(
    `INSERT INTO drafts
     (id, task_id, kind, version, source, base_version, instruction, idempotency_key,
      title, markdown, structured_json, scene_id, provider, model, latency_ms,
      prompt_tokens, completion_tokens, total_tokens, provider_request_id,
      fallback_used, correlation_id, confirmed_at, created_at, updated_at)
     VALUES (?, ?, 'ai', 1, 'organize', NULL, NULL, NULL, ?, ?, NULL, 'meeting',
             'fixture', 'fixture-model', 1, 1, 1, 2, NULL, 0, ?, NULL, ?, ?)`,
  )
    .bind(
      crypto.randomUUID(),
      taskId,
      'Seeded AI draft',
      '# Seeded AI draft\n',
      `corr-${taskId}`,
      now,
      now,
    )
    .run();
};

const saveFinalDraft = async (
  token: string,
  taskId: string,
  title: string,
  markdown: string,
): Promise<string> => {
  const response = await worker.fetch(
    requestWith(`/v1/capture-tasks/${taskId}/final-draft`, token, 'PUT', {
      title,
      markdown,
    }),
  );
  expect(response.status).toBe(200);
  return (await responseJson(response)).data.draft.id as string;
};

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
      'Legacy delivery device',
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
      'Legacy delivery task',
      `legacy-${taskId}`,
      `corr-${taskId}`,
      timestamp,
      timestamp,
    )
    .run();

  return { deviceId, taskId };
};

const countDeliveries = async (taskId: string): Promise<number> => {
  const row = await runtime.DB.prepare(
    'SELECT COUNT(*) AS count FROM delivery_records WHERE task_id = ?',
  )
    .bind(taskId)
    .first<{ count: number }>();
  return row?.count ?? 0;
};

const readDeliveryStage = async (taskId: string): Promise<string | null> => {
  const row = await runtime.DB.prepare(
    "SELECT status FROM capture_stages WHERE task_id = ? AND stage = 'delivery'",
  )
    .bind(taskId)
    .first<{ status: string }>();
  return row?.status ?? null;
};

const githubContentPath = (taskId: string): string => `entries/runtime/${taskId}.md`;

beforeAll(async () => {
  signingKey = await createTestSigningKey('runtime-cloud-delivery-key');

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
    if (raw.startsWith('https://api.github.com/')) {
      const method = init?.method ?? 'GET';
      githubCalls.push({
        url: raw,
        method,
        body: init?.body === undefined ? null : String(init.body),
      });
      if (method === 'GET') {
        return Promise.resolve(new Response(null, { status: 404 }));
      }
      const taskId = raw.split('/').at(-1) ?? '';
      const path = githubContentPath(decodeURIComponent(taskId));
      return Promise.resolve(
        Response.json(
          {
            content: {
              path,
              html_url: `https://github.com/dangjingtao/mira-shiyan/blob/main/${path}`,
            },
            commit: { sha: 'commit-runtime-1' },
          },
          { status: 201 },
        ),
      );
    }
    return originalFetch(input, init);
  }) as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

describe.sequential('Cloud-owned GitHub Destination deliveries', () => {
  it('delivers once for the account owner, lists and replays saved evidence, and ignores forged ids', async () => {
    githubCalls = [];
    const accountA = `cloud-account-${crypto.randomUUID()}`;
    const accountB = `cloud-account-${crypto.randomUUID()}`;
    const tokenA1 = await tokenFor(accountA, `mira-device-${crypto.randomUUID()}`);
    const tokenA2 = await tokenFor(accountA, `mira-device-${crypto.randomUUID()}`);
    const tokenB = await tokenFor(accountB, `mira-device-${crypto.randomUUID()}`);
    const tokenB2 = await tokenFor(accountB, `mira-device-${crypto.randomUUID()}`);
    const secretMarkdown = '# Private account A final\n\nSECRET_A_MARKDOWN';

    const taskId = await createTask(tokenA1, 'Account A delivery task');
    await seedAiDraft(taskId);
    const finalDraftId = await saveFinalDraft(
      tokenA2,
      taskId,
      'Account A final title',
      secretMarkdown,
    );

    const idempotencyKey = `cloud-deliver-${crypto.randomUUID()}`;
    const forged = {
      destination: 'github',
      idempotencyKey,
      accountId: accountB,
      finalDraftId: 'forged-final-draft',
      deliveryId: 'forged-delivery',
      taskId: crypto.randomUUID(),
    };
    const delivered = await worker.fetch(
      requestWith(`/v1/capture-tasks/${taskId}/deliveries`, tokenA2, 'POST', forged),
    );
    expect(delivered.status).toBe(200);
    const deliveredBody = await responseJson(delivered);
    expect(deliveredBody.data.taskId).toBe(taskId);
    expect(deliveredBody.data.record).toMatchObject({
      taskId,
      finalDraftId,
      idempotencyKey,
      status: 'succeeded',
      commitSha: 'commit-runtime-1',
    });
    expect(deliveredBody.data.record.id).not.toBe('forged-delivery');
    expect(githubCalls).toHaveLength(2);

    const putCall = githubCalls.find((call) => call.method === 'PUT');
    expect(putCall).toBeTruthy();
    const written = JSON.parse(putCall!.body ?? '{}') as { content: string };
    const publishedMarkdown = atob(written.content);
    expect(publishedMarkdown).toContain(secretMarkdown);
    expect(publishedMarkdown).toContain(`shiyan_final_draft_id: "${finalDraftId}"`);
    expect(publishedMarkdown).not.toContain('forged-final-draft');

    const listed = await worker.fetch(
      requestWith(
        `/v1/capture-tasks/${taskId}/deliveries?deliveryId=forged-delivery`,
        tokenA1,
      ),
    );
    expect(listed.status).toBe(200);
    const listedBody = await responseJson(listed);
    expect(listedBody.data.deliveries).toHaveLength(1);
    expect(listedBody.data.deliveries[0]).toMatchObject({
      finalDraftId,
      idempotencyKey,
      commitSha: 'commit-runtime-1',
    });

    const replay = await worker.fetch(
      requestWith(`/v1/capture-tasks/${taskId}/deliveries`, tokenA1, 'POST', {
        destination: 'github',
        idempotencyKey,
      }),
    );
    expect(replay.status).toBe(200);
    const replayBody = await responseJson(replay);
    expect(replayBody.data.record.id).toBe(deliveredBody.data.record.id);
    expect(replayBody.data.delivery.commitSha).toBe('commit-runtime-1');
    expect(githubCalls).toHaveLength(2);
    expect(await countDeliveries(taskId)).toBe(1);
    expect(await readDeliveryStage(taskId)).toBe('succeeded');

    const deliveriesBeforeDenials = await countDeliveries(taskId);
    const stagesBeforeDenials = await readDeliveryStage(taskId);

    for (const [token, label] of [
      [tokenB, 'foreign account'],
      [tokenB2, 'second foreign device'],
    ] as const) {
      const denied = await worker.fetch(
        requestWith(`/v1/capture-tasks/${taskId}/deliveries`, token),
      );
      expect(denied.status, label).toBe(404);
      const deniedBody = await responseJson(denied);
      expect(deniedBody).toMatchObject({ error: { code: 'task_not_found' } });
      expect(JSON.stringify(deniedBody)).not.toContain('SECRET_A_MARKDOWN');

      const deniedPost = await worker.fetch(
        requestWith(`/v1/capture-tasks/${taskId}/deliveries`, token, 'POST', {
          destination: 'github',
          idempotencyKey: `denied-${crypto.randomUUID()}`,
        }),
      );
      expect(deniedPost.status, label).toBe(404);
      expect(JSON.stringify(await responseJson(deniedPost))).not.toContain(
        'SECRET_A_MARKDOWN',
      );
    }

    const unknown = await worker.fetch(
      requestWith(
        `/v1/capture-tasks/${crypto.randomUUID()}/deliveries`,
        tokenA1,
      ),
    );
    expect(unknown.status).toBe(404);

    expect(githubCalls).toHaveLength(2);
    expect(await countDeliveries(taskId)).toBe(deliveriesBeforeDenials);
    expect(await readDeliveryStage(taskId)).toBe(stagesBeforeDenials);

    const changed = await worker.fetch(
      requestWith(`/v1/capture-tasks/${taskId}/final-draft`, tokenA2, 'PUT', {
        title: 'Account A final title',
        markdown: '# Changed after delivery\n',
      }),
    );
    expect(changed.status).toBe(200);
    const conflict = await worker.fetch(
      requestWith(`/v1/capture-tasks/${taskId}/deliveries`, tokenA2, 'POST', {
        destination: 'github',
        idempotencyKey,
      }),
    );
    expect(conflict.status).toBe(409);
    expect(await responseJson(conflict)).toMatchObject({
      error: { code: 'delivery_idempotency_conflict' },
    });
    expect(githubCalls).toHaveLength(2);
    expect(await countDeliveries(taskId)).toBe(1);
  });

  it('keeps legacy device delivery working and rejects cross-domain task ids', async () => {
    githubCalls = [];
    const legacyCredential = `legacy-delivery-${crypto.randomUUID()}`;
    const legacy = await seedLegacyTask(legacyCredential);
    await seedAiDraft(legacy.taskId);
    const legacyFinalDraftId = await saveFinalDraft(
      legacyCredential,
      legacy.taskId,
      'Legacy final title',
      '# Legacy final\n\nLEGACY_MARKDOWN',
    );

    const legacyDelivered = await worker.fetch(
      requestWith(`/v1/capture-tasks/${legacy.taskId}/deliveries`, legacyCredential, 'POST', {
        destination: 'github',
        idempotencyKey: 'legacy-deliver-1',
      }),
    );
    expect(legacyDelivered.status).toBe(200);
    const legacyBody = await responseJson(legacyDelivered);
    expect(legacyBody.data.record).toMatchObject({
      taskId: legacy.taskId,
      finalDraftId: legacyFinalDraftId,
      status: 'succeeded',
      commitSha: 'commit-runtime-1',
    });
    expect(githubCalls).toHaveLength(2);

    githubCalls = [];
    const accountId = `cloud-account-${crypto.randomUUID()}`;
    const cloudToken = await tokenFor(accountId, `mira-device-${crypto.randomUUID()}`);
    const cloudTaskId = await createTask(cloudToken, 'Cloud isolation delivery task');
    await seedAiDraft(cloudTaskId);
    await saveFinalDraft(
      cloudToken,
      cloudTaskId,
      'Cloud isolation final',
      '# Cloud isolation\n\nCLOUD_MARKDOWN',
    );

    const cloudReadsLegacy = await worker.fetch(
      requestWith(`/v1/capture-tasks/${legacy.taskId}/deliveries`, cloudToken),
    );
    expect(cloudReadsLegacy.status).toBe(404);

    const legacyReadsCloud = await worker.fetch(
      requestWith(`/v1/capture-tasks/${cloudTaskId}/deliveries`, legacyCredential),
    );
    expect(legacyReadsCloud.status).toBe(404);

    const legacyPostsToCloud = await worker.fetch(
      requestWith(`/v1/capture-tasks/${cloudTaskId}/deliveries`, legacyCredential, 'POST', {
        destination: 'github',
        idempotencyKey: 'cross-domain-denied',
      }),
    );
    expect(legacyPostsToCloud.status).toBe(404);

    expect(githubCalls).toHaveLength(0);
    expect(await countDeliveries(cloudTaskId)).toBe(0);
    expect(await readDeliveryStage(cloudTaskId)).toBeNull();
  });
});
