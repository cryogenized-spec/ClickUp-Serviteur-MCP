# Phase 7 — Cloudflare staging and real ClickUp acceptance

**Status (12 October 2026, SAST):** [PR #24](https://github.com/cryogenized-spec/ClickUp-Serviteur-MCP/pull/24) and its security fixes have been merged, followed by GitHub Actions updates #9/#10. **Final main CI succeeded**, with 155/155 synthetic Vitest tests and local workerd security checks. Real ClickUp API response shapes, permissions, rate limits, activity attribution and the newly built tools' live behavior **remain unverified**; the owner previously confirmed that Claude recognized the earlier Cloudflare-hosted custom MCP. Merged code is not equivalent to a deployed or acceptance-tested Worker. No journal, duplicate permissions UI or rollback subsystem was added.

> **15 October 2026, PR #25 pending:** The owner directed that **all 48 catalogue adapters remain registered**. Do not disable 22 operations as a response to the task-move time-of-check/time-of-use race. The new List-scoped task search and bulk-input prevalidation changes remain proposed; the task-ID read/write race has no documented atomic remedy in this code. **PR #25 must not be merged or staged as security-cleared on CI evidence alone.** Evaluate the residual risk and obtain explicit release authorisation separately; do not mistake 48 registered tools for verified live behaviour.

## Existing decisions

- The backend delegates every ClickUp operation through the **authenticated human user's own ClickUp OAuth token**, never a shared ClickUp personal API key.
- Claude and ChatGPT own their per-tool permission choices and any user-requested draft/preview workflow; the MCP does not interrupt with additional approval gates.
- ClickUp remains the authoritative task, history, audit and permissions system. No custom journal, rollback engine or watchdog.
- GitHub Actions is the hosted CI/CD runner, Cloudflare Workers hosts the persistent remote MCP server; no staff laptop must stay online.
- The service still verifies its GitHub OAuth principal and bound ClickUp Workspace. A best-effort resource-to-Workspace verification is used where ClickUp provides readable hierarchy metadata, not a claim of atomic cross-Workspace isolation. Native ClickUp API permissions are ultimately authoritative.

## Functional surface

All **48** named catalogue tools are registered to native REST adapters: Workspace/task searches, task CRUD, Custom Fields, bounded bulk actions, comments, tags, task links/dependencies, cross-List management, time tracking, hierarchy, members, Chat, Docs, reporting, and a **small** base64-to-multipart task attachment upload.

The attachment adapter accepts explicit filename, base64 content and optional MIME type, capped at 500 KiB decoded per MCP call. It is **not** a general file transport from Claude or ChatGPT attachments. Model clients may need an appropriate means of supplying the bytes. Files are never fetched from arbitrary URLs.

Composite bulk operations can partially succeed. The backend does **not** retry ambiguous POST/PUT operations after dropped connections or server 5xx. It returns an explicit outcome-unknown error and leaves the user to check ClickUp before deciding whether to retry.

## Deployment/CLI checkpoint, followed by separate live client acceptance

1. **Completed:** PR #24, the preceding OAuth/security stack and GitHub Actions updates #9/#10 are merged onto `main`. The final merged-main CI run passed; do not repeat historical merge work.
2. In Cloudflare, inspect the existing **staging** Worker, its KV and Durable Object bindings, and the deployment secrets. Do not overwrite a working production Worker. The MCP's Cloudflare Worker URL is the server endpoint; GitHub is source control and deployment, **not** the protocol runtime.
3. Use [Deploy ClickUp Serviteur MCP staging](../.github/workflows/deploy-staging.yml) via GitHub Actions `workflow_dispatch` targeting reviewed `main`. Ensure the Cloudflare account and staging environment configuration is correct. No laptop-hosted Wrangler service is required.
4. Connect from Claude first, using its previously working custom connector entry. After reconnection, check `service_info`, then `tools/list`: confirm all 48 `clickup_*` capability tools are present **plus** the existing connection, diagnostic and scoped tools.
5. Connect each authorized employee to ClickUp via `connect_clickup_account`. Confirm the returned browser authorization URL, complete ClickUp consent with the intended account, then check `get_clickup_connection_status` for that **same** identity and Workspace.
6. Verify at least one read tool from each category against records the signed-in employee can already access, with correct Workspace/List IDs. Verify a second employee receives the records and edit permissions appropriate to their own ClickUp account; do not test using a shared token.
7. On a specifically designated disposable test List/task, exercise the write tools in controlled steps (create task; update task; add comment, tag, link; then optional time or Docs operations). Confirm each action appears **in ClickUp's native activity/history** under the consenting ClickUp account. Confirm client-side Claude/ChatGPT allow/deny preferences behave as desired. No extra MCP approval setting is expected.
8. Confirm behavior when an employee's token lacks permission (a native ClickUp 403), when a List is outside the approved Workspace, for a 429 limit, and when a task is moved concurrently between Lists; the last case is a best-effort upstream authorization boundary and cannot be represented as atomic unless ClickUp offers a documented conditional mutation.
9. Repeat basic connection, discovery, and read/write tests in ChatGPT using the same **Cloudflare HTTPS MCP URL**. Record any platform-specific OAuth step-up or tool-discovery differences.
10. Verify native history, actual result payloads, account attribution, and recorded errors; update [DEMO_ACCEPTANCE.md](DEMO_ACCEPTANCE.md) before calling the integration fully live.

## CI versus runtime proof

Current GitHub Actions checks validate formatting, lint, strict TypeScript, unit/adversarial tests, pinned Worker dry-run, local workerd HTTPS/OAuth smoke and dependency audit. Those checks do **not** certify the actual ClickUp workspace permissions or 48 endpoints against a live plan; Claude/ChatGPT tests, independent security review and deployment are separate acceptance gates.

## Known limits to check carefully

- ClickUp's endpoint availability and permissions vary by plan and enabled ClickApps.
- Task and List hierarchy can change between preflight validation and a subsequent API mutation; no optimistic atomic comparison is offered here.
- A 48-tool ClickUp-hosted-MCP catalogue is not the same as having identical upstream semantics; mapping may need corrections after the first real response.
- Binary attachments are capped at 500 KiB per call and require the calling client to supply base64 bytes.
- Never retry an uncertain write automatically. Inspect ClickUp first to avoid duplicate tasks or comments.
