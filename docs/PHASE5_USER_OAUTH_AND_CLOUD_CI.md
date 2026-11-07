# Phase 5 — individual ClickUp OAuth and GitHub Actions deployment

**Owner decision, 11 October 2026 (SAST):** Each staff member must connect their own ClickUp account. No shared ClickUp API token. There is no laptop-bound hosting or required operator-side Node installation. GitHub Actions performs CI and controlled deployments; **Cloudflare Workers serves the MCP endpoint**. This feature is unmerged, without real user credentials, and not deployed.

## Two independent OAuth boundaries

1. **MCP client -> Serviteur Worker:** Existing Phase 3 Cloudflare OAuth provider uses individually allowlisted GitHub accounts. That proves the person using the MCP connector; it does NOT grant ClickUp access.
2. **Serviteur Worker -> ClickUp:** Each verified staff identity calls `connect_clickup_account`, opens the returned ClickUp browser URL, authorizes their own account and the chosen Workspace, and returns to `https://<staging-host>/clickup/callback`. The authorization-code exchange occurs only on Cloudflare, never in the model or on the laptop. Signed five-minute state plus one-time Durable Object nonce prevent CSRF/replay. ClickUp `GET /user` determines the *actual* authorizing user and must match the owner-approved one-to-one `CLICKUP_STAFF_USER_MAP`; `GET /team` must contain the approved Workspace. A failed consent or stale/mismatched Workspace stores no credential.
3. Each credential is encrypted AES-256-GCM inside a **separate per-GitHub-subject Cloudflare SQLite Durable Object**, with secret-held encryption key and authenticated associated-data tied to the subject. Nothing is committed to GitHub. Per-user token is retrieved only after verified MCP subject, active GitHub allowlist, explicit per-List app READ grant, successful per-user connection and the explicit `CLICKUP_LIVE_ENABLED` activation gate. Token quota is keyed by verified ClickUp user ID rather than a single shared token.
4. `get_clickup_connection_status` shows the viewer only their own ClickUp ID and Workspace. `disconnect_clickup_account` removes the local credential; it does not revoke the authorization within ClickUp's Connected Apps settings.
5. Phase 6 now develops a small set of **native ClickUp REST operations** on a separate unmerged branch. Client-side tool approval remains in Claude/ChatGPT, while ClickUp is the sole task/activity history. No second journal, rollback database or custom approval UI is built. Live staging must still confirm that ClickUp attributes a controlled write to the consenting individual.

ClickUp docs: [individual OAuth](https://developer.clickup.com/docs/authentication), [token exchange](https://developer.clickup.com/reference/getaccesstoken), [current user](https://developer.clickup.com/reference/getauthorizeduser), [authorized workspaces](https://developer.clickup.com/reference/getauthorizedteams).

## Cloud-only deployment path

Repository `.github/workflows/deploy-staging.yml` is **manual** (`workflow_dispatch`), **main-branch-only**, and uses GitHub's `staging` environment. Every run repeats all repository checks and executes pinned Wrangler with an isolated generated staging manifest; a PR never has permission to deploy. Use GitHub's Environments settings to require designated reviewers and restrict deployment branches to `main` (GitHub subscription/plan capabilities permitting; manual owner discipline remains mandatory). Never enable automatic production deployment on a PR.

Owner action in the **web UIs**, not on a laptop:

- Cloudflare: create dedicated staging Workers account resources and OAuth KV namespace. Record its 32-character namespace ID in the GitHub **staging environment variable** `STAGING_OAUTH_KV_ID`.
- GitHub repository Settings -> Environments -> `staging`: set `CLOUDFLARE_ACCOUNT_ID` and restricted `CLOUDFLARE_API_TOKEN` as GitHub environment **secrets**. If environment-review controls are not available on the user's plan, an authorized owner must manually trigger approved `main` deployments.
- Create one ClickUp OAuth app with the **exact** staging callback URL. Create separate GitHub OAuth app credentials for Phase 3 as already documented.
- Cloudflare Worker staging **secrets**: `MCP_PUBLIC_ORIGIN`, `ALLOWED_GITHUB_IDS`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `CLICKUP_CLIENT_ID`, `CLICKUP_CLIENT_SECRET`, `CLICKUP_STATE_KEY` (random 32-byte key, standard base64), `CLICKUP_TOKEN_KEY` (independent random 32-byte key), `CLICKUP_WORKSPACE_ID`, `CLICKUP_STAFF_USER_MAP` (JSON mapping each allowlisted numeric GitHub ID to exactly one unique expected numeric ClickUp user ID; example `{"11":"707","22":"809"}` — these are fictional placeholders), `CLICKUP_LIST_ID`, `CLICKUP_READ_GITHUB_IDS`. Keep `CLICKUP_OAUTH_ENABLED` and `CLICKUP_LIVE_ENABLED` unset until the owner explicitly approves each activation. Never set `CLICKUP_API_TOKEN` or commit keys.
- After an owner-controlled merge, GitHub Actions -> Deploy ClickUp Serviteur MCP staging -> Run workflow against `main`. The job prepares the isolated manifest from environment configuration, executes quality checks, and deploys to a **separate** `clickup-serviteur-staging` Worker. The Cloudflare credentials are passed through job environment secrets, never printed by our script.
- Cloudflare Durable Object migration `phase5-user-oauth` provisions `ClickUpUserConnection`; staging must have the existing `ClickUpQuota` migration and binding.
- Test unauthenticated 401, individual staff consent, signed-state expiration, replay rejection, wrong Workspace rejection, cross-user credential isolation, token revocation/disconnection and per-person read quota on **real staging**. Synthetic CI cannot claim live acceptance or guarantee native ClickUp activity attribution.

## Limits and security caveats

ClickUp currently documents its OAuth access token as non-expiring but explicitly says this may change. The project does not implement refresh tokens; reconsent on 401 or revoked access is required. ClickUp authorization codes and access tokens are never transmitted to ChatGPT or Claude; model tool output contains a browser authorization URL only. Tokens are never logged or returned to an external MCP tool. A Cloudflare compromised secret store or privileged deployment account remains a high-risk boundary; restrict access and rotate keys safely. Rotating `CLICKUP_TOKEN_KEY` without a migration invalidates stored encrypted accounts and requires reconnection.

Cloudflare reference: [GitHub Actions deployment](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/).

**Release gate:** no keys requested in chat, no deployment, no production writes, no merge until exact HEAD CI, independent security review and real identity tests pass.
