# Staging-only, read-only MCP acceptance probe

**Purpose:** Operator-run verification of the isolated staging MCP deployment after a protected, reviewed manual staging deploy. This is **not** a deployment action and **does not** itself prove any staging environment is available.

**What it tests:** Exact deployed source SHA, connected OAuth user and Workspace scope, selected dummy List, registered read-only reporting tools, bounded Goals data and bounded Sprint/List snapshot metadata. Optionally, one Goal with its key results.

**What it never does:** POST a Chat message, write a task, change OAuth scopes, deploy Workers, inspect the company Worker, print Goal names or task details, send diagnostic responses to GitHub or collect secrets in a repository file. It does not close [#120](https://github.com/cryogenized-spec/ClickUp-Serviteur-MCP/issues/120), which still requires a separately approved, disposable self-DM send and readback.

## Preconditions

1. The operator confirms the **staging** Cloudflare Worker is deployed from reviewed `main`, with its **separate staging OAuth KV and Durable Objects**. The staging manifest generator must stamp `MCP_BUILD_SHA` directly from the validated GitHub `GITHUB_SHA` of that reviewed workflow-dispatch commit, not a dashboard-stored value. The historical staging address was `https://clickup-serviteur-staging.cryogenized.workers.dev/mcp`; reconfirm this in Cloudflare before use. The verifier pins **the exact documented owner-controlled staging hostname** `clickup-serviteur-staging.cryogenized.workers.dev`, over HTTPS `/mcp`; it rejects company Worker hosts, other Cloudflare accounts, alternate paths and URL query strings. Self-hosted forks must review and intentionally change the hard-coded hostname before using this harness.
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

## Optional issue #135 Chat read-only acceptance

This additional gate stays **inside the same staging MCP client and token**. It neither creates a second ChatGPT plugin nor opens/sends/edits/deletes any Chat message. Use an isolated disposable staging self-DM created beforehand using the staging test account's own ClickUp UI. Keep identities and channel/message IDs private.

Set `STAGING_VERIFY_CHAT_CATALOG=true` to require all **14** existing and new Chat tool names in the same Serviteur catalogue, with the correct `readOnlyHint` and `destructiveHint` annotations. This checks **registration only**, not that mutations work. Without a channel ID, it performs no Chat data reads.

For a known staging **self-DM**, supply `STAGING_CHAT_SELF_DM_CHANNEL_ID` (along with the catalogue flag). The probe will then perform read-only checks for an authorized channel's metadata, `clickup_verify_chat_recipients` with `self_dm:true`, and at most five recent message records. It requires a complete exact **one-person self-DM participant set** and refuses foreign channel rows. If a recent disposable message is already present, optionally set `STAGING_CHAT_MESSAGE_ID` to read a bounded reaction page. The message must be discoverable by the existing server-side bounded page verification; do not send a message to make this test pass.

```bash
export STAGING_VERIFY_CHAT_CATALOG=true
# Optional existing self-DM read-only checks:
# export STAGING_CHAT_SELF_DM_CHANNEL_ID="<existing staging self-DM channel ID>"
# export STAGING_CHAT_MESSAGE_ID="<existing recent staging self-DM message ID>"
```

Run the original `node scripts/staging-readonly-acceptance.mjs` command with the same short-lived **staging-only** token. It prints fixed PASS/FAIL stage names and **never prints identities, message contents or response bodies**. A failure does not trigger a fallback write.

Even full success **does not prove** DM creation, replies, delivery, editing, reactions or deletion. These actions require a **separately approved live staging send/readback** in [the private Chat acceptance guide](CHAT_STAGING_ACCEPTANCE_2026-11.md) before issue [#135](https://github.com/cryogenized-spec/ClickUp-Serviteur-MCP/issues/135) can be closed.

## Evidence and completion

- Record only the **staging reviewed/deployed SHA**, date and the names of stages that passed/failed in the private operator's notes. The code must never log private IDs, user accounts, task records or OAuth secrets.
- The result is proof only for **the current deployed staging build and specific OAuth account**, not all ClickUp plans, all Goals, Sprint Dashboard metrics, or all tools.
- Leave company production unmodified. The separate company deployment remains blocked on the existing private-Chat staging acceptance gate and owner review.
- Native self-DM creation and Chat delivery verification remain in [CHAT_STAGING_ACCEPTANCE_2026-11.md](CHAT_STAGING_ACCEPTANCE_2026-11.md).
