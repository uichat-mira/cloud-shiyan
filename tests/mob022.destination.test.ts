import assert from 'node:assert/strict';
import test from 'node:test';
import {
  GithubDestinationAdapter,
  renderGithubDestinationMarkdown,
} from '../src/shared/githubDestination';
import type { DestinationDeliveryInput } from '../src/shared/destination';

const INPUT: DestinationDeliveryInput = {
  taskId: '11111111-1111-4111-8111-111111111111',
  finalDraftId: 'final-1',
  idempotencyKey: 'deliver-1',
  title: 'Mira weekly review',
  markdown: '# Summary\n\nDone.',
  confirmedAt: '2026-08-29T03:00:00.000Z',
};

const base64 = (value: string): string => Buffer.from(value, 'utf8').toString('base64');

const queuedFetch = (responses: Response[], calls: Array<{ url: string; init?: RequestInit }>) =>
  async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(input), init });
    const response = responses.shift();
    if (!response) throw new Error('unexpected_fetch');
    return response;
  };

test('Cloudflare-compatible fetch is invoked detached from the adapter instance', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const strictFetch = function (
    this: unknown,
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    assert.equal(this, undefined);
    calls.push({ url: String(input), init });
    return Promise.resolve(new Response(null, { status: 503 }));
  } as typeof fetch;
  const adapter = new GithubDestinationAdapter({ token: 'secret-token' }, strictFetch);

  const result = await adapter.deliver(INPUT);

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, 'github_unavailable');
  assert.equal(calls.length, 1);
});

test('GitHub destination creates one deterministic Markdown file and returns canonical evidence', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const adapter = new GithubDestinationAdapter(
    { token: 'secret-token' },
    queuedFetch(
      [
        new Response(null, { status: 404 }),
        Response.json(
          {
            content: {
              path: 'entries/2026/08/11111111-1111-4111-8111-111111111111.md',
              html_url:
                'https://github.com/dangjingtao/mira-shiyan/blob/main/entries/2026/08/11111111-1111-4111-8111-111111111111.md',
            },
            commit: { sha: 'commit-create-1' },
          },
          { status: 201 },
        ),
      ],
      calls,
    ),
  );

  const result = await adapter.deliver(INPUT);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.repository, 'dangjingtao/mira-shiyan');
  assert.equal(result.value.path, 'entries/2026/08/11111111-1111-4111-8111-111111111111.md');
  assert.equal(result.value.commitSha, 'commit-create-1');
  assert.match(result.value.fileUrl, /github\.com\/dangjingtao\/mira-shiyan\/blob\/main/);
  assert.equal(calls.length, 2);
  assert.equal(calls[0]?.init?.method, 'GET');
  assert.equal(calls[1]?.init?.method, 'PUT');
  const body = JSON.parse(String(calls[1]?.init?.body)) as { content: string; message: string };
  const markdown = Buffer.from(body.content, 'base64').toString('utf8');
  assert.match(markdown, /shiyan_task_id: "11111111-1111-4111-8111-111111111111"/);
  assert.match(markdown, /shiyan_final_draft_id: "final-1"/);
  assert.equal(body.message, 'shiyan: publish 11111111-1111-4111-8111-111111111111');
});

test('uncertain retry reuses the same existing content instead of creating a duplicate file', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const markdown = renderGithubDestinationMarkdown(INPUT);
  const adapter = new GithubDestinationAdapter(
    { token: 'secret-token' },
    queuedFetch(
      [
        Response.json({
          type: 'file',
          encoding: 'base64',
          content: base64(markdown),
          html_url:
            'https://github.com/dangjingtao/mira-shiyan/blob/main/entries/2026/08/11111111-1111-4111-8111-111111111111.md',
        }),
        Response.json([{ sha: 'commit-existing-1' }]),
      ],
      calls,
    ),
  );

  const result = await adapter.deliver(INPUT);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.commitSha, 'commit-existing-1');
  assert.equal(calls.length, 2);
  assert.ok(calls.every((call) => call.init?.method !== 'PUT'));
});

test('concurrent create conflict re-reads identical content and recovers instead of duplicating', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const markdown = renderGithubDestinationMarkdown(INPUT);
  const adapter = new GithubDestinationAdapter(
    { token: 'secret-token' },
    queuedFetch(
      [
        new Response(null, { status: 404 }),
        new Response(null, { status: 422 }),
        Response.json({
          type: 'file',
          encoding: 'base64',
          content: base64(markdown),
          html_url:
            'https://github.com/dangjingtao/mira-shiyan/blob/main/entries/2026/08/11111111-1111-4111-8111-111111111111.md',
        }),
        Response.json([{ sha: 'commit-concurrent-1' }]),
      ],
      calls,
    ),
  );

  const result = await adapter.deliver(INPUT);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.commitSha, 'commit-concurrent-1');
  assert.equal(calls.filter((call) => call.init?.method === 'PUT').length, 1);
});

test('different content at the deterministic path is a terminal conflict', async () => {
  const adapter = new GithubDestinationAdapter(
    { token: 'secret-token' },
    queuedFetch(
      [
        Response.json({
          type: 'file',
          encoding: 'base64',
          content: base64('different formal content'),
          html_url: 'https://github.com/example',
        }),
      ],
      [],
    ),
  );

  const result = await adapter.deliver(INPUT);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.kind, 'terminal');
  assert.equal(result.error.code, 'github_path_conflict');
});

test('GitHub 5xx and rate limits are retryable, permission errors are terminal', async () => {
  const unavailable = new GithubDestinationAdapter(
    { token: 'secret-token' },
    queuedFetch([new Response(null, { status: 503 })], []),
  );
  const unavailableResult = await unavailable.deliver(INPUT);
  assert.equal(unavailableResult.ok, false);
  if (!unavailableResult.ok) {
    assert.equal(unavailableResult.error.kind, 'retryable');
    assert.equal(unavailableResult.error.code, 'github_unavailable');
  }

  const limited = new GithubDestinationAdapter(
    { token: 'secret-token' },
    queuedFetch(
      [
        new Response(null, {
          status: 403,
          headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '9999999999' },
        }),
      ],
      [],
    ),
  );
  const limitedResult = await limited.deliver(INPUT);
  assert.equal(limitedResult.ok, false);
  if (!limitedResult.ok) {
    assert.equal(limitedResult.error.kind, 'retryable');
    assert.equal(limitedResult.error.code, 'github_rate_limited');
  }

  const denied = new GithubDestinationAdapter(
    { token: 'secret-token' },
    queuedFetch([new Response(null, { status: 403 })], []),
  );
  const deniedResult = await denied.deliver(INPUT);
  assert.equal(deniedResult.ok, false);
  if (!deniedResult.ok) {
    assert.equal(deniedResult.error.kind, 'terminal');
    assert.equal(deniedResult.error.code, 'github_permission_denied');
    assert.doesNotMatch(deniedResult.error.message, /secret-token/);
  }
});
