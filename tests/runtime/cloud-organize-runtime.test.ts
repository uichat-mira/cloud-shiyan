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
const llmPrompts: string[] = [];

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

const fixtureLlmResponse = (init?: RequestInit): Response => {
  const payload = JSON.parse(String(init?.body ?? '{}')) as {
    messages?: Array<{ role?: string; content?: unknown }>;
  };
  const userMessage = payload.messages?.find((message) => message.role === 'user');
  const prompt =
    typeof userMessage?.content === 'string'
      ? userMessage.content
      : JSON.stringify(userMessage?.content ?? '');
  llmPrompts.push(prompt);

  const sectionIds = [...prompt.matchAll(/^- id: ([a-z0-9-]+) \|/gmu)].map(
    (match) => match[1],
  );
  const instruction = /Organize instruction: (.+)$/mu.exec(prompt)?.[1]?.trim();
  const structured = {
    summary: `fixture:${instruction ?? 'unknown'}`,
    sections: sectionIds.map((id) => ({ id, items: [] })),
  };

  return Response.json({
    id: `chatcmpl-${crypto.randomUUID()}`,
    object: 'chat.completion',
    created: currentSeconds(),
    model: 'test-model',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: JSON.stringify(structured) },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  });
};

const countTaskDrafts = async (taskId: string): Promise<number> => {
  const row = await runtime.DB.prepare(
    'SELECT COUNT(*) AS count FROM drafts WHERE task_id = ?',
  )
    .bind(taskId)
    .first<{ count: number }>();
  return row?.count ?? 0;
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
    if (raw.startsWith('https://example.invalid/')) {
      return Promise.resolve(fixtureLlmResponse(init));
    }
    return originalFetch(input, init);
  }) as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

describe.sequential('Cloud organize, AI Draft read and organize retry', () => {
  it('organizes with the owner Scenes, shares the draft across account devices and isolates foreign callers', async () => {
    llmPrompts.length = 0;
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

    const draftsBeforeDenials = await countTaskDrafts(builtInTask);
    for (const [token, label] of [
      [tokenB, 'foreign account'],
      [await tokenFor(accountB, deviceB), 'second foreign device'],
      [legacyCredential, 'legacy device'],
    ] as const) {
      for (const [path, method] of [
        [`/v1/capture-tasks/${builtInTask}/ai-draft/adjust`, 'POST'],
        [`/v1/capture-tasks/${builtInTask}/final-draft`, 'PUT'],
        [`/v1/capture-tasks/${builtInTask}/final-draft`, 'GET'],
      ] as const) {
        const deniedBody =
          method === 'POST'
            ? { instruction: 'denied', idempotencyKey: `denied-${crypto.randomUUID()}` }
            : method === 'PUT'
              ? { markdown: '# denied' }
              : undefined;
        const denied = await worker.fetch(
          requestWith(path, token, method, deniedBody),
        );
        expect(denied.status, `${label} ${method} ${path}`).toBe(404);
        expect(await responseJson(denied)).toMatchObject({
          error: { code: 'task_not_found' },
        });
      }
    }
    const unknownAdjustTask = crypto.randomUUID();
    for (const [path, method] of [
      [`/v1/capture-tasks/${unknownAdjustTask}/ai-draft/adjust`, 'POST'],
      [`/v1/capture-tasks/${unknownAdjustTask}/final-draft`, 'PUT'],
      [`/v1/capture-tasks/${unknownAdjustTask}/final-draft`, 'GET'],
    ] as const) {
      const denied = await worker.fetch(requestWith(path, tokenA1, method));
      expect(denied.status, `${method} ${path}`).toBe(404);
    }
    expect(await countTaskDrafts(builtInTask)).toBe(draftsBeforeDenials);
    expect(llmPrompts).toHaveLength(0);

    const adjustPath = `/v1/capture-tasks/${builtInTask}/ai-draft/adjust`;
    const adjustBody = { instruction: 'Make todos concrete', idempotencyKey: 'runtime-adj-1' };
    const adjusted = await worker.fetch(
      requestWith(adjustPath, tokenA2, 'POST', adjustBody),
    );
    expect(adjusted.status).toBe(200);
    expect(await responseJson(adjusted)).toMatchObject({
      ok: true,
      data: {
        draft: {
          taskId: builtInTask,
          version: 2,
          source: 'adjust',
          baseVersion: 1,
          sceneId: 'meeting',
        },
      },
    });
    expect(llmPrompts).toHaveLength(1);
    expect(llmPrompts[0]).toContain('Owned transcript for organize');
    expect(llmPrompts[0]).toContain('Make todos concrete');

    const replay = await worker.fetch(
      requestWith(adjustPath, tokenA1, 'POST', adjustBody),
    );
    expect(replay.status).toBe(200);
    expect(await responseJson(replay)).toMatchObject({
      data: { draft: { version: 2 } },
    });
    expect(llmPrompts).toHaveLength(1);

    const conflict = await worker.fetch(
      requestWith(adjustPath, tokenA1, 'POST', {
        instruction: 'A different instruction',
        idempotencyKey: 'runtime-adj-1',
      }),
    );
    expect(conflict.status).toBe(409);
    expect(await responseJson(conflict)).toMatchObject({
      error: { code: 'idempotency_content_conflict' },
    });
    expect(llmPrompts).toHaveLength(1);

    const finalPath = `/v1/capture-tasks/${builtInTask}/final-draft`;
    const notSaved = await worker.fetch(requestWith(finalPath, tokenA2));
    expect(notSaved.status).toBe(404);
    expect(await responseJson(notSaved)).toMatchObject({
      error: { code: 'final_draft_not_ready' },
    });

    const saved = await worker.fetch(
      requestWith(finalPath, tokenA2, 'PUT', {
        markdown: '# Edited\n\nHuman final draft.',
        title: 'Edited title',
      }),
    );
    expect(saved.status).toBe(200);
    expect(await responseJson(saved)).toMatchObject({
      ok: true,
      data: {
        draft: {
          kind: 'final',
          taskId: builtInTask,
          version: 1,
          title: 'Edited title',
          markdown: '# Edited\n\nHuman final draft.',
          baseVersion: 2,
        },
      },
    });

    const sharedFinal = await worker.fetch(requestWith(finalPath, tokenA1));
    expect(sharedFinal.status).toBe(200);
    expect(await responseJson(sharedFinal)).toMatchObject({
      data: { draft: { markdown: '# Edited\n\nHuman final draft.' } },
    });
    const beforeForeignSave = await responseJson(
      await worker.fetch(requestWith(finalPath, tokenA1)),
    );
    const foreignSave = await worker.fetch(
      requestWith(finalPath, tokenB, 'PUT', { markdown: '# overwritten' }),
    );
    expect(foreignSave.status).toBe(404);
    const afterForeignSave = await responseJson(
      await worker.fetch(requestWith(finalPath, tokenA1)),
    );
    expect(afterForeignSave.data.draft).toEqual(beforeForeignSave.data.draft);
    expect(await countTaskDrafts(builtInTask)).toBe(3);
  });

  it('keeps Scene id collisions account-scoped and fails missing custom Scenes without fallback', async () => {
    llmPrompts.length = 0;
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

    llmPrompts.length = 0;
    const adjustA = await worker.fetch(
      requestWith(`/v1/capture-tasks/${taskA}/ai-draft/adjust`, tokenA, 'POST', {
        instruction: 'Adjust A only',
        idempotencyKey: 'scene-private-a',
      }),
    );
    expect(adjustA.status).toBe(200);
    expect(await responseJson(adjustA)).toMatchObject({
      data: { draft: { version: 2, sceneId } },
    });
    const adjustB = await worker.fetch(
      requestWith(`/v1/capture-tasks/${taskB}/ai-draft/adjust`, tokenB, 'POST', {
        instruction: 'Adjust B only',
        idempotencyKey: 'scene-private-b',
      }),
    );
    expect(adjustB.status).toBe(200);
    expect(await responseJson(adjustB)).toMatchObject({
      data: { draft: { version: 2, sceneId } },
    });
    expect(llmPrompts).toHaveLength(2);
    expect(llmPrompts[0]).toContain('private-A');
    expect(llmPrompts[0]).not.toContain('private-B');
    expect(llmPrompts[1]).toContain('private-B');
    expect(llmPrompts[1]).not.toContain('private-A');

    const draftsBeforeMissingScene = await countTaskDrafts(taskA);
    await runtime.DB.prepare(
      'UPDATE capture_tasks SET scene_id = ? WHERE id = ?',
    )
      .bind('missing-adjust-scene', taskA)
      .run();
    llmPrompts.length = 0;
    const missingSceneAdjust = await worker.fetch(
      requestWith(`/v1/capture-tasks/${taskA}/ai-draft/adjust`, tokenA, 'POST', {
        instruction: 'Must not leak another scene',
        idempotencyKey: 'missing-adjust-scene',
      }),
    );
    expect(missingSceneAdjust.status).toBe(409);
    expect(await responseJson(missingSceneAdjust)).toMatchObject({
      error: { code: 'scene_not_found' },
    });
    expect(llmPrompts).toHaveLength(0);
    expect(await countTaskDrafts(taskA)).toBe(draftsBeforeMissingScene);

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
