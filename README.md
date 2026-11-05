# ClickUp Serviteur MCP

> **5 November 2026 source candidate:** A custom 49th tool, `clickup_edit_task_comment`, adds owner-only correction of task comments with task/List and author verification plus readback. The historical 48-tool catalogue counts below describe the earlier release; editing is unavailable in the connected MCP until this change passes CI, is merged, is deployed to the company Worker and the ChatGPT app tools are refreshed.

> **Current checkpoint — 3 November 2026 SAST:** The **custom** MCP is connected to the owner-approved **dummy** ClickUp Workspace; OAuth read/write grants and Workspace scope are enabled for that dummy identity. Multiple read routes and authorization denials have been validated live, but **not 48/48 verified**. GitHub `main` is CI-green; **the latest per-user List-target selector merged in PR #67 has not yet been manually deployed to staging**, so the connected ChatGPT tool list still lacks it. Never send company tasks through this staging profile. See the [3 November live audit](docs/MCP_LIVE_AUDIT_2026-11-03.md) and [release readiness roadmap](docs/RELEASE_READINESS_ROADMAP_2026-11-02.md).

A private, cloud-hosted [Model Context Protocol](https://modelcontextprotocol.io/) server connecting authorized staff members to ClickUp through **their own individual ClickUp OAuth accounts**. The same remote MCP endpoint is intended for supported Claude and ChatGPT clients.

> **Integration checkpoint — 12 October 2026 (SAST):** OAuth, 48 ClickUp REST-backed catalogue tool adapters, Codex security remediations, and cloud-only GitHub Actions deployment workflow are **merged into `main`**. Strict CI at commit `46c834c714c08aa1b13e2f026351292c0fcc9315` passed all checks. The owner previously connected the custom MCP from Claude to a Cloudflare-hosted staging endpoint; this is not evidence that the new 48 operations have been deployed or tested with real ClickUp credentials. **Staging deployment/CLI configuration and then hands-on Claude/ChatGPT + ClickUp acceptance remain.** No local always-on service, duplicate journal, rollback system or second tool-approval UI.

## Responsibilities — no duplicate systems

| Platform | Sole responsibility |
|---|---|
| **ClickUp** | Task data, staff permissions, activity/history, native attribution, existing comments, updates and any recovery it natively supports |
| **Claude / ChatGPT** | Per-tool allow/deny prompts, low-risk approvals and user-specific tool trust preferences |
| **ClickUp Serviteur MCP** | OAuth verification and account mapping, forwarding bounded ClickUp API calls under each user's own token, input validation, fixed-resource scoping and upstream ClickUp rate-limit response handling (no artificial per-user/shared request ceiling) |
| **Cloudflare Workers** | Permanent HTTPS remote MCP hosting and encrypted per-user credential storage |
| **GitHub Actions** | Hosted CI and manual deployment to an isolated Cloudflare Worker; never hosts the persistent application |

**There is no Serviteur activity journal, duplicate audit dashboard, rollback engine or additional per-tool approval settings.** The previously proposed journal/rollback design was rejected by the owner and removed from the current feature branch.

## Implemented server tools

| Name | Effect | Purpose |
|---|---|---|
| `service_info` | Read | Show runtime configuration flags, not proof of connectivity |
| `connect_clickup_account` | Account operation | Return individual ClickUp authorization URL; no tokens to AI clients |
| `get_clickup_connection_status` | Read | Show only your own connection |
| `disconnect_clickup_account` | Account operation | Remove your local encrypted connection (revoke upstream in ClickUp separately) |
| `clickup_set_workspace_access` | Write-authorized account operation | Explicitly enable or revoke Workspace-wide tools for your own authorized ClickUp account |
| `find_scoped_tasks` | Read | Get bounded tasks in configured home List |
| `get_scoped_task` | Read | Read known task ID after verifying its home List |
| `get_attention_report` | Read | Bounded overdue/upcoming/stale-task metadata; clearly flags incompleteness |
| `get_scoped_list` | Read | View authorized List name and valid status labels |
| `create_scoped_task` | Write | Create a task in the configured List under your own account |
| `clickup_tool_catalog` | Read | Inspect proposed schemas for further ClickUp capabilities; **not** an operational API |

**Security checkpoint (25 October 2026):** All **48** catalogue operations remain registered. The default `CLICKUP_RESOURCE_SCOPE=list` blocks task-ID mutation endpoints that lack an atomic home-List precondition. The new `clickup_set_workspace_access` account tool does **not** bypass these protections: it lets the **currently authenticated person** explicitly opt in to Workspace authority only if (1) the owner separately allowlisted their numeric GitHub user ID, (2) their own ClickUp OAuth token was verified as authorized for exactly the configured Workspace, and (3) their MCP grant includes `mcp:write`. The change affects no other staff. In the ordinary List-default configuration, revocation takes immediate effect and reconnecting resets it; a forced staging Workspace configuration instead requires a config rollback to return to List mode.

**Staging activation after review, merge and manual deployment:**
1. Staging defaults `CLICKUP_WORKSPACE_GITHUB_IDS` to public repository-owner GitHub ID `256972168`. This is a non-secret staging allowlist for the owner only; the GitHub Actions environment variable `STAGING_WORKSPACE_GITHUB_IDS` may override it. Wrangler's `keep_vars` preserves existing dashboard-defined configuration.
2. Call `get_clickup_connection_status`. `workspace_scope_approved` and `workspace_exclusive` must both be `true`. If exclusivity is false, reconnect to ClickUp and authorize **only** the approved Workspace.
3. For the owner's dummy Workspace `9012707978`, staging now sets `CLICKUP_RESOURCE_SCOPE=workspace` for the owner-allowlisted GitHub identity only. No separate opt-in tool call is needed. Verify `get_clickup_connection_status` reports `workspace_scope_enabled: true` and `get_scoped_list` reports `resource_scope: "workspace"` after deployment.
4. Exercise updates, comments and dependencies **on disposable records only**. To revoke this staging default, restore `CLICKUP_RESOURCE_SCOPE=list` and redeploy (or remove the owner from the Workspace allowlist); the per-user `enabled: false` tool rejects forced scope rather than falsely reporting revocation. Separate AI-client confirmation remains necessary for risky writes and deletion. No existing tasks are automatically modified by changing access.


Tools execute through the official `@modelcontextprotocol/server` v2 SDK and ClickUp REST API v2. Read operations require `mcp:read`; writes additionally require the explicitly consented `mcp:write` MCP OAuth scope. **This OAuth scope is not a duplicate client approval interface.** Users still control the AI client's own permission prompts.

The separate **48-capability model-facing schema catalogue** is descriptive, but all 48 names also have REST-backed runtime adapters. Synthetic integration tests exercise the runtime; actual ClickUp API compatibility, permission semantics and client connections are still unverified. Do not present this as validated first-party ClickUp MCP parity.

## Deployment — cloud only

1. Review and merge the stacked draft PRs in dependency order, preserving all OAuth and strict CI changes: [#17](https://github.com/cryogenized-spec/ClickUp-Serviteur-MCP/pull/17) → [#18](https://github.com/cryogenized-spec/ClickUp-Serviteur-MCP/pull/18) → [#20](https://github.com/cryogenized-spec/ClickUp-Serviteur-MCP/pull/20) → [#21](https://github.com/cryogenized-spec/ClickUp-Serviteur-MCP/pull/21) → [#22](https://github.com/cryogenized-spec/ClickUp-Serviteur-MCP/pull/22) → [#23](https://github.com/cryogenized-spec/ClickUp-Serviteur-MCP/pull/23). Their earlier Phase 3 bases must also be reconciled into `main` first. Alternative schema PR #19 is **not** part of this stack. Never merge merely because a unit test passed.
2. Follow [Phase 5 individual OAuth and cloud-only setup](docs/PHASE5_USER_OAUTH_AND_CLOUD_CI.md): configure independent GitHub OAuth and ClickUp OAuth apps, the exact HTTPS callback origin, a dedicated staging KV, the required SQLite Durable Objects and per-user account mapping. Secrets belong in GitHub's protected staging environment and Cloudflare Worker Secrets, **not** in the repository, laptop or chat.
3. Run [Deploy ClickUp Serviteur MCP staging](.github/workflows/deploy-staging.yml) manually on reviewed `main` via GitHub Actions. This runs tests and uses a pinned Wrangler to deploy an isolated Cloudflare staging Worker. It does **not** require a local laptop service.
4. Only enable `CLICKUP_OAUTH_ENABLED` and `CLICKUP_LIVE_ENABLED` after owner-approved staging setup, appropriate ClickUp List and individual user grants. Each employee completes their own ClickUp consent. Confirm real user attribution in ClickUp's native Activity and verify read/write restrictions on a disposable test List before operational rollout.

## Adversarial testing

Synthetic tests cover independently verified staff identity, forged bearer/header rejection, one-use OAuth state, wrong Workspace/account rejection before saving credentials, encrypted vault isolation, cross-List task substitution, foreign-Workspace List denial, unavailable task-ID mutation surfaces, write-scope OAuth step-up, 429 cooldown handling, invalid arguments, redirects, quota-denied operations, uncertain writes with **no automatic retry**, and a complete MCP SDK `tools/list` → `tools/call` write flow. The CI workflow requires format, lint, strict TypeScript, Vitest, Worker dry-run, real local workerd HTTPS security smoke, policy regression checks and dependency audit.

Run via GitHub Actions; no local development environment is required. Source [release evidence and limitations](docs/PROJECT_STATE.md), [tool schema](docs/CLICKUP_TOOL_SCHEMA.md) and [MCP conformance acceptance](docs/MCP_COMPLIANCE.md).

**Still unverified:** real ClickUp REST responses and native attribution, live Cloudflare deployment, end-to-end OAuth and token revocation, external Claude/ChatGPT subscription UI integration, official MCP conformance runner, and full first-party ClickUp MCP parity. Test fixtures cannot establish any of these. Never represent the service as operational without completing the relevant real acceptance steps.
