# Staging-only, read-only MCP acceptance probe

**Purpose:** Operator-run verification of the isolated staging MCP deployment after a protected, reviewed manual staging deploy. This is **not** a deployment action and **does not** itself prove any staging environment is available.

**What it tests:** Exact deployed source SHA, connected OAuth user and Workspace scope, selected dummy List, registered read-only reporting tools, bounded Goals data and bounded Sprint/List snapshot metadata. Optionally, one Goal with its key results.

**What it never does:** POST a Chat message, write a task, change OAuth scopes, deploy Workers, inspect the company Worker, print Goal names or task details, send diagnostic responses to GitHub or collect secrets in a repository file. It does not close [#120](https://github.com/cryogenized-spec/ClickUp-Serviteur-MCP/issues/120), which still requires a separately approved, disposable self-DM send and readback.

## Preconditions

1. The operator confirms the **staging** Cloudflare Worker is deployed from reviewed `main`, with its **separate staging OAuth KV and Durable Objects**. The historical staging address was `https://clickup-serviteur-staging.cryogenized.workers.dev/mcp`; reconfirm this in Cloudflare before use. The verifier only permits an HTTPS `clickup-serviteur-staging.<account>.workers.dev/mcp` URL; it rejects company Worker hosts, arbitrary domains, alternate paths and URL query strings.
2. Authorize an **individual test-account** ClickUp OAuth identity in the disposable staging Workspace. Verify the selected staging List ID, Workspace ID and `workspace_scope_enabled:true` in the staging client itself. Never substitute the company connection.
3. Run from an owner-controlled computer with Node >=22.20.0 and `npm ci --ignore-scripts --no-audit --no-fund` already completed. Obtain a **short-lived staging MCP OAuth bearer token** through an approved staging client/authorization flow. Do not reuse the company's token, paste it into ChatGPT, write it to shell history, or store it in GitHub variables.

## Run locally in Bash (not GitHub Actions)

Use real staging-only IDs and the exact reviewed source SHA. Set these in your own shell; no production identifiers belong in this document.

```bash
export STAGING_MCP_URL="https://clickup-serviteur-staging.cryogenized.workers.dev/mcp"
export STAGING_EXPECTED_BUILD_SHA="<exact 40-character deployed source SHA>"
export STAGING_EXPECTED_WORKSPACE_ID="<dummy staging Workspace numeric ID>"
export STAGING_EXPECTED_LIST_ID="<dummy staging List numeric ID>"

# Optional: verify a known dummy Goal in that same staging Workspace.
# export STAGING_GOAL_ID="<known staging Goal ID>"

# Read silently: token is not part of the typed command or shell history.
read -r -s -p "Staging MCP token: " STAGING_ACCESS_TOKEN
echo
export STAGING_ACCESS_TOKEN

node scripts/staging-readonly-acceptance.mjs
result=$?
unset STAGING_ACCESS_TOKEN
exit "$result"
```

This CLI sends an authorization bearer token only to the exact permitted staging `/mcp` URL, refuses redirects, and emits only fixed stage names (e.g. `PASS staging build` or `FAIL staging goals`). It does not output private response contents. A refused/unknown response, disabled goal feature, mismatched SHA, wrong Workspace, or disabled Workspace scope causes a **nonzero** exit.

If token export is unavailable or inconvenient, use an already authorized staging MCP client to call the same four read-only tools individually. Compare `service_info.build_sha`, `get_clickup_connection_status`, `clickup_get_workspace_goals`, and `clickup_get_sprint_task_snapshot`, with the same staging-only identifiers and no data copied to public issues.

## Evidence and completion

- Record only the **staging reviewed/deployed SHA**, date and the names of stages that passed/failed in the private operator's notes. The code must never log private IDs, user accounts, task records or OAuth secrets.
- The result is proof only for **the current deployed staging build and specific OAuth account**, not all ClickUp plans, all Goals, Sprint Dashboard metrics, or all tools.
- Leave company production unmodified. The separate company deployment remains blocked on the existing private-Chat staging acceptance gate and owner review.
- Native self-DM creation and Chat delivery verification remain in [CHAT_STAGING_ACCEPTANCE_2026-11.md](CHAT_STAGING_ACCEPTANCE_2026-11.md).
