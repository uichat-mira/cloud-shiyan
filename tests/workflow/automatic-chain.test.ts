import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { env, exports } from 'cloudflare:workers';
import { introspectWorkflowInstance } from 'cloudflare:test';
import {
  createTestSigningKey,
  shiyanClaims,
  signTestCredential,
  type TestSigningKey,
} from '../helpers/cloud-auth';

const runtime = env as typeof env & {
  DB: D1Database;
  AUDIO: R2Bucket;
  CAPTURE_WORKFLOW: Workflow;
  CLOUD_AUTH_JWKS_URL: string;
};
const worker = exports.default as { fetch(request: Request): Promise<Response> };
const originalFetch = globalThis.fetch;
let signingKey: TestSigningKey;

const now = (): number => Math.floor(Date.now() / 1000);
const tokenFor = (account: string): Promise<string> =>
  signTestCredential(shiyanClaims({
    sub: account,
    device_id: 'mira-device-' + crypto.randomUUID(),
    iat: now(),
    nbf: now(),
    exp: now() + 300,
  }), signingKey);

const call = (token: string, path: string, method = 'GET', body?: unknown) =>
  worker.fetch(new Request('https://shiyan.test' + path, {
    method,
    headers: {
      authorization: 'Bearer ' + token,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));

const data = async (response: Response): Promise<Record<string, any>> =>
  (await response.json()) as Record<string, any>;

beforeAll(async () => {
  signingKey = await createTestSigningKey('shy009-automatic-workflow');
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === 'string'
      ? input
      : input instanceof Request ? input.url : String(input);
    if (raw === runtime.CLOUD_AUTH_JWKS_URL) {
      return Promise.resolve(Response.json({ keys: [signingKey.publicJwk] }));
    }
    return originalFetch(input, init);
  }) as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

describe.sequential('SHY-009 automatic Worker Workflow', () => {
  it('lets a confirmed task trigger and complete STT plus account-owned organize automatically', async () => {
    const accountA = 'account-A-' + crypto.randomUUID();
    const accountB = 'account-B-' + crypto.randomUUID();
    const tokenA = await tokenFor(accountA);
    const tokenB = await tokenFor(accountB);
    const sceneId = 'scene-' + crypto.randomUUID().slice(0, 8);
    const instruction = 'SHY009_PRIVATE_SCENE_INSTRUCTION';

    const scene = await call(tokenA, '/v1/scenes', 'POST', {
      id: sceneId,
      name: 'Owner Workflow Scene',
      instruction,
      sections: [{ id: 'points', title: 'Points', description: 'Important notes' }],
    });
    expect(scene.status).toBe(201);

    const created = await call(tokenA, '/v1/capture-tasks', 'POST', {
      idempotencyKey: crypto.randomUUID(),
      title: 'Automatic Workflow end-to-end',
      sceneId,
      audio: { contentType: 'audio/mpeg', sizeBytes: 32 },
    });
    expect(created.status).toBe(201);
    const body = await data(created);
    const taskId = body.data.task.id as string;
    const assetId = body.data.upload.assetId as string;
    const objectKey = body.data.upload.objectKey as string;
    const flowId = 'capture-' + taskId;

    await runtime.AUDIO.put(objectKey, new Uint8Array(32).fill(7), {
      httpMetadata: { contentType: 'audio/mpeg' },
    });

    // Capture the actual scheduled Workflow instance before HTTP confirmation.
    // No test code invokes runMob019Workflow or runMob020Organize.
    const instance = await introspectWorkflowInstance(runtime.CAPTURE_WORKFLOW, flowId);
    try {
      const confirmed = await call(tokenA,
        '/v1/capture-tasks/' + taskId + '/audio/confirm', 'POST', {
          assetId, idempotencyKey: crypto.randomUUID(),
        },
      );
      expect(confirmed.status).toBe(200);
      await instance.waitForStatus('complete');

      const transcript = await runtime.DB.prepare(
        'SELECT task_id, text, source_asset_id, stt_artifact_key FROM transcripts WHERE task_id = ?',
      ).bind(taskId).first<{
        task_id: string; text: string; source_asset_id: string; stt_artifact_key: string;
      }>();
      const workflowStages = (await runtime.DB.prepare(
        'SELECT stage, status, error_code, error_message FROM capture_stages WHERE task_id = ?',
      ).bind(taskId).all()).results;
      if (!transcript) {
        throw new Error('Workflow complete without Transcript: ' + JSON.stringify(workflowStages));
      }
      expect(transcript).toMatchObject({
        task_id: taskId,
        text: 'SHY009_AUTOMATIC_WORKFLOW_TRANSCRIPT',
        source_asset_id: assetId,
      });
      expect(await runtime.AUDIO.head(transcript!.stt_artifact_key)).not.toBeNull();

      const ai = await data(await call(tokenA, '/v1/capture-tasks/' + taskId + '/ai-draft'));
      expect(ai).toMatchObject({
        ok: true,
        data: { draft: { taskId, source: 'organize', sceneId } },
      });
      const stages = (await runtime.DB.prepare(
        'SELECT stage, status FROM capture_stages WHERE task_id = ?',
      ).bind(taskId).all<{ stage: string; status: string }>()).results;
      expect(stages).toEqual(expect.arrayContaining([
        { stage: 'verify-audio', status: 'succeeded' },
        { stage: 'transcribe', status: 'succeeded' },
        { stage: 'organize', status: 'succeeded' },
      ]));

      const foreignTranscript = await call(tokenB, '/v1/capture-tasks/' + taskId + '/transcript');
      const foreignAi = await call(tokenB, '/v1/capture-tasks/' + taskId + '/ai-draft');
      expect(foreignTranscript.status).toBe(404);
      expect(foreignAi.status).toBe(404);

      const final = await call(tokenA, '/v1/capture-tasks/' + taskId + '/final-draft', 'PUT', {
        title: 'Human confirmed',
        markdown: '# Workflow complete\n\nHuman approved final.',
      });
      expect(final.status).toBe(200);
      const finalId = (await data(final)).data.draft.id as string;
      const deliveryPath = '/v1/capture-tasks/' + taskId + '/deliveries';
      const key = crypto.randomUUID();
      const delivered = await call(tokenA, deliveryPath, 'POST', {
        destination: 'github',
        idempotencyKey: key,
      });
      expect(delivered.status).toBe(200);
      const delivery = await data(delivered);
      expect(delivery.data.record).toMatchObject({
        taskId, finalDraftId: finalId, status: 'succeeded',
        commitSha: 'shy009-workflow-fixture-commit',
      });

      const denied = await call(tokenB, deliveryPath, 'POST', {
        destination: 'github',
        idempotencyKey: crypto.randomUUID(),
      });
      expect(denied.status).toBe(404);
      const replay = await data(await call(tokenA, deliveryPath, 'POST', {
        destination: 'github',
        idempotencyKey: key,
      }));
      expect(replay.data.record.id).toBe(delivery.data.record.id);
      const rows = await runtime.DB.prepare(
        'SELECT COUNT(*) AS count FROM delivery_records WHERE task_id = ?',
      ).bind(taskId).first<{ count: number }>();
      expect(rows?.count).toBe(1);
    } finally {
      await instance.dispose();
    }
  }, 25000);
});
