# Cloud Shiyan

Cloud Shiyan is the Organization-owned cloud runtime for Mira 拾言 (Shiyan).

It follows the organization-wide [Mira Cloud Core Specification](https://github.com/uichat-mira/.github/blob/main/docs/engineering/mira-cloud.md): clients depend on stable Mira Cloud contracts rather than Worker/repository topology, and a service defaults to the fewest practical deployment units.

## Current runtime

Cloud Shiyan is intentionally **one Cloudflare Worker deployment**:

```text
Mira Mobile
    |
    v
mira-shiyan
    |-- HTTP API / device credential compatibility
    |-- CaptureTask lifecycle
    |-- Cloudflare Workflow
    |-- Workers AI STT
    |-- logical LLM module
    |-- D1
    `-- R2
```

The former private `mira-shiyan-llm` Worker boundary is not carried forward. `src/llm/` remains a logical module boundary so it can be split again later if real security, scaling, release, fault-isolation, or reuse requirements justify another deployment unit.

The LLM organize implementation is **not fabricated during bootstrap**. The inherited runtime currently reaches the `organize` stage after transcript persistence; `src/llm/index.ts` preserves the future service contract and still reports `provider_not_configured` until the canonical Shiyan work implements it.

## Canonical product truth

This repository owns the Shiyan cloud implementation. It does not independently redefine Shiyan product semantics or cross-client contracts.

Canonical Shiyan product/technical contracts live in `uichat-mira/mira-mobile` under `docs/shiyan/`.

If cloud implementation needs to change CaptureTask/stage semantics, API contracts, Mobile/Desktop responsibilities, or Destination behavior, update and review canonical truth first.

## Source and rollback anchor

The bootstrap source is:

```text
dangjingtao/mira-shiyan-cloud@3917d00c825ca9783e0cabfcd4dc11b79b5bd166
```

The old repository and existing Cloudflare deployments remain untouched until the new service passes real environment and end-to-end acceptance. They are the rollback anchor for this consolidation.

## Bindings

`wrangler.jsonc` defines the single runtime contract:

- `DB` — D1 database `mira-shiyan`
- `AUDIO` — R2 bucket `mira-shiyan-audio`
- `AI` — Cloudflare Workers AI
- `CAPTURE_WORKFLOW` — `mira-shiyan-capture`
- hourly scheduled cleanup

Runtime secrets required by the inherited implementation include:

- `DEVICE_AUTH_PEPPER`
- `R2_ACCOUNT_ID`
- `R2_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY`

The existing Shiyan device credential remains a compatibility mechanism during bootstrap. It must not be promoted into the organization-wide authentication design. Cloud Shiyan is expected to converge on Mira Cloud shared identity while keeping service-specific authorization scoped to Shiyan.

The checked-in D1 `database_id` is intentionally a placeholder. Real resource IDs and secrets must be verified against the actual Cloudflare environment before deployment; repository text is not proof of deployed state.

## Engineering flow

Organization standard:

```text
feat/* -> dev -> test -> prod
```

The empty repository was initialized on `prod` with a minimal README solely to establish the first Git ref. `dev` and `test` were then created from that same bootstrap commit. All implementation changes in this bootstrap are going through `feat/bootstrap-single-worker -> dev`; subsequent promotion follows `dev -> test -> prod`.

CI validates:

- generated Cloudflare runtime/binding types;
- TypeScript;
- inherited STT and Workflow recovery tests;
- single-Worker Wrangler dry-run;
- absence of the obsolete LLM Service Binding topology;
- D1 migrations.

## Migration status

Repository bootstrap is tracked in [Issue #1](https://github.com/uichat-mira/cloud-shiyan/issues/1).

A green repository CI proves only that the clean single-Worker source is internally valid. It does **not** prove Cloudflare cutover. Production completion requires real bindings/secrets, deployment verification, health check, Mobile-to-Shiyan end-to-end smoke, Destination delivery, and a confirmed rollback path before old deployments are retired.
