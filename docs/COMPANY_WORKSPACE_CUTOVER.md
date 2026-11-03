# Company ClickUp MCP cutover — isolated, owner-controlled

**3 November 2026 SAST.** The owner approved the company Workspace and confirmed its exact ID. The separate first-party *work* ClickUp account was verified against the company Workspace and could read the shared Team NeonSales List. That is not an authorization for writes or evidence the custom company MCP is deployed.

## Deployment boundaries

The existing staging/serviteur Worker, personal dummy Workspace, OAuth account, encrypted Durable Objects and KV remain unchanged. Provision a **second** company Cloudflare Worker named `neonsales-clickup-mcp-company`, with a dedicated OAuth KV namespace and independently scoped GitHub/ClickUp OAuth clients, company-only Cloudflare secrets and per-user encrypted Durable Objects.

The new company profile is **read-only** by default: resource scope is `list`, and `CLICKUP_COMPANY_READ_ONLY=true` denies all MCP write routes server-side, even when a client grants `mcp:write`. It does not allow Workspace-wide authority or arbitrary List IDs. The company employee's OAuth account need not be exclusive to one ClickUp Workspace for this List-only mode.

The work List appears under **Shared with me**. A verified List may therefore be absent from the ordinary `/team/{workspace}/space` endpoint; the fallback calls ClickUp's officially documented **Shared Hierarchy** endpoint `/team/{workspace}/shared`, accepting ONLY an exact List ID in that Workspace's `shared.lists`. A successful GET of the List alone does not grant access.

## GitHub and Cloudflare setup (owner actions)

1. Create a protected GitHub **company** Environment, restricting deployment to the reviewed main branch. Add **variables**: `COMPANY_WORKSPACE_ID`, `COMPANY_LIST_ID`, `COMPANY_GITHUB_OWNER_ID`, `COMPANY_CLICKUP_USER_ID`, `COMPANY_OAUTH_KV_ID`, `COMPANY_PUBLIC_ORIGIN`, and (if available) `STAGING_OAUTH_KV_ID` for independent-KV validation. The Workspace/List/user IDs must be those independently verified in the work ClickUp connection; do not use the dummy IDs.
2. Create a fresh Cloudflare OAuth KV namespace only for the company Worker. Create separate OAuth applications/credentials with callbacks bound to the **company-specific exact HTTPS origin**; never reuse dummy OAuth client secrets, token encryption keys or KV. In the GitHub company Environment, set **secrets** `COMPANY_CLOUDFLARE_API_TOKEN` (least-privilege) and `COMPANY_CLOUDFLARE_ACCOUNT_ID`. Do not put any keys in source, PRs or ChatGPT.
3. Configure the company Worker's **secrets** through Cloudflare: `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `CLICKUP_CLIENT_ID`, `CLICKUP_CLIENT_SECRET`, `CLICKUP_STATE_KEY`, `CLICKUP_TOKEN_KEY`. Use independent company OAuth applications and account-bound identity mapping. The manifest generator supplies only non-secret configuration variables and reserves separate Worker/KV/DO bindings.
4. After exact-head CI, CodeQL and Codex review, **manually** run GitHub Actions **Deploy ClickUp MCP company (manual, read-only)** from reviewed main. It runs strict security/TypeScript/Vitest checks again before deploying. This is a company-only deployment; it does NOT overwrite staging.
5. Add the company MCP as a **separate ChatGPT Plugin** at its own HTTPS origin. First complete individual GitHub MCP OAuth; then call `connect_clickup_account` on the **company plugin**, open its one-time authorization URL and authorize the **work ClickUp user**, never the personal dummy user.
6. Read-only smoke: check connection status, exact Workspace and work ClickUp user ID, default List, and a bounded task read. Confirm the Shared Hierarchy fallback in the actual company environment; synthetic tests alone do not establish actual ClickUp response compatibility.

**No production write is authorized.** A future decision to unlock writes requires separate company management permission, a dedicated disposable company QA fixture and another exact-HEAD security review. Do not remove `CLICKUP_COMPANY_READ_ONLY` merely to enable a write test.

## Rollback and limitations

Disable or disconnect the **company** plugin or Worker to revoke its access; staging remains intact. The company operator must configure OAuth callbacks and Cloudflare credentials; GitHub code review/merge alone cannot complete that authorization. The company account may have limited access to shared Lists: never infer Workspace-wide permission from one valid List.
