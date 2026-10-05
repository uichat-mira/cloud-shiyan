import type {
  DestinationAdapter,
  DestinationDeliveryInput,
  DestinationFailure,
  DestinationResult,
  DestinationSuccess,
} from './destination';

export interface GithubDestinationConfig {
  token: string;
  owner?: string;
  repository?: string;
  branch?: string;
  contentRoot?: string;
  apiBaseUrl?: string;
}

export type GithubFetch = typeof fetch;

type GithubContentResponse = {
  type?: string;
  content?: string;
  encoding?: string;
  sha?: string;
  html_url?: string;
};

type GithubWriteResponse = {
  content?: { html_url?: string; path?: string };
  commit?: { sha?: string };
};

type GithubCommitResponse = Array<{ sha?: string }>;

const DEFAULT_OWNER = 'dangjingtao';
const DEFAULT_REPOSITORY = 'mira-shiyan';
const DEFAULT_BRANCH = 'main';
const DEFAULT_CONTENT_ROOT = 'entries';
const DEFAULT_API_BASE = 'https://api.github.com';

const yamlString = (value: string): string => JSON.stringify(value);

const encodePath = (value: string): string =>
  value
    .split('/')
    .filter(Boolean)
    .map((part) => encodeURIComponent(part))
    .join('/');

const utf8ToBase64 = (value: string): string => {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
};

const base64ToUtf8 = (value: string): string => {
  const normalized = value.replace(/\s+/gu, '');
  const binary = atob(normalized);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new TextDecoder().decode(bytes);
};

const normalizeMarkdown = (value: string): string => value.replace(/\r\n?/gu, '\n').trimEnd();

export const buildGithubDestinationPath = (
  taskId: string,
  confirmedAt: string,
  contentRoot = DEFAULT_CONTENT_ROOT,
): string => {
  const date = new Date(confirmedAt);
  if (Number.isNaN(date.getTime())) {
    throw new Error('invalid_confirmed_at');
  }
  const year = String(date.getUTCFullYear()).padStart(4, '0');
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${contentRoot.replace(/^\/+|\/+$/gu, '')}/${year}/${month}/${taskId}.md`;
};

export const renderGithubDestinationMarkdown = (input: DestinationDeliveryInput): string => {
  const body = normalizeMarkdown(input.markdown);
  return [
    '---',
    `title: ${yamlString(input.title)}`,
    `shiyan_task_id: ${yamlString(input.taskId)}`,
    `shiyan_final_draft_id: ${yamlString(input.finalDraftId)}`,
    `published_at: ${yamlString(input.confirmedAt)}`,
    '---',
    '',
    body,
    '',
  ].join('\n');
};

const retryAfterSeconds = (response: Response): number | undefined => {
  const retryAfter = response.headers.get('retry-after');
  if (retryAfter !== null && retryAfter.trim() !== '') {
    const direct = Number(retryAfter);
    if (Number.isFinite(direct) && direct >= 0) return Math.ceil(direct);
  }
  if (response.headers.get('x-ratelimit-remaining') === '0') {
    const resetHeader = response.headers.get('x-ratelimit-reset');
    if (resetHeader !== null && resetHeader.trim() !== '') {
      const reset = Number(resetHeader);
      if (Number.isFinite(reset)) {
        return Math.max(0, Math.ceil(reset - Date.now() / 1000));
      }
    }
  }
  return undefined;
};

const classifyGithubFailure = (response: Response): DestinationFailure => {
  const retryAfter = retryAfterSeconds(response);
  const rateLimited = response.status === 429 || retryAfter !== undefined;
  if (rateLimited) {
    return {
      kind: 'retryable',
      code: 'github_rate_limited',
      message: 'GitHub rate limit prevented delivery',
      ...(retryAfter !== undefined ? { retryAfterSeconds: retryAfter } : {}),
    };
  }
  if (response.status === 401) {
    return {
      kind: 'terminal',
      code: 'github_auth_failed',
      message: 'GitHub destination credential was rejected',
    };
  }
  if (response.status === 403) {
    return {
      kind: 'terminal',
      code: 'github_permission_denied',
      message: 'GitHub destination credential lacks repository Contents permission',
    };
  }
  if (response.status >= 500 || response.status === 408) {
    return {
      kind: 'retryable',
      code: 'github_unavailable',
      message: 'GitHub destination is temporarily unavailable',
    };
  }
  if (response.status === 409 || response.status === 422) {
    return {
      kind: 'terminal',
      code: 'github_path_conflict',
      message: 'GitHub rejected the target path or content update',
    };
  }
  if (response.status === 404) {
    return {
      kind: 'terminal',
      code: 'github_destination_not_found',
      message: 'GitHub destination repository or branch was not found',
    };
  }
  return {
    kind: response.status >= 400 && response.status < 500 ? 'terminal' : 'retryable',
    code: 'github_delivery_failed',
    message: `GitHub destination request failed with status ${response.status}`,
  };
};

const networkFailure = (): DestinationFailure => ({
  kind: 'retryable',
  code: 'github_network_error',
  message: 'GitHub destination request could not reach GitHub',
});

export class GithubDestinationAdapter implements DestinationAdapter {
  private readonly owner: string;
  private readonly repository: string;
  private readonly branch: string;
  private readonly contentRoot: string;
  private readonly apiBaseUrl: string;

  constructor(
    private readonly config: GithubDestinationConfig,
    private readonly fetchImpl: GithubFetch = fetch,
  ) {
    this.owner = config.owner ?? DEFAULT_OWNER;
    this.repository = config.repository ?? DEFAULT_REPOSITORY;
    this.branch = config.branch ?? DEFAULT_BRANCH;
    this.contentRoot = config.contentRoot ?? DEFAULT_CONTENT_ROOT;
    this.apiBaseUrl = (config.apiBaseUrl ?? DEFAULT_API_BASE).replace(/\/+$/gu, '');
  }

  private headers(): HeadersInit {
    return {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${this.config.token}`,
      'content-type': 'application/json',
      'user-agent': 'mira-shiyan-cloud',
      'x-github-api-version': '2022-11-28',
    };
  }

  private fetchGithub(...args: Parameters<GithubFetch>): ReturnType<GithubFetch> {
    // Cloudflare Workers' native fetch must be called without rebinding `this`.
    // Calling it as `this.fetchImpl(...)` throws an Illegal invocation TypeError.
    const fetchImpl = this.fetchImpl;
    return fetchImpl(...args);
  }

  private contentUrl(path: string): string {
    return `${this.apiBaseUrl}/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repository)}/contents/${encodePath(path)}`;
  }

  private async latestCommitSha(path: string): Promise<string | DestinationFailure> {
    const query = new URLSearchParams({ path, sha: this.branch, per_page: '1' });
    const url = `${this.apiBaseUrl}/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repository)}/commits?${query.toString()}`;
    let response: Response;
    try {
      response = await this.fetchGithub(url, { headers: this.headers() });
    } catch {
      return networkFailure();
    }
    if (!response.ok) return classifyGithubFailure(response);
    const value = (await response.json()) as GithubCommitResponse;
    const sha = value[0]?.sha;
    return typeof sha === 'string' && sha.length > 0
      ? sha
      : {
          kind: 'retryable',
          code: 'github_commit_missing',
          message: 'GitHub did not return the commit for the delivered file',
        };
  }

  private async recoverExistingIdentical(
    path: string,
    markdown: string,
  ): Promise<{ found: false } | { found: true; result: DestinationResult }> {
    const url = this.contentUrl(path);
    let response: Response;
    try {
      response = await this.fetchGithub(`${url}?ref=${encodeURIComponent(this.branch)}`, {
        method: 'GET',
        headers: this.headers(),
      });
    } catch {
      return { found: true, result: { ok: false, error: networkFailure() } };
    }
    if (response.status === 404) return { found: false };
    if (!response.ok) {
      return { found: true, result: { ok: false, error: classifyGithubFailure(response) } };
    }

    const existing = (await response.json()) as GithubContentResponse;
    if (existing.type !== 'file' || existing.encoding !== 'base64' || typeof existing.content !== 'string') {
      return {
        found: true,
        result: {
          ok: false,
          error: {
            kind: 'terminal',
            code: 'github_path_conflict',
            message: 'GitHub target path exists but is not the expected Markdown file',
          },
        },
      };
    }

    let existingMarkdown: string;
    try {
      existingMarkdown = base64ToUtf8(existing.content);
    } catch {
      return {
        found: true,
        result: {
          ok: false,
          error: {
            kind: 'retryable',
            code: 'github_content_unreadable',
            message: 'Existing GitHub destination content could not be verified',
          },
        },
      };
    }
    if (existingMarkdown !== markdown) {
      return {
        found: true,
        result: {
          ok: false,
          error: {
            kind: 'terminal',
            code: 'github_path_conflict',
            message: 'GitHub target path already contains different confirmed content',
          },
        },
      };
    }

    const commitSha = await this.latestCommitSha(path);
    if (typeof commitSha !== 'string') {
      return { found: true, result: { ok: false, error: commitSha } };
    }
    const value: DestinationSuccess = {
      destination: 'github',
      repository: `${this.owner}/${this.repository}`,
      path,
      commitSha,
      fileUrl:
        existing.html_url ??
        `https://github.com/${this.owner}/${this.repository}/blob/${this.branch}/${path}`,
      deliveredAt: new Date().toISOString(),
    };
    return { found: true, result: { ok: true, value } };
  }

  async deliver(input: DestinationDeliveryInput): Promise<DestinationResult> {
    if (!this.config.token || !input.taskId || !input.finalDraftId || !input.idempotencyKey) {
      return {
        ok: false,
        error: {
          kind: 'terminal',
          code: 'github_destination_invalid_input',
          message: 'GitHub destination input or credential is missing',
        },
      };
    }

    let path: string;
    try {
      path = buildGithubDestinationPath(input.taskId, input.confirmedAt, this.contentRoot);
    } catch {
      return {
        ok: false,
        error: {
          kind: 'terminal',
          code: 'github_destination_invalid_input',
          message: 'Final Draft confirmation time is invalid',
        },
      };
    }

    const markdown = renderGithubDestinationMarkdown(input);
    const existing = await this.recoverExistingIdentical(path, markdown);
    if (existing.found) return existing.result;

    const url = this.contentUrl(path);
    let writeResponse: Response;
    try {
      writeResponse = await this.fetchGithub(url, {
        method: 'PUT',
        headers: this.headers(),
        body: JSON.stringify({
          message: `shiyan: publish ${input.taskId}`,
          content: utf8ToBase64(markdown),
          branch: this.branch,
        }),
      });
    } catch {
      return { ok: false, error: networkFailure() };
    }

    if (!writeResponse.ok) {
      if (writeResponse.status === 409 || writeResponse.status === 422) {
        const recovered = await this.recoverExistingIdentical(path, markdown);
        if (recovered.found) return recovered.result;
      }
      return { ok: false, error: classifyGithubFailure(writeResponse) };
    }

    const written = (await writeResponse.json()) as GithubWriteResponse;
    const commitSha = written.commit?.sha;
    const fileUrl = written.content?.html_url;
    if (!commitSha || !fileUrl) {
      return {
        ok: false,
        error: {
          kind: 'retryable',
          code: 'github_invalid_success_response',
          message: 'GitHub accepted delivery but did not return canonical commit evidence',
        },
      };
    }

    return {
      ok: true,
      value: {
        destination: 'github',
        repository: `${this.owner}/${this.repository}`,
        path: written.content?.path ?? path,
        commitSha,
        fileUrl,
        deliveredAt: new Date().toISOString(),
      },
    };
  }
}
