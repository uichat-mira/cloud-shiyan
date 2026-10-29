import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { env, exports } from 'cloudflare:workers';
import { runMob019Workflow, type Mob019Env } from '../../src/api/mob019';
import { runMob020Organize, type Mob020Env } from '../../src/api/mob020';
import {
  createTestSigningKey,
  shiyanClaims,
  signTestCredential,
  type TestSigningKey,
} from '../helpers/cloud-auth';

/**
 * SHY-017: one new account-owned task across all backend modules.
 *
 * The Worker routes, D1 predicates, D1 migrations, R2 objects and Workflow
 * binding are real local workerd integrations. Only external identity JWKS,
 * Workers AI inference, LLM HTTP and GitHub HTTP are deterministic fixtures.
 * This test does NOT prove remote Cloudflare bindings, provider success, mobile
 * T4 or production T5.
 */
const runtime = env as typeof env & {
  DB: D1Database;
  AUDIO: R2Bucket;
  CAPTURE_WORKFLOW: { get(id: string): Promise<unknown> };
  CLOUD_AUTH_JWKS_URL: string;
  DEVICE_AUTH_PEPPER: string;
};
const worker = exports.default as { fetch(request: Request): Promise<Response> };
const originalFetch = globalThis.fetch;
let key: TestSigningKey;

type Outbound = { method: string; url: string; body: string | null };
const githubCalls: Outbound[] = [];
const llmCalls: Outbound[] = [];
const sttCalls: string[] = [];
const organizeScenes: string[] = [];
const now = (): number => Math.floor(Date.now() / 1000);
const id = (prefix: string): string => prefix + '-' + crypto.randomUUID();

const tokenFor = (accountId: string, deviceId: string): Promise<string> =>
  signTestCredential(
    shiyanClaims({
      sub: accountId,
      device_id: deviceId,
      iat: now(),
      nbf: now(),
      exp: now() + 300,
    }),
    key,
  );

const request = (
  token: string,
  path: string,
  method = 'GET',
  body?: unknown,
): Request =>
  new Request('https://shiyan.test' + path, {
    method,
    headers: {
      authorization: 'Bearer ' + token,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const json = async (response: Response): Promise<Record<string, any>> =>
  (await response.json()) as Record<string, any>;

const step = {
  async do<T>(_name: string, callback: () => Promise<T>): Promise<T> {
    return callback();
  },
};

const databaseSnapshot = async (taskId: string) => {
  const tables: Record<string, string> = {
    task: 'SELECT * FROM capture_tasks WHERE id = ?',
    asset: 'SELECT * FROM audio_assets WHERE task_id = ?',
    stage: 'SELECT * FROM capture_stages WHERE task_id = ? ORDER BY stage',
    transcript: 'SELECT * FROM transcripts WHERE task_id = ?',
    draft: 'SELECT * FROM drafts WHERE task_id = ? ORDER BY kind, version',
    delivery: 'SELECT * FROM delivery_records WHERE task_id = ?',
  };
  const result: Record<string, unknown> = {};
  for (const [name, sql] of Object.entries(tables)) {
    result[name] = (await runtime.DB.prepare(sql).bind(taskId).all()).results;
  }
  return result;
};

const sha256Hex = async (text: string): Promise<string> => {
  const bytes = new Uint8Array(await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(text),
  ));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
};

const legacyTask = async (credential: string): Promise<string> => {
  const deviceId = id('historical-device');
  const taskId = crypto.randomUUID();
  const timestamp = new Date().toISOString();
  await runtime.DB.prepare(
    'INSERT INTO devices (id, credential_hash, user_id, display_name, created_at, last_seen_at) VALUES (?, ?, NULL, ?, ?, ?)',
  ).bind(
    deviceId,
    await sha256Hex(runtime.DEVICE_AUTH_PEPPER + ':' + credential),
    'Historical device',
    timestamp,
    timestamp,
  ).run();
  await runtime.DB.prepare(
    "INSERT INTO capture_tasks (id, owner_kind, device_id, cloud_account_id, cloud_device_id, user_id, title, scene_id, lifecycle_status, current_stage, create_idempotency_key, correlation_id, created_at, updated_at) VALUES (?, 'legacy-device', ?, NULL, NULL, NULL, ?, 'meeting', 'active', 'upload', ?, ?, ?, ?)",
  ).bind(taskId, deviceId, 'Legacy task', id('legacy-key'), id('corr'), timestamp, timestamp).run();
  return taskId;
};

beforeAll(async () => {
  key = await createTestSigningKey('shy-017-isolation-journey');
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string'
      ? input
      : input instanceof Request ? input.url : String(input);
    if (url === runtime.CLOUD_AUTH_JWKS_URL) {
      return Promise.resolve(Response.json({ keys: [key.publicJwk] }));
    }
    if (url.startsWith('https://example.invalid/')) {
      const body = init?.body === undefined ? null : String(init.body);
      llmCalls.push({ url, method: init?.method ?? 'GET', body });
      const payload = JSON.parse(body ?? '{}') as {
        messages?: Array<{ role: string; content: unknown }>;
      };
      const message = payload.messages?.find((entry) => entry.role === 'user');
      const prompt = typeof message?.content === 'string'
        ? message.content : JSON.stringify(message?.content ?? '');
      const sectionIds = [...prompt.matchAll(/^- id: ([a-z0-9-]+) \|/gmu)]
        .map((match) => match[1]);
      const structured = {
        summary: 'fixture-adjusted',
        sections: sectionIds.map((sectionId) => ({ id: sectionId, items: [] })),
      };
      return Promise.resolve(Response.json({
        id: id('chatcmpl'),
        object: 'chat.completion',
        created: now(),
        model: 'test-model',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: JSON.stringify(structured) },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }));
    }
    if (url.startsWith('https://api.github.com/')) {
      const method = init?.method ?? 'GET';
      githubCalls.push({
        method,
        url,
        body: init?.body === undefined ? null : String(init.body),
      });
      if (method === 'GET') return Promise.resolve(new Response(null, { status: 404 }));
      return Promise.resolve(Response.json({
        content: {
          path: 'entries/fixture.md',
          html_url: 'https://github.com/fixture/repo/blob/main/entries/fixture.md',
        },
        commit: { sha: 'shy017-fixture-commit' },
      }, { status: 201 }));
    }
    // Never let an unaccounted external request leave this T3 test.
    throw new Error('Unexpected outbound request in SHY-017: ' + url);
  }) as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

describe.sequential('SHY-017 S1 backend journey and negative owner matrix', () => {
  it('joins task/upload/STT/Scene/AI/Final Draft/delivery without cross-owner side effects', async () => {
    githubCalls.length = 0;
    llmCalls.length = 0;
    sttCalls.length = 0;
    organizeScenes.length = 0;
    const accountA = id('account-A');
    const accountB = id('account-B');
    const tokenA1 = await tokenFor(accountA, id('device-A1'));
    const tokenA2 = await tokenFor(accountA, id('device-A2'));
    const tokenB = await tokenFor(accountB, id('device-B'));
    const legacyCredential = id('legacy-credential');
    const historicalTaskId = await legacyTask(legacyCredential);
    const sceneId = id('my-scene');
    const privateInstruction = 'A_ONLY_PRIVATE_SCENE_INSTRUCTION';
    const privateTranscript = 'A_ONLY_PRIVATE_TRANSCRIPT';
    const privateFinal = '# A_ONLY_PRIVATE_FINAL\n\nHuman approved';

    // Real account-scoped Scene API; a foreign account may use the same ID,
    // but not see, override or resolve A's private instruction.
    for (const [token, instruction] of [
      [tokenA1, privateInstruction],
      [tokenB, 'B_ONLY_SCENE_INSTRUCTION'],
    ] as const) {
      const response = await worker.fetch(request(token, '/v1/scenes', 'POST', {
        id: sceneId,
        name: 'Customer scene',
        instruction,
        sections: [{ id: 'points', title: 'Points', description: 'Important points' }],
      }));
      expect(response.status).toBe(201);
    }
    const scenesA = await json(await worker.fetch(request(tokenA2, '/v1/scenes')));
    const scenesB = await json(await worker.fetch(request(tokenB, '/v1/scenes')));
    expect(JSON.stringify(scenesA)).toContain(privateInstruction);
    expect(JSON.stringify(scenesB)).not.toContain(privateInstruction);

    const createdResponse = await worker.fetch(request(tokenA1, '/v1/capture-tasks', 'POST', {
      idempotencyKey: id('create'),
      title: 'S1 integrated capture',
      sceneId,
      audio: { contentType: 'audio/mpeg', sizeBytes: 32 },
    }));
    expect(createdResponse.status).toBe(201);
    const created = await json(createdResponse);
    const taskId = created.data.task.id as string;
    const assetId = created.data.upload.assetId as string;
    const objectKey = created.data.upload.objectKey as string;
    expect(created.data.upload).toMatchObject({ assetId, objectKey });
    expect(await runtime.DB.prepare(
      "SELECT cloud_account_id FROM capture_tasks WHERE id = ? AND owner_kind = 'cloud-account'",
    ).bind(taskId).first()).toMatchObject({ cloud_account_id: accountA });

    await runtime.AUDIO.put(objectKey, new Uint8Array(32), {
      httpMetadata: { contentType: 'audio/mpeg' },
    });
    const confirmKey = id('confirm');
    const confirmPath = '/v1/capture-tasks/' + taskId + '/audio/confirm';
    const confirmed = await worker.fetch(request(tokenA2, confirmPath, 'POST', {
      assetId, idempotencyKey: confirmKey,
    }));
    expect(confirmed.status).toBe(200);
    expect((await json(confirmed)).ok).toBe(true);
    expect((await runtime.AUDIO.head(objectKey))?.size).toBe(32);
    expect((await runtime.DB.prepare('SELECT status FROM audio_assets WHERE id = ?')
      .bind(assetId).first<{ status: string }>())?.status).toBe('confirmed');
    expect(await runtime.CAPTURE_WORKFLOW.get('capture-' + taskId)).toBeTruthy();

    // A trusted server-only callback runs against the actual owned D1/R2.
    // No client-provided owner ID or mocked authorization predicate is used.
    const sttEnv = {
      DB: runtime.DB,
      AUDIO: runtime.AUDIO,
      CAPTURE_WORKFLOW: runtime.CAPTURE_WORKFLOW,
      AI: {
        async run() {
          sttCalls.push(taskId);
          return {
            text: privateTranscript,
            language: 'en',
            segments: [{ start: 0, end: 1, text: privateTranscript }],
          };
        },
      },
    } as unknown as Mob019Env;
    const stt = await runMob019Workflow(sttEnv, { taskId, objectKey }, step);
    expect(stt.ok).toBe(true);
    expect(sttCalls).toEqual([taskId]);
    const savedTranscript = await runtime.DB.prepare(
      'SELECT text, source_asset_id, stt_artifact_key FROM transcripts WHERE task_id = ?',
    ).bind(taskId).first<{
      text: string; source_asset_id: string; stt_artifact_key: string;
    }>();
    expect(savedTranscript).toMatchObject({ text: privateTranscript, source_asset_id: assetId });
    expect(await runtime.AUDIO.head(savedTranscript!.stt_artifact_key)).not.toBeNull();
    const transcriptA = await worker.fetch(
      request(tokenA2, '/v1/capture-tasks/' + taskId + '/transcript'),
    );
    expect(transcriptA.status).toBe(200);
    expect(JSON.stringify(await json(transcriptA))).toContain(privateTranscript);

    const organizeEnv = {
      DB: runtime.DB,
      CAPTURE_WORKFLOW: runtime.CAPTURE_WORKFLOW,
      LLM: {
        async generateStructured(input: { scene: { instruction: string } }) {
          organizeScenes.push(input.scene.instruction);
          return {
            ok: true,
            value: {
              markdown: '# Fixture organized\n',
              structured: { summary: 'Organized', sections: [] },
              provider: 'fixture',
              model: 'fixture-model',
              latencyMs: 1,
              usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
              providerRequestId: null,
              fallbackUsed: false,
            },
          };
        },
      },
    } as unknown as Mob020Env;
    const organized = await runMob020Organize(organizeEnv, { taskId }, step);
    expect(organized.ok).toBe(true);
    expect(organizeScenes).toEqual([privateInstruction]);

    const aiPath = '/v1/capture-tasks/' + taskId + '/ai-draft';
    const aiResponse = await worker.fetch(request(tokenA2, aiPath));
    expect(aiResponse.status).toBe(200);
    expect(await json(aiResponse)).toMatchObject({
      data: { draft: { taskId, version: 1, source: 'organize', sceneId } },
    });
    const adjustKey = id('adjust');
    const adjusted = await worker.fetch(request(tokenA1, aiPath + '/adjust', 'POST', {
      instruction: 'Please clarify the action items',
      idempotencyKey: adjustKey,
    }));
    expect(adjusted.status).toBe(200);
    expect(await json(adjusted)).toMatchObject({
      data: { draft: { taskId, version: 2, source: 'adjust' } },
    });
    expect(llmCalls).toHaveLength(1);

    const finalPath = '/v1/capture-tasks/' + taskId + '/final-draft';
    const savedFinal = await worker.fetch(request(tokenA2, finalPath, 'PUT', {
      title: 'Human approved', markdown: privateFinal,
    }));
    expect(savedFinal.status).toBe(200);
    const finalId = (await json(savedFinal)).data.draft.id as string;
    expect(await json(await worker.fetch(request(tokenA1, finalPath)))).toMatchObject({
      data: { draft: { id: finalId, markdown: privateFinal } },
    });

    const deliveryPath = '/v1/capture-tasks/' + taskId + '/deliveries';
    const deliveryKey = id('delivery');
    const delivered = await worker.fetch(request(tokenA2, deliveryPath, 'POST', {
      destination: 'github',
      idempotencyKey: deliveryKey,
      accountId: accountB,
      taskId: id('forged-task'),
      finalDraftId: id('forged-final'),
      deliveryId: id('forged-delivery'),
    }));
    expect(delivered.status).toBe(200);
    const deliveredBody = await json(delivered);
    expect(deliveredBody.data.record).toMatchObject({
      taskId, finalDraftId: finalId, idempotencyKey: deliveryKey,
      status: 'succeeded', commitSha: 'shy017-fixture-commit',
    });
    const wrote = githubCalls.find((call) => call.method === 'PUT');
    expect(wrote).toBeTruthy();
    expect(atob((JSON.parse(wrote!.body ?? '{}') as { content: string }).content))
      .toContain(privateFinal);

    const listed = await json(await worker.fetch(request(tokenA1, deliveryPath)));
    expect(listed.data.deliveries).toHaveLength(1);
    expect(listed.data.deliveries[0].finalDraftId).toBe(finalId);
    const replayed = await worker.fetch(request(tokenA1, deliveryPath, 'POST', {
      destination: 'github', idempotencyKey: deliveryKey,
    }));
    expect(replayed.status).toBe(200);
    expect((await json(replayed)).data.record.id).toBe(deliveredBody.data.record.id);
    expect(githubCalls).toHaveLength(2);

    // Confirm that historical credentials remain a real, distinct principal.
    expect((await worker.fetch(request(legacyCredential,
      '/v1/capture-tasks/' + historicalTaskId))).status).toBe(200);
    expect((await worker.fetch(request(tokenA1,
      '/v1/capture-tasks/' + historicalTaskId))).status).toBe(404);

    const before = await databaseSnapshot(taskId);
    const externalBefore = {
      github: githubCalls.length,
      llm: llmCalls.length,
      stt: sttCalls.length,
      organize: organizeScenes.length,
    };
    const r2Before = await runtime.AUDIO.head(objectKey);
    const unknownTaskId = crypto.randomUUID();
    const forbiddenRoutes: Array<[string, string, unknown?]> = [
      ['', 'GET'],
      ['/audio/confirm', 'POST', { assetId, idempotencyKey: id('unauthorized') }],
      ['/audio/retention', 'PUT', { retained: true }],
      ['/transcript', 'GET'],
      ['/stt/retry', 'POST', { idempotencyKey: id('unauthorized') }],
      ['/organize/retry', 'POST', { idempotencyKey: id('unauthorized') }],
      ['/ai-draft', 'GET'],
      ['/ai-draft/adjust', 'POST', {
        instruction: 'Read another owner', idempotencyKey: id('unauthorized'),
      }],
      ['/final-draft', 'GET'],
      ['/final-draft', 'PUT', { title: 'Hijacked', markdown: '# stolen' }],
      ['/deliveries?deliveryId=' + deliveredBody.data.record.id, 'GET'],
      ['/deliveries', 'POST', {
        destination: 'github',
        idempotencyKey: id('unauthorized'),
        finalDraftId: finalId,
        deliveryId: deliveredBody.data.record.id,
      }],
    ];
    for (const [credential, baseId, label] of [
      [tokenB, taskId, 'foreign Cloud Account'],
      [legacyCredential, taskId, 'historical device'],
      [tokenA1, unknownTaskId, 'unknown task'],
    ] as const) {
      for (const [path, method, body] of forbiddenRoutes) {
        const response = await worker.fetch(request(
          credential, '/v1/capture-tasks/' + baseId + path, method, body,
        ));
        expect(response.status, label + ' ' + method + ' ' + path).toBe(404);
        const responseBody = JSON.stringify(await json(response));
        expect(responseBody).not.toContain(privateTranscript);
        expect(responseBody).not.toContain(privateInstruction);
        expect(responseBody).not.toContain(privateFinal);
        expect(responseBody).not.toContain(objectKey);
      }
    }
    // A valid B credential must not become authoritative by supplying A's IDs.
    expect(await databaseSnapshot(taskId)).toEqual(before);
    expect((await runtime.AUDIO.head(objectKey))?.etag).toBe(r2Before?.etag);
    expect({
      github: githubCalls.length,
      llm: llmCalls.length,
      stt: sttCalls.length,
      organize: organizeScenes.length,
    }).toEqual(externalBefore);
    expect((await runtime.DB.prepare(
      "SELECT COUNT(*) AS n FROM capture_tasks WHERE cloud_account_id = ? AND id = ?",
    ).bind(accountB, taskId).first<{ n: number }>())?.n).toBe(0);
  });
});
