import assert from 'node:assert/strict';
import test from 'node:test';
import { createShiyanLlmService } from '../src/llm';
import { resolveLlmSlots } from '../src/shared/llmGateway';

test('SHIYAN_LLM_CONFIG resolves one project-owned provider slot', () => {
  const resolved = resolveLlmSlots({
    SHIYAN_LLM_CONFIG: JSON.stringify({
      provider: 'shiyan-provider',
      baseUrl: 'https://llm.example.com/v1',
      model: 'shiyan-model',
      apiKey: 'shiyan-secret',
    }),
    LLM_TIMEOUT_MS: '45000',
  });

  assert.deepEqual(resolved.primary, {
    provider: 'shiyan-provider',
    baseUrl: 'https://llm.example.com/v1',
    model: 'shiyan-model',
    apiKey: 'shiyan-secret',
  });
  assert.equal(resolved.fallback, null);
  assert.equal(resolved.timeoutMs, 45_000);
});

test('SHIYAN_LLM_CONFIG defaults provider label and wins over legacy variables', () => {
  const resolved = resolveLlmSlots({
    SHIYAN_LLM_CONFIG: JSON.stringify({
      baseUrl: 'https://business-llm.example.com/v1',
      model: 'business-model',
      apiKey: 'business-secret',
    }),
    LLM_PRIMARY_PROVIDER: 'legacy-primary',
    LLM_PRIMARY_BASE_URL: 'https://legacy.example.com/v1',
    LLM_PRIMARY_MODEL: 'legacy-model',
    LLM_PRIMARY_API_KEY: 'legacy-secret',
    LLM_FALLBACK_PROVIDER: 'legacy-fallback',
    LLM_FALLBACK_BASE_URL: 'https://fallback.example.com/v1',
    LLM_FALLBACK_MODEL: 'fallback-model',
    LLM_FALLBACK_API_KEY: 'fallback-secret',
  });

  assert.equal(resolved.primary?.provider, 'openai-compatible');
  assert.equal(resolved.primary?.baseUrl, 'https://business-llm.example.com/v1');
  assert.equal(resolved.primary?.model, 'business-model');
  assert.equal(resolved.primary?.apiKey, 'business-secret');
  assert.equal(resolved.fallback, null);
});

test('legacy LLM variables remain compatible only when SHIYAN_LLM_CONFIG is absent', () => {
  const resolved = resolveLlmSlots({
    LLM_PRIMARY_PROVIDER: 'legacy',
    LLM_PRIMARY_BASE_URL: 'https://legacy.example.com/v1',
    LLM_PRIMARY_MODEL: 'legacy-model',
    LLM_PRIMARY_API_KEY: 'legacy-secret',
  });

  assert.equal(resolved.primary?.provider, 'legacy');
  assert.equal(resolved.primary?.model, 'legacy-model');
});

test('malformed SHIYAN_LLM_CONFIG fails closed without echoing secret contents', () => {
  assert.throws(
    () => resolveLlmSlots({ SHIYAN_LLM_CONFIG: '{not-json-secret-value' }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, 'SHIYAN_LLM_CONFIG is invalid JSON');
      assert.ok(!error.message.includes('not-json-secret-value'));
      return true;
    },
  );
});

test('single missing double quote repair stays opt-in and uniquely restores the cutover config', () => {
  const valid = JSON.stringify({
    provider: 'openai-compatible',
    baseUrl: 'https://llm.example.com/v1',
    model: 'shiyan-model',
    apiKey: 'shiyan-secret',
  });
  const malformed = valid.replace(
    'https://llm.example.com/v1"',
    'https://llm.example.com/v1',
  );

  assert.throws(
    () => resolveLlmSlots({ SHIYAN_LLM_CONFIG: malformed }),
    /SHIYAN_LLM_CONFIG is invalid JSON/u,
  );

  const resolved = resolveLlmSlots({
    SHIYAN_LLM_CONFIG: malformed,
    SHIYAN_LLM_CONFIG_REPAIR_SINGLE_MISSING_DOUBLE_QUOTE: '1',
  });

  assert.deepEqual(resolved.primary, {
    provider: 'openai-compatible',
    baseUrl: 'https://llm.example.com/v1',
    model: 'shiyan-model',
    apiKey: 'shiyan-secret',
  });
});

test('cutover repair still fails closed when no unique one-quote repair exists', () => {
  assert.throws(
    () =>
      resolveLlmSlots({
        SHIYAN_LLM_CONFIG: '{not-json-secret-value',
        SHIYAN_LLM_CONFIG_REPAIR_SINGLE_MISSING_DOUBLE_QUOTE: '1',
      }),
    /SHIYAN_LLM_CONFIG is invalid JSON/u,
  );
});

test('incomplete SHIYAN_LLM_CONFIG fails closed with a field-level diagnostic', () => {
  assert.throws(
    () =>
      resolveLlmSlots({
        SHIYAN_LLM_CONFIG: JSON.stringify({
          baseUrl: 'https://llm.example.com/v1',
          model: 'model-only',
        }),
      }),
    /apiKey must be a non-empty string/u,
  );
});


test('LLM service construction is lazy so unrelated routes do not parse provider config', () => {
  assert.doesNotThrow(() =>
    createShiyanLlmService({
      SHIYAN_LLM_CONFIG: '{malformed-at-runtime',
    }),
  );
});
