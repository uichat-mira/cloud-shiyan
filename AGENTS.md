# Cloud Shiyan AI Engineering Instructions

Follow the current [Mira Organization AI Instructions](https://github.com/uichat-mira/.github/blob/main/AGENTS.md) and the authorized GitHub Issue contract. This document specifies Cloud Shiyan's repository-local constraints; it does not grant issue creation, merging, acceptance, deployment, or release authority.

## Ownership and boundaries

- Cloud Shiyan owns the single Cloudflare Worker service for Mira 拾言, with API, CaptureTask, STT, LLM organization, Destination, D1, R2, and Workflow modules.
- The repository's effective engineering source branch is `dev`; normal flow is `feat/* → dev → test → prod`. `prod` is also the GitHub default branch so trusted issue-comment Worker dispatch is available there; an implementation Worker must deliver its Draft PR to `dev`.
- Preserve established CaptureTask lifecycle, stage transitions, retry/idempotency semantics, R2 retention, transcript/LLM/Destination behavior, and resource ownership unless the authorized Issue explicitly changes them. Do not use this service as an alternative Mira Cloud Account system.
- Mira Cloud Auth alone establishes shared Cloud Account / Cloud Device identity. Existing Shiyan D1 `devices.id` is a **different** legacy subject. Do not silently identify, merge, or authorize resources across these domains; a valid Cloud token alone is not permission to access existing Shiyan business records.
- Product-level Shiyan contracts are owned by `uichat-mira/mira-mobile/docs/shiyan/`; reusable organization-level Cloud identity contract is owned by `uichat-mira/.github/docs/engineering/mira-cloud-auth.md` and implemented by `uichat-mira/cloud-auth`. Do not redefine either contract locally without explicit authorization.
- Never commit actual Cloudflare secrets, key material, raw bearer tokens, provider credentials, transcripts, or end-user content. Do not change live Cloudflare deployment, migration history, or production bindings as a side effect of an unrelated Issue.
- The service currently uses `src/api/index.ts`, `src/api/mob019.ts`, `src/api/mob020.ts`, `src/api/mob022.ts`, `src/llm/` and `src/shared/`; prefer small changes next to the existing implementation and maintain single-Worker topology.

## Verification

Use Node.js 22 or later, the existing npm dependency/tooling setup, and the repository's own verification scripts:

- `npm run typecheck` for Wrangler-derived types and TypeScript.
- `npm run test:unit` (T1).
- `npm run test:contract` (T2).
- `npm run test:integration` (T3, Cloudflare Workers runtime).
- `npm run dry-run` for Wrangler deployability without deployment.
- `npm run check` as the full local gate; PR CI runs the equivalent layers and `Mira Gate`.

Never weaken, skip, or rewrite unrelated tests to make a change pass. Report exact code/CI evidence, and leave authorized implementation in a Draft PR targeting `dev`. Do not merge or promote `test/prod` unless the maintainer separately authorizes it.

## SHY-001 explicit boundary

When working on SHY-001, read the current Issue #15 and trusted follow-up comments. In particular, signing/verification claims must match Cloud Auth's canonical issuer, Ed25519 signature, bounded audience/scope and time contract; do not promote a legacy Shiyan bearer or a Cloud-authenticated but unmapped principal to Shiyan business authority.
