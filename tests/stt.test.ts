import assert from 'node:assert/strict';
import test from 'node:test';
import { executeSttStage } from '../src/shared/sttStage';
import type { SttProvider, SttSuccess } from '../src/shared/stt';
import { WorkersAiSttProvider } from '../src/shared/workersAiStt';

test('WorkersAiSttProvider forwards initial_prompt and normalizes transcript evidence', async () => {
  let receivedModel = '';
  let receivedInput: Record<string, unknown> = {};
  const provider = new WorkersAiSttProvider(
    {
      async run(model, input) {
        receivedModel = model;
        receivedInput = input;
        return {
          text: 'hello world',
          language: 'en',
          word_count: 2,
          request_id: 'cf-request-1',
          segments: [{ start: 0, end: 1.25, text: 'hello world' }],
        };
      },
    },
    async () => 'ZmFrZS1hdWRpbw==',
  );

  const result = await provider.transcribe({
    taskId: 'task-1',
    audioObjectKey: 'audio/key',
    contentType: 'audio/mp4',
    initialPrompt: 'Mira 拾言 terminology',
  });

  assert.equal(receivedModel, '@cf/openai/whisper-large-v3-turbo');
  assert.equal(receivedInput.initial_prompt, 'Mira 拾言 terminology');
  assert.equal(receivedInput.task, 'transcribe');
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.text, 'hello world');
  assert.deepEqual(result.value.segments, [
    { startMs: 0, endMs: 1250, text: 'hello world' },
  ]);
  assert.deepEqual(result.value.providerMetadata, { wordCount: 2 });
});

test('WorkersAiSttProvider classifies provider 5xx and timeout as retryable', async () => {
  const provider = new WorkersAiSttProvider(
    {
      async run() {
        throw new Error('503 upstream timeout');
      },
    },
    async () => 'ZmFrZQ==',
  );

  const result = await provider.transcribe({
    taskId: 'task-1',
    audioObjectKey: 'audio/key',
    contentType: 'audio/mp4',
  });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.kind, 'retryable');
  assert.equal(result.error.code, 'stt_provider_retryable');
});

test('WorkersAiSttProvider keeps invalid provider input terminal', async () => {
  const provider = new WorkersAiSttProvider(
    {
      async run() {
        throw new Error('400 invalid audio payload');
      },
    },
    async () => 'ZmFrZQ==',
  );

  const result = await provider.transcribe({
    taskId: 'task-1',
    audioObjectKey: 'audio/key',
    contentType: 'audio/mp4',
  });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.kind, 'terminal');
  assert.equal(result.error.code, 'stt_provider_error');
});

test('executeSttStage persists evidence before marking STT succeeded', async () => {
  const calls: string[] = [];
  const value: SttSuccess = {
    text: 'transcript',
    provider: 'test',
    model: 'test-model',
  };
  const provider: SttProvider = {
    async transcribe() {
      calls.push('provider');
      return { ok: true, value };
    },
  };

  const result = await executeSttStage(
    provider,
    { taskId: 'task-1', audioObjectKey: 'audio/key', contentType: 'audio/mp4' },
    {
      async markRunning() {
        calls.push('running');
      },
      async persistArtifact(received) {
        assert.equal(received, value);
        calls.push('artifact');
        return 'stt/normalized/task-1/attempt.json';
      },
      async markSucceeded(key) {
        assert.equal(key, 'stt/normalized/task-1/attempt.json');
        calls.push('succeeded');
      },
      async markFailed() {
        calls.push('failed');
      },
    },
  );

  assert.deepEqual(calls, ['running', 'provider', 'artifact', 'succeeded']);
  assert.deepEqual(result, {
    ok: true,
    artifactKey: 'stt/normalized/task-1/attempt.json',
  });
});

test('executeSttStage records retryable provider failure without persisting evidence', async () => {
  const calls: string[] = [];
  const provider: SttProvider = {
    async transcribe() {
      return {
        ok: false,
        error: { kind: 'retryable', code: 'stt_provider_retryable', message: '503' },
      };
    },
  };

  const result = await executeSttStage(
    provider,
    { taskId: 'task-1', audioObjectKey: 'audio/key', contentType: 'audio/mp4' },
    {
      async markRunning() {
        calls.push('running');
      },
      async persistArtifact() {
        calls.push('artifact');
        return 'never';
      },
      async markSucceeded() {
        calls.push('succeeded');
      },
      async markFailed(error) {
        calls.push(`failed:${error.kind}:${error.code}`);
      },
    },
  );

  assert.equal(result.ok, false);
  assert.deepEqual(calls, ['running', 'failed:retryable:stt_provider_retryable']);
});

test('executeSttStage treats evidence persistence failure as retryable STT failure', async () => {
  const provider: SttProvider = {
    async transcribe() {
      return {
        ok: true,
        value: { text: 'transcript', provider: 'test', model: 'test-model' },
      };
    },
  };
  let recordedCode = '';

  const result = await executeSttStage(
    provider,
    { taskId: 'task-1', audioObjectKey: 'audio/key', contentType: 'audio/mp4' },
    {
      async markRunning() {},
      async persistArtifact() {
        throw new Error('R2 unavailable');
      },
      async markSucceeded() {
        assert.fail('must not succeed when evidence persistence failed');
      },
      async markFailed(error) {
        recordedCode = error.code;
        assert.equal(error.kind, 'retryable');
      },
    },
  );

  assert.equal(result.ok, false);
  assert.equal(recordedCode, 'stt_artifact_persist_failed');
});
