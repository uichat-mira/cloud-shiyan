import { describe, expect, it } from 'vitest';
import { env, exports } from 'cloudflare:workers';

const runtime = env as typeof env & {
  DB: D1Database;
  AUDIO: R2Bucket;
};

const worker = exports.default as {
  fetch(request: Request): Promise<Response>;
};

describe('Cloud Shiyan Worker runtime', () => {
  it('serves health from the Worker entrypoint without authentication', async () => {
    const response = await worker.fetch(
      new Request('https://shiyan.test/health', {
        headers: { 'x-request-id': 'runtime-health-test' },
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      data: { service: 'mira-shiyan' },
      requestId: 'runtime-health-test',
    });
  });

  it('rejects protected API routes without a device credential', async () => {
    const response = await worker.fetch(
      new Request('https://shiyan.test/v1/capture-tasks', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-request-id': 'runtime-auth-test',
        },
        body: JSON.stringify({}),
      }),
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      ok: false,
      error: {
        code: 'device_unauthorized',
        message: 'Valid Shiyan device credential required',
        retryable: false,
      },
      requestId: 'runtime-auth-test',
    });
  });

  it('applies the canonical D1 schema inside the Workers runtime', async () => {
    const result = await runtime.DB.prepare(
      `SELECT name FROM sqlite_schema
       WHERE type = 'table' AND name IN (
         'devices',
         'capture_tasks',
         'capture_stages',
         'audio_assets',
         'transcripts',
         'transcript_segments',
         'delivery_records',
         'drafts',
         'scenes'
       )
       ORDER BY name`,
    ).all<{ name: string }>();

    expect((result.results ?? []).map((row) => row.name)).toEqual([
      'audio_assets',
      'capture_stages',
      'capture_tasks',
      'delivery_records',
      'devices',
      'drafts',
      'scenes',
      'transcript_segments',
      'transcripts',
    ]);
  });

  it('round-trips an ephemeral object through the configured R2 binding', async () => {
    const key = `test/runtime/${crypto.randomUUID()}.txt`;

    await runtime.AUDIO.put(key, 'mira-runtime-test', {
      httpMetadata: { contentType: 'text/plain' },
    });

    const object = await runtime.AUDIO.get(key);
    expect(object).not.toBeNull();
    expect(await object?.text()).toBe('mira-runtime-test');
    expect(object?.httpMetadata?.contentType).toBe('text/plain');

    await runtime.AUDIO.delete(key);
    expect(await runtime.AUDIO.head(key)).toBeNull();
  });
});
