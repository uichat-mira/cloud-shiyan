# Cloud Shiyan

Cloud Shiyan is the Organization-owned cloud runtime for Mira 拾言 (Shiyan).

It follows the organization-wide [Mira Cloud Core Specification](https://github.com/uichat-mira/.github/blob/main/docs/engineering/mira-cloud.md): clients depend on stable Mira Cloud contracts rather than Worker/repository topology, and a service defaults to the fewest practical deployment units.

## Current target runtime

Cloud Shiyan intentionally converges the current Shiyan cloud implementation into **one Cloudflare Worker deployment**:

```text
Mira Mobile
    |
    v
mira-shiyan
    |-- HTTP API / device credential compatibility
    |-- CaptureTask lifecycle
    |-- Cloudflare Workflow
    |-- Workers AI STT
    |-- LLM organize / adjust module
    |-- GitHub Destination
    |-- D1
    `-- R2
```

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

The old repository and existing Cloudflare deployments remain untouched until the new service passes real environment and end-to-end acceptance. They remain the rollback anchor for this consolidation.

## Bindings and configuration

`wrangler.jsonc` defines the target single runtime contract:

- `DB` — D1 database `mira-shiyan`
- `AUDIO` — R2 bucket `mira-shiyan-audio`
- `AI` — Cloudflare Workers AI
- `CAPTURE_WORKFLOW` — `mira-shiyan-capture`
- hourly scheduled cleanup

The inherited runtime also requires configuration/secrets that currently exist across the two legacy Workers. Secret values are never stored in this repository.

Shiyan/API and Destination:

- `DEVICE_AUTH_PEPPER`
- `GITHUB_DESTINATION_TOKEN`
- `R2_ACCOUNT_ID`
- `R2_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY`
- `R2_BUCKET_NAME`
- `UPLOAD_TTL_SECONDS`
- optional Destination owner/repository/branch/root configuration where used by the implementation

LLM:

- `LLM_PRIMARY_PROVIDER`
- `LLM_PRIMARY_BASE_URL`
- `LLM_PRIMARY_MODEL`
- `LLM_PRIMARY_API_KEY`
- optional `LLM_FALLBACK_PROVIDER`
- optional `LLM_FALLBACK_BASE_URL`
- optional `LLM_FALLBACK_MODEL`
- optional `LLM_FALLBACK_API_KEY`
- `LLM_TIMEOUT_MS`
- `LLM_MAX_TRANSCRIPT_CHARS`

The existing Shiyan device credential remains a compatibility mechanism during bootstrap. It must not be promoted into the organization-wide authentication design. Cloud Shiyan is expected to converge on Mira Cloud shared identity while keeping service-specific authorization scoped to Shiyan.

The checked-in D1 `database_id` remains a placeholder until the real resource identity is deliberately wired for deployment. Read-only Cloudflare preflight has independently identified the current `mira-shiyan` D1 and other bindings; deployment configuration must still be reviewed before cutover.

## Engineering flow

Organization standard:

```text
feat/* -> dev -> test -> prod
```

The empty repository was initialized on `prod` with a minimal README solely to establish the first Git ref. `dev` and `test` were created from that same bootstrap commit. Corrected implementation work is developed on a `feat/*` branch and merges first to `dev`; promotion then follows `dev -> test -> prod` with environment evidence at each step.

CI validates:

- project dependency installation;
- generated Cloudflare runtime/binding types;
- TypeScript;
- the full inherited STT, Workflow, LLM organize/adjust, and Destination test suite;
- single-Worker Wrangler dry-run;
- absence of the obsolete `mira-shiyan-llm` deployment topology;
- all inherited D1 migrations.

## Migration status

Repository bootstrap is tracked in [Issue #1](https://github.com/uichat-mira/cloud-shiyan/issues/1). Real Cloudflare preflight/cutover is tracked separately in [Issue #3](https://github.com/uichat-mira/cloud-shiyan/issues/3).

A green repository CI proves only that the clean single-Worker source is internally valid. It does **not** prove Cloudflare cutover. Production completion requires real bindings/secrets, deployment verification, health check, Mobile-to-Shiyan end-to-end smoke, Destination delivery, and a confirmed rollback path before old deployments are retired.
