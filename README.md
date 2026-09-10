# Cloud Shiyan

Cloud Shiyan is the Organization-owned cloud runtime for Mira 拾言 (Shiyan).

It follows the organization-wide [Mira Cloud Core Specification](https://github.com/uichat-mira/.github/blob/main/docs/engineering/mira-cloud.md): clients depend on stable Mira Cloud contracts rather than Worker/repository topology, and a service defaults to the fewest practical deployment units.

## Current target runtime

Cloud Shiyan intentionally converges the current Shiyan cloud implementation into **one Cloudflare Worker deployment**. During migration the existing public Worker identity is preserved to minimize operational risk:

```text
Mira Mobile
    |
    v
mira-shiyan-api   (stable deployed Worker name)
    |-- HTTP API / device credential compatibility
    |-- CaptureTask lifecycle
    |-- Cloudflare Workflow
    |-- Workers AI STT
    |-- LLM organize / adjust module
    |-- GitHub Destination
    |-- D1
    `-- R2
```

The repository/service is Cloud Shiyan; retaining the deployed Worker name `mira-shiyan-api` is an operational compatibility choice, not a second architectural service. It preserves the existing custom domain and API-owned runtime secrets during cutover. Renaming a healthy deployed Worker is not part of this migration.

The former private `mira-shiyan-llm` deployment boundary is not carried forward. `src/llm/` remains a logical module boundary backed by the same `ShiyanLlmGateway`, provider-slot resolution, prompt/schema validation, fallback behavior, and normalized outcomes from the effective legacy `dev` implementation. It can be split again later if a real security, scaling, release, fault-isolation, or reuse requirement justifies another deployment unit.

## Canonical product truth

This repository owns the Shiyan cloud implementation. It does not independently redefine Shiyan product semantics or cross-client contracts.

Canonical Shiyan product/technical contracts live in `uichat-mira/mira-mobile` under `docs/shiyan/`.

If cloud implementation needs to change CaptureTask/stage semantics, API contracts, Mobile/Desktop responsibilities, or Destination behavior, update and review canonical truth first.

## Source and rollback anchor

The effective bootstrap source is the legacy repository's `dev` branch:

```text
dangjingtao/mira-shiyan-cloud@03e8c12db80c1f879da2aabf268d5b5e0769c01a
```

This baseline includes the implemented MOB-020 LLM organization flow, MOB-022 GitHub Destination, D1 migrations, and their test suites. The older legacy `main@3917d00c...` is not the effective runtime source and must not be used as a migration baseline.

The old repository and existing Cloudflare deployments remain untouched until the Organization-owned source passes real environment and end-to-end acceptance. They remain the rollback anchor for this consolidation.

## Bindings and configuration

`wrangler.jsonc` defines the target single runtime contract:

- deployed Worker: `mira-shiyan-api`
- custom domain: `shiyan-api.tomz.io`
- `DB` — D1 database `mira-shiyan`, UUID `5f923203-bb4f-40a1-9b83-d6cf493f3114`
- `AUDIO` — R2 bucket `mira-shiyan-audio`
- `AI` — Cloudflare Workers AI
- `CAPTURE_WORKFLOW` — `mira-shiyan-capture`
- hourly scheduled cleanup

Secret values are never stored in this repository. Read-only Cloudflare preflight proved that the existing `mira-shiyan-api` Worker already owns the API-side secrets required by the current service:

- `DEVICE_AUTH_PEPPER`
- `GITHUB_DESTINATION_TOKEN`
- `R2_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY`

It also proved that the legacy `mira-shiyan-llm` Worker owns the current LLM configuration:

- `LLM_PRIMARY_PROVIDER`
- `LLM_PRIMARY_BASE_URL`
- `LLM_PRIMARY_MODEL`
- `LLM_PRIMARY_API_KEY`
- `LLM_TIMEOUT_MS`
- `LLM_MAX_TRANSCRIPT_CHARS`

No fallback LLM slot is currently configured.

The plain-text LLM settings can be read from the legacy Worker during a controlled preview/deploy workflow without logging their values. `LLM_PRIMARY_API_KEY` is a Cloudflare secret and cannot be read back for copying. Before the final single-Worker cutover, `mira-shiyan-api` must therefore receive a valid `LLM_PRIMARY_API_KEY` (the existing key re-entered or a rotated replacement). This is the remaining runtime-secret blocker.

The existing Shiyan device credential remains a compatibility mechanism during bootstrap. It must not be promoted into the organization-wide authentication design. Cloud Shiyan is expected to converge on Mira Cloud shared identity while keeping service-specific authorization scoped to Shiyan.

## Engineering flow

Organization standard:

```text
feat/* -> dev -> test -> prod
```

The empty repository was initialized on `prod` solely to establish the first Git ref. `dev` and `test` were created from that same bootstrap commit. Corrected implementation work merges first to `dev`; promotion then follows `dev -> test -> prod` with environment evidence at each step.

CI validates:

- project dependency installation;
- generated Cloudflare runtime/binding types;
- TypeScript;
- the full inherited STT, Workflow, LLM organize/adjust, and Destination test suite;
- single-Worker Wrangler dry-run;
- absence of the obsolete `mira-shiyan-llm` deployment topology from the target config;
- all inherited D1 migrations.

## Cutover strategy

Production traffic is not the first live test. The migration uses Cloudflare Worker versions in two separate operations:

1. build an effective config from the reviewed repository plus the legacy Worker's non-secret LLM settings;
2. require all target runtime secrets, including `LLM_PRIMARY_API_KEY`;
3. upload a new `mira-shiyan-api` **version only** and obtain a preview URL;
4. run health and authenticated Shiyan smoke tests against the preview version;
5. only after preview acceptance, create a production deployment;
6. keep the legacy LLM Worker and old repository available as rollback anchors until the observation window passes.

`.github/workflows/cutover-preview.yml` is manual-only and hard-gated. It uploads a version with `wrangler versions upload`; it does not deploy production traffic.

## Migration status

Repository/source convergence is tracked in [Issue #1](https://github.com/uichat-mira/cloud-shiyan/issues/1). Real Cloudflare preflight/cutover is tracked in [Issue #3](https://github.com/uichat-mira/cloud-shiyan/issues/3).

Repository CI and the corrected `dev` branch are green. That proves the single-Worker source is internally valid, not that production has been cut over. Production completion still requires the LLM secret on the target Worker, preview acceptance, Mobile-to-Shiyan end-to-end smoke, Destination delivery, production deployment verification, and a confirmed rollback path before the legacy Worker is retired.
