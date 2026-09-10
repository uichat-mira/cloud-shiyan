import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

const rootDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      // Deliberately do not load production wrangler.jsonc here. Workers AI is
      // remote-only in Miniflare and loading that binding would make ordinary
      // PR tests depend on Cloudflare credentials. Wrangler configuration is
      // validated separately by `npm run dry-run`.
      main: path.join(rootDir, 'src/api/index.ts'),
      miniflare: {
        compatibilityDate: '2026-08-29',
        d1Databases: ['DB'],
        r2Buckets: ['AUDIO'],
        serviceBindings: {
          AI: async () => new Response('Workers AI is not available in local T3 tests', { status: 501 }),
        },
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations(path.join(rootDir, 'migrations')),
          R2_BUCKET_NAME: 'mira-shiyan-audio',
          UPLOAD_TTL_SECONDS: '900',
          R2_ACCOUNT_ID: 'test-account',
          R2_ACCESS_KEY_ID: 'test-access-key',
          R2_SECRET_ACCESS_KEY: 'test-secret-key',
          DEVICE_AUTH_PEPPER: 'test-pepper',
          GITHUB_DESTINATION_TOKEN: 'test-github-token',
          LLM_TIMEOUT_MS: '120000',
          LLM_MAX_TRANSCRIPT_CHARS: '200000',
          LLM_PRIMARY_API_KEY: 'test-llm-key',
          LLM_PRIMARY_PROVIDER: 'openai-compatible',
          LLM_PRIMARY_BASE_URL: 'https://example.invalid/v1',
          LLM_PRIMARY_MODEL: 'test-model',
        },
      },
    })),
  ],
  test: {
    include: ['tests/runtime/**/*.test.ts'],
    setupFiles: ['./tests/runtime/setup.ts'],
  },
});
