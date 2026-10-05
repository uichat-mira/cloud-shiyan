import { beforeAll } from 'vitest';
import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';

beforeAll(async () => {
  const runtime = env as typeof env & {
    DB: D1Database;
    TEST_MIGRATIONS: D1Migration[];
  };

  await applyD1Migrations(runtime.DB, runtime.TEST_MIGRATIONS);
});
