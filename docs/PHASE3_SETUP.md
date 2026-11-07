# Phase 3 OAuth deployment and acceptance checklist

**Configuration runbook and staging acceptance tracker.** The original 10 October runbook preceded live deployment. Staging subsequently went live on 11 October 2026 (SAST). Keep the distinction between **observed manual evidence** below and automated tests: the current document is not a production approval.

## Hosted Phase 3 staging acceptance — 11 October 2026 SAST

The operator confirmed a Cloudflare-hosted staging Worker at `https://clickup-serviteur-staging.cryogenized.workers.dev`, dedicated `OAUTH_KV`, configured GitHub OAuth application, successful allowlisted GitHub login through Claude, discovery of one diagnostic tool, and **an actual Claude invocation** returning the updated `service_info` JSON: `{"phase":3,"liveClickUp":false,"authentication":"github-oauth-required",...}`. The live deployment used repository commit `6d2677d` and Worker version `ec86fb4c-0017-4955-b9e8-52c944c8bbea`. These confirmations were provided from the operator's terminal and Claude session; this repo does not independently attest to external account state.

Previous hosted probes also confirmed unauthenticated `/mcp` returned HTTP 401 with an RFC 9728 bearer challenge and a fabricated bearer token / `X-User` header returned HTTP 401 with `invalid_token`. GitHub OAuth user-ID validation and completion were exercised by the genuine Claude sign-in.

**Still unverified live (do not mark Phase 3 fully accepted):** removal of an already authorized second tester from the real Cloudflare allowlist, pre-existing token denial, two-to-four distinct human accounts and concurrent requests, refresh/revocation/expiry against hosted Cloudflare, callback state/PKCE replay-denial on the hosted endpoint, and official MCP conformance. Do not paste authorization codes, state parameters, Client Secrets, bearer tokens or callback URLs containing live credentials into issues, logs or conversations.

Automated adversarial tests in this branch simulate token facts and allowlist changes; they do **not** substitute for the hosted revocation exercise. No Phase 4 ClickUp API access and no write tools have been enabled.

## Identity architecture

Every one of the 2–4 Serviteur staff members uses **their own ChatGPT or Claude subscription** to connect to one ClickUp Serviteur MCP server. The first POC identity provider is **GitHub OAuth App**: each staff member must also have their *own GitHub account* for sign-in. A ChatGPT or Claude login does not automatically establish identity with our server. The GitHub implementation is modular; a Google/Microsoft identity adapter can replace it later after review.

The Worker uses official `@cloudflare/workers-oauth-provider@1.2.3` for MCP OAuth 2.1, consent, client metadata, resource-bound tokens and revocation. Its public /mcp handler checks each verified `github:<numeric-id>` against the **current** server allowlist and `mcp:read` scope on every call. Removing a staff ID denies future calls even if an existing token has not expired. The backend does not share user sessions or GitHub API tokens.

## Local workerd security smoke — VERIFIED, not live acceptance

[GitHub Actions #38081428776](https://github.com/cryogenized-spec/ClickUp-Serviteur-MCP/actions/runs/38081428776) passed a **real locally executed workerd** HTTPS test with ephemeral certificates, isolated simulated KV and deliberately invalid GitHub OAuth credentials. Run it with `node scripts/staging-local-smoke.mjs` after `npm ci`; it is now required by strict CI after the Wrangler dry-run. The test verifies the missing-KV 503 gate, unauthenticated 401 and Bearer challenge, correct RFC 9728/RFC 8414 discovery, spoofed bearer/user/host headers, and a query-based bypass attempt.

This does **not** test a real GitHub account authorization, access-token redemption, Cloudflare-hosted KV binding, actual ChatGPT/Claude OAuth callback, four human accounts, or official MCP conformance. The following hosted environment actions remain required before live Phase 3 acceptance.

## Required Cloudflare actions — human operator only

1. Identify the Cloudflare account and a **separate test hostname** that serves the Worker over HTTPS. `wrangler.jsonc` presently specifies `workers_dev: false`; no public Worker will be published automatically. Use an approved custom domain or explicitly configure a Workers.dev test hostname. Record exact `https://<host>` as `MCP_PUBLIC_ORIGIN` (no path, trailing slash, query or fragment).
2. Create a **dedicated KV namespace** for OAuth data (`npx wrangler kv namespace create OAUTH_KV`) and add its actual returned namespace ID as `kv_namespaces: [{ "binding": "OAUTH_KV", "id": "<actual id>" }]` in the intended environment's Wrangler config. Do not guess an ID.
3. In GitHub's OAuth App settings create a **Serviteur POC app** with callback `https://<host>/github/callback`. Create separate applications for local and public test environments. Retain the Client ID and Client Secret in the Cloudflare secret manager, never GitHub source or a chat.
4. Collect the **immutable numeric GitHub user IDs**, not display names, of the 1–4 staff participants. The private Worker binding `ALLOWED_GITHUB_IDS` is a comma-separated list of **1–4 unique safe positive integers**.
5. Configure Cloudflare secrets using `npx wrangler secret put GITHUB_CLIENT_ID`, `npx wrangler secret put GITHUB_CLIENT_SECRET`, `npx wrangler secret put MCP_PUBLIC_ORIGIN`, `npx wrangler secret put ALLOWED_GITHUB_IDS` in the correct environment. Do not put credentials or user IDs into version-controlled config, test files or logs.
6. Retain the `global_fetch_strictly_public` compatibility flag; it protects outbound Client ID Metadata Document fetching. Review Cloudflare's actual DNS routes, secrets and KV binding before the **first manual deployment**.
7. Check that an unauthenticated HTTPS `/mcp` request gets the official **401 challenge** (not a live task response); resource metadata and authorization-server metadata must be discoverable. A misconfigured worker returns 503/404 and is **not deployed-ready**.
8. Verify actual ChatGPT and Claude subscription connection UIs, the browser sign-in, consent and the redirect into each subscribed client **separately**. Confirm each user gets a distinct subject and that another user's saved token cannot be reused to assume their identity.
9. Test after removing one test staff member from the allowlist (their bearer token must stop working). Test expired/revoked tokens, invalid PKCE, wrong audience/issuer, missing scopes, malicious/duplicate callback state, four concurrent logins and a stolen browser state replay.
10. Run the official MCP conformance tool, inspect the authenticated `tools/list` and `service_info`, collect redacted evidence and actual request budgets. Only after passing all security and interface gates may read-only ClickUp be enabled in Phase 4.

## Operational limits

- GitHub is an **upstream user identity service** here; it is not how the ClickUp API is accessed. No ClickUp data is used in Phase 3.
- GitHub login names can change, so allowlist **numeric user IDs**. Only the operator controls the allowlist, and the Worker must revalidate it per invocation.
- Company-level shared ClickUp credentials (if later used) imply a **single ClickUp REST budget** shared by staff. Coordinated rate-limiting belongs to Phase 4.
- Do not enable `mcp:write` or any task-modification tool in Phase 3. Later writes need independent human approval and audit.
- GitHub Free/private cannot enforce branch checks. PR merges and Cloudflare deploys remain manual, explicitly approved actions.
- Cloudflare OAuth Provider currently supports MCP 2026-07-28 and supports Client ID Metadata Documents; protocol implementation and account compatibility are still distinct acceptance criteria.

References: https://github.com/cloudflare/workers-oauth-provider ; https://github.com/cloudflare/workers-oauth-provider/blob/main/docs/upstream-sign-in.md ; https://github.com/cloudflare/workers-oauth-provider/blob/main/docs/consent-page.md
