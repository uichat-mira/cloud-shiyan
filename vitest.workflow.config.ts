import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

const rootDir = path.dirname(fileURLToPath(import.meta.url));

/**
 * SHY-009 only: a self-contained automatic-Workflow test runtime.
 *
 * Workers AI is unavailable in local Miniflare. The test-only RPC binding provides
 * only the external Whisper inference response. Workerd, Workflow scheduling,
 * every internal Workflow step, D1 and R2 remain real. Production Wrangler
 * settings and the ordinary, deliberately failing AI test binding are intact.
 */
export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      main: path.join(rootDir, 'src/api/index.ts'),
      miniflare: {
        compatibilityDate: '2026-08-29',
        d1Databases: ['DB'],
        r2Buckets: ['AUDIO'],
        workflows: {
          CAPTURE_WORKFLOW: {
            name: 'mira-shiyan-capture',
            className: 'ShiyanCaptureWorkflow',
          },
        },
        serviceBindings: { AI: 'shiyan-whisper-fixture' },
        workers: [
          {
            name: 'shiyan-whisper-fixture',
            modules: true,
            compatibilityDate: '2026-08-29',
            script: [
              "import { WorkerEntrypoint } from 'cloudflare:workers';",
              'export default class FixtureAI extends WorkerEntrypoint {',
              '    async run(model, input) {',
              "      if (model !== '@cf/openai/whisper-large-v3-turbo' || input?.task !== 'transcribe' || typeof input.audio !== 'string') {",
              "        throw new Error('Unexpected Workers AI inference');",
              '      }',
              '      return {',
              "        text: 'SHY009_AUTOMATIC_WORKFLOW_TRANSCRIPT',",
              "        language: 'en',",
              "        segments: [{ start: 0, end: 1, text: 'SHY009_AUTOMATIC_WORKFLOW_TRANSCRIPT' }],",
              '      };',
              '    }',
              '}',
            ].join('\n'),
          },
        ],
        async outboundService(request) {
          const url = new URL(request.url);
          if (url.origin === 'https://example.invalid' && url.pathname.startsWith('/v1/')) {
            const payload = await request.json() as {
              messages?: Array<{ role?: string; content?: unknown }>;
            };
            const user = payload.messages?.find((message) => message.role === 'user');
            const prompt = typeof user?.content === 'string'
              ? user.content
              : JSON.stringify(user?.content ?? '');
            const sectionIds = [...prompt.matchAll(/^- id: ([a-z0-9-]+) \|/gmu)]
              .map((match) => match[1]);
            return Response.json({
              id: 'shy009-auto-fixture',
              object: 'chat.completion',
              created: 0,
              model: 'test-model',
              choices: [{
                index: 0,
                message: {
                  role: 'assistant',
                  content: JSON.stringify({
                    summary: 'Automatically organized from Workflow',
                    sections: sectionIds.map((id) => ({ id, items: [] })),
                  }),
                },
                finish_reason: 'stop',
              }],
              usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
            });
          }
          if (url.origin === 'https://api.github.com') {
            if (request.method === 'GET') return new Response(null, { status: 404 });
            if (request.method === 'PUT') {
              return Response.json({
                content: {
                  path: 'entries/fixture.md',
                  html_url: 'https://github.com/fixture/repo/blob/main/entries/fixture.md',
                },
                commit: { sha: 'shy009-workflow-fixture-commit' },
              }, { status: 201 });
            }
          }
          return new Response('Unexpected external request in SHY-009 Workflow test', { status: 599 });
        },
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations(path.join(rootDir, 'migrations')),
          R2_BUCKET_NAME: 'mira-shiyan-audio',
          UPLOAD_TTL_SECONDS: '900',
          R2_ACCOUNT_ID: 'test-account',
          R2_ACCESS_KEY_ID: 'test-access-key',
          R2_SECRET_ACCESS_KEY: 'test-secret-key',
          DEVICE_AUTH_PEPPER: 'test-pepper',
          CLOUD_AUTH_JWKS_URL: 'https://cloud-auth.test/.well-known/jwks.json',
          GITHUB_DESTINATION_TOKEN: 'test-github-token',
          LLM_TIMEOUT_MS: '120000',
          LLM_MAX_TRANSCRIPT_CHARS: '200000',
          SHIYAN_LLM_CONFIG: JSON.stringify({
            provider: 'openai-compatible',
            baseUrl: 'https://example.invalid/v1',
            model: 'test-model',
            apiKey: 'test-llm-key',
          }),
        },
      },
    })),
  ],
  test: {
    include: ['tests/workflow/**/*.test.ts'],
    setupFiles: ['./tests/runtime/setup.ts'],
    testTimeout: 25000,
  },
});
