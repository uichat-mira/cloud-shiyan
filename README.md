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

The former private `mira-shiyan-llm` deployment boundary is not carried forward. `src/llm/` remains a logical module boundary backed by the same `ShiyanLlmGateway`, prompt/schema validation, provider abstraction, and normalized outcomes from the effective legacy `dev` implementation. It can be split again later if a real security, scaling, release, fault-isolation, or reuse requirement justifies another deployment unit.

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

### Shiyan business LLM configuration

Shiyan business inference is project-owned. The Organization-wide AI service does **not** execute Shiyan's product-specific AI workload.

The preferred runtime configuration is one Cloudflare Secret on `mira-shiyan-api`:

```text
SHIYAN_LLM_CONFIG
```

Value:

```json
{
  "provider": "openai-compatible",
  "baseUrl": "https://provider.example.com/v1",
  "model": "model-name",
  "apiKey": "secret-key"
}
```

`baseUrl`, `model`, and `apiKey` are required. `provider` is only an observability label and defaults to `openai-compatible` when omitted.

When `SHIYAN_LLM_CONFIG` is present it is the sole provider source: legacy `LLM_PRIMARY_*` and `LLM_FALLBACK_*` variables are ignored. This prevents ambiguous mixed configuration. If the JSON secret is absent, the old variables remain temporarily supported for migration compatibility only.

Timeout and transcript-size policy remain code/deployment configuration rather than operator-entered provider credentials:

```text
LLM_TIMEOUT_MS=120000
LLM_MAX_TRANSCRIPT_CHARS=200000
```

Malformed or incomplete `SHIYAN_LLM_CONFIG` fails closed with a configuration diagnostic that never echoes the secret value.

The existing Shiyan device credential remains a compatibility mechanism during bootstrap. It must not be promoted into the organization-wide authentication design. Cloud Shiyan is expected to converge on Mira Cloud shared identity while keeping service-specific authorization scoped to Shiyan.

### Mira Cloud shared identity (SHY-001 server slice)

Cloud Shiyan verifies Mira Cloud service credentials without creating a second Shiyan account system. The canonical contract is owned by `uichat-mira/.github/docs/engineering/mira-cloud-auth.md` and `uichat-mira/cloud-auth/docs/service-credentials-v0.md`.

Accepted credential:

- `iss` is `mira:cloud-auth`.
- `aud` is `mira:cloud-shiyan`; Relay transport credentials are rejected.
- `scope` is exactly `["shiyan:authenticate"]`.
- `sub` is the Mira Cloud Account and `device_id` is the Mira Device.
- The header is `EdDSA`/`JWT` with a bounded `kid`; the payload must satisfy the strict canonical claim schema, including `iat <= nbf < exp` and a maximum 600-second lifetime.

Verification is offline and fail-closed:

- `CLOUD_AUTH_JWKS_URL` must be configured with the trusted Cloud Auth HTTPS JWKS address. It is deliberately not hardcoded in this repository.
- Only keys from that address are trusted. A token cannot supply its own issuer, key URL, or key.
- JWKS responses are validated strictly, cached for at most 300 seconds, and never followed through redirects. An expired cache is refreshed, and the request is rejected if the trusted JWKS cannot then be fetched. Unknown `kid`, unavailable JWKS, malformed keys, or missing configuration also reject the request; there is no fallback to the legacy credential after a Cloud verification failure.
- Key rotation follows Cloud Auth's V0 pre-publication procedure: publish the new public key before activating it, allow at least the 300-second consumer cache window plus the maximum credential lifetime before retiring the old key, and fail closed on an unknown `kid`.
- A `Bearer` credential with exactly three dot-delimited segments is always evaluated as a Mira Cloud candidate, **even when its base64url is malformed**. Such malformed candidates fail closed rather than falling back to legacy lookup. Opaque legacy device credentials must not have exactly two dots.

Current server boundary:

- Valid Cloud verification produces an explicit `CloudShiyanPrincipal { cloudAccountId, cloudDeviceId }`. The Cloud Device id is not the existing D1 `devices.id`.
- Only `POST /v1/capture-tasks` and `GET /v1/capture-tasks/:id` are open to a verified Cloud Account. Ownership is derived solely from the signed `sub`, so the account can create and read its own new tasks. A Cloud task persists `cloud_account_id` and `cloud_device_id` while D1 `device_id` stays `NULL`; the response `deviceId` is the display Cloud Device.
- Account idempotency is scoped by `cloud_account_id + create_idempotency_key`, so distinct Cloud Devices of one account converge on the same task and separate accounts remain independent.
- All other Cloud-authenticated Shiyan business operations still receive `403 cloud_identity_unmapped`, and foreign, unknown, or legacy task ids receive the same non-disclosing `404 task_not_found`. Cloud identity never inherits legacy device ownership.
- The legacy opaque device credential remains on its existing isolated path and keeps existing business behavior and resource ownership.
- Stable authentication errors are `401 device_unauthorized` (legacy path), `401 cloud_credential_unauthorized` (Cloud identity rejected), `403 cloud_identity_unmapped` (identity valid, this Shiyan operation is not mapped yet), and `503 cloud_auth_unavailable` (trusted JWKS configuration/fetch failure). These are distinct from Shiyan business errors.

Legacy removal condition: do not remove the legacy device credential until all of the following are true: the Cloud-to-Shiyan ownership mapping is implemented and reviewed, MOB-079 Mobile consumption passes T4 end-to-end, production T5 verification is accepted, and the existing migration/rollback window has closed. Until then, the legacy path is compatibility only and must not be treated as Mira Cloud identity.

No Cloud Auth private key, token, or production key material is stored in this repository.

## Engineering flow

Organization standard:

```text
feat/* -> dev -> test -> prod
```

The empty repository was initialized on `prod` solely to establish the first Git ref. `dev` and `test` were created from that same bootstrap commit. Corrected implementation work merges first to `dev`; promotion then follows `dev -> test -> prod` with environment evidence at each step.

CI validates static/deployability checks plus the Organization test layers used by this repository: T1 Unit, T2 Contract, and T3 Worker Runtime integration, aggregated by `Mira Gate`.

External Worker Draft PRs may need a trusted maintainer to approve GitHub's workflow execution or trigger a new PR CI run. An `action_required` workflow with no jobs is **not** a passed CI gate; the Worker's own verification output and SonarCloud Quality Gate are supplementary, not substitutes for the independent T1/T2/T3 and `Mira Gate` checks. Keep the PR in Draft until those checks execute and their evidence is reviewed.

## Cutover strategy

Production traffic is not the first live test. The migration uses Cloudflare Worker versions in two separate operations:

1. require the existing API/Destination secrets plus `SHIYAN_LLM_CONFIG` on `mira-shiyan-api`;
2. run typecheck, T1/T2/T3 tests, migration replay checks, and Wrangler dry-run;
3. upload a new `mira-shiyan-api` **version only** and obtain a preview URL;
4. run health and authenticated Shiyan smoke tests against the preview version;
5. only after preview acceptance, create a production deployment;
6. keep the legacy LLM Worker and old repository available as rollback anchors until the observation window passes.

`.github/workflows/cutover-preview.yml` is manual-only and hard-gated. It uploads a version with `wrangler versions upload`; it does not deploy production traffic.

## Migration status

Repository/source convergence is tracked in [Issue #1](https://github.com/uichat-mira/cloud-shiyan/issues/1). Real Cloudflare preflight/cutover is tracked in [Issue #3](https://github.com/uichat-mira/cloud-shiyan/issues/3).

Repository CI and the corrected `dev` branch are green. That proves the single-Worker source is internally valid, not that production has been cut over. Production completion still requires `SHIYAN_LLM_CONFIG` on the target Worker, preview acceptance, Mobile-to-Shiyan end-to-end smoke, Destination delivery, production deployment verification, and a confirmed rollback path before the legacy Worker is retired.
