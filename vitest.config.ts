import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

const rootDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: {
        configPath: path.join(rootDir, 'wrangler.jsonc'),
      },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations(path.join(rootDir, 'migrations')),
          R2_ACCOUNT_ID: 'test-account',
          R2_ACCESS_KEY_ID: 'test-access-key',
          R2_SECRET_ACCESS_KEY: 'test-secret-key',
          DEVICE_AUTH_PEPPER: 'test-pepper',
          GITHUB_DESTINATION_TOKEN: 'test-github-token',
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
