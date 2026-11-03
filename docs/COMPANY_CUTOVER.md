# Company ClickUp MCP — isolated read-only cutover

**Status: prepared for review; NOT deployed or authorized.** The company Workspace and List were independently verified using the user's connected work ClickUp account on 3 November 2026. No company records were modified.

| Parameter | Verified configuration |
|---|---|
| Company Workspace | `9005168750` |
| Default List | `901202442802` — Team NeonSales List |
| Company ClickUp user | `74510260` |
| Intended GitHub owner subject | `256972168` (separately verify during OAuth) |
| Existing dummy Workspace | `9012707978` — remains separate |
| Existing staging Worker | `neonsales-clickup-mcp-staging` — do not replace |
| New company Worker | `neonsales-clickup-mcp-company` |
| Initial scope | LIST-only, all task mutations denied in code |

The work account's task search and List GET show the default company List under **Shared with me** (Space `90120550022`); the standard Workspace Space hierarchy returned no normal Spaces. The patch adds a fail-closed fallback to ClickUp's official `GET /team/{workspace}/shared`, accepting the exact List ID only when that *Workspace-specific* hierarchy contains the List. A task share, unverified parent, or foreign Workspace remains rejected. Real ClickUp OAuth acceptance and actual company shared-hierarchy payload have **NOT** been tested with the custom MCP.

## Owner setup in protected services — no secrets in chat

1. In Cloudflare create a **new** `OAUTH_KV` namespace and a dedicated company Worker; never reuse staging KV, Durable Object storage or stored user tokens. The deployment workflow creates the distinct company Worker by name, and provisions its own Durable Object bindings there.
2. In the repository's GitHub **Settings → Environments**, create `company`, restrict deployments to reviewed `main` and use manual approval if available. Add environment variables `COMPANY_OAUTH_KV_ID`, `COMPANY_WORKSPACE_ID=9005168750`, `COMPANY_LIST_ID=901202442802`, `COMPANY_OWNER_GITHUB_ID=256972168`, `COMPANY_CLICKUP_USER_ID=74510260`. Add `STAGING_OAUTH_KV_ID` and `STAGING_WORKSPACE_ID=9012707978` for the generator's anti-reuse checks; values should reflect the real, distinct resources, not copied examples. Add environment secrets `COMPANY_CLOUDFLARE_ACCOUNT_ID` and a restricted `COMPANY_CLOUDFLARE_API_TOKEN` limited to this deployment.
3. Create **separate** GitHub and ClickUp OAuth apps/credentials for the company hostname; their callback URLs must match that Worker exactly. Store secrets through Cloudflare's company Worker Secret controls, not GitHub commits or chat: `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `CLICKUP_CLIENT_ID`, `CLICKUP_CLIENT_SECRET`, `CLICKUP_STATE_KEY` and independently generated `CLICKUP_TOKEN_KEY`. Set `MCP_PUBLIC_ORIGIN` to the new company Worker HTTPS origin. Do not reuse staging secrets or authorize any other staff yet.
4. Run GitHub Actions **Deploy isolated ClickUp MCP company (manual, read-only)** on reviewed `main` only. The job must pass pinned policy, Python tests, format, lint, strict TypeScript checks, Vitest, build, local OAuth smoke and dependency audit before deployment. The generated manifest stays out of Git and is removed from runner storage.
5. When the company Worker secrets and callbacks are in place, enable `CLICKUP_OAUTH_ENABLED=true` and `CLICKUP_LIVE_ENABLED=true` in that Worker (never staging). Connect only the approved work ClickUp identity through `connect_clickup_account`; verify its authorized Workspace. If ClickUp OAuth authorizes multiple Workspaces, keep LIST-only policy and verify the correct owner/list. **No live company writes** until a separate operational acceptance and explicit authorization.
6. Add the company Worker as a **separate** ChatGPT custom MCP plugin, leaving **ClickUp MCP serviteur** connected to dummy staging. Test `service_info`, `get_clickup_connection_status`, `get_scoped_list`, and a bounded read. Verify that `create_scoped_task`, catalogue mutations and `clickup_set_workspace_access` fail with `CLICKUP_COMPANY_WRITE_DISABLED` despite `mcp:write`.
7. Only after the company read-only checks pass, decide which staff accounts and which write operations to permit. This requires explicit management/owner authorization; the current read-only code must not be silently switched off.

**Important:** The current `clickup_preview_target` / `clickup_select_target` tools change LIST defaults only within the Worker-bound Workspace. They cannot switch the staging OAuth credential to a company account, and typing `9005168750` into the dummy selector should be rejected.

**Status evidence:** This cutover is a reviewed-source candidate, not a deployed company endpoint. See [issue #68](https://github.com/cryogenized-spec/NeonSales-ClickUp-MCP-/issues/68) for acceptance gates. No company OAuth secrets or direct production calls were submitted to this custom MCP.
