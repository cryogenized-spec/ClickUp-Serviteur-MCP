# Architecture proposal — ClickUp Serviteur MCP

**Draft for human review, 2026-10-10 SAST. Not approved. Not implemented here.**

## Purpose / boundary

Build a privately owned, modest-cost, **single remote MCP service** that lets ChatGPT Plugins and Claude custom connectors work with permitted Serviteur ClickUp tasks through the official REST API. The AI models run in the user's own subscription interfaces, **not** inside this service; no model API credentials are needed for that interaction. We do not promise unlimited calls or compatibility until each actual UI has passed an authenticated tool invocation.

**v0.1 POC:** one operator, one approved Workspace/List, read-only tools, and at most one independent-approval-controlled disposable test-task write. No multi-user production operations, financial transactions, security surveillance or mass staff monitoring.

## Option comparison

| Option | Advantages | Costs/risks | Recommendation |
|---|---|---|---|
| **A. TypeScript + npm + Cloudflare Worker + official MCP/OAuth libraries** | Strong type checks, maintained protocols, simple remote HTTPS, low infrastructure burden, compatible with two clients | Dependency maintenance, Cloudflare account + OAuth configuration | **Preferred**, subject to review |
| B. Retain the zero-dependency JavaScript Worker starter | Smaller code, current mocks pass, no migration to begin | Hand-rolled MCP/protocol/auth needs more scrutiny; future compatibility risk | Keep as reference, not production baseline |
| C. Python MCP server on persistent VPS/managed container | Familiar Python, flexible jobs & workers | Hosting, patching, uptime, TLS and authentication upkeep; cost uncertainty | Reserve for requirements that Workers cannot satisfy |

**Preferred division:** TypeScript is the source language; **Node** is local developer runtime, **npm** manages dependencies and scripts, **npx** invokes tools; **Cloudflare Workers** is the deployment runtime, with **Wrangler** for deployment; **GitHub** hosts private code, review, tests and CI (not the public service). Lock versions and use npm ci in CI. Do not build a second server just for Claude.

## Proposed data flow

```text
ChatGPT (supported custom plugin)       Claude (custom remote connector)
                \                       /
                 \  HTTPS + MCP OAuth   /
                  v                   v
         [single Serviteur remote MCP Worker]
         AuthN/AuthZ, scopes, allowlist, quotas,
         input validation, provenance and audit
                         |
                   ClickUp adapter
                         |
              Official ClickUp REST API
                         |
             approved Workspace / List

        [separate approval interface/state]
        Owner approves immutable test-task proposal
        (NOT an AI-only tool confirmation)
```

MCP server uses **Streamable HTTP** at a stable `/mcp` URL, OAuth-compatible authentication, and narrowly defined tool schemas. Authentication and authorization are separate: being logged in to our MCP does not confer permission to edit every ClickUp task.

## Module/interface boundaries (proposed)

- `transport/mcp`: protocol routing, tools/list and tools/call, structured errors, compatibility tests.
- `auth/`: OAuth client discovery, authorization, token validation, operator identity and scope checks.
- `clickup/client`: token management, API base URL, retries, headers, pagination, 429/backoff and timeouts.
- `tasks/read`: scoped find/get and normalized result formatting with links and SAST timestamps.
- `reports/attention`: derive overdue vs metadata-stale task cohorts; deduplicate; per-assignee aggregation and partial-results notice.
- `approvals/`: immutable proposal, separate owner approval, expiry, replay protection and audit.
- `observability/`: correlation IDs, sanitized metrics, error logging and request counts.
- `tests/`: schema contract tests, synthetic API fixtures, auth failures, pagination, and real-client acceptance scripts.

These module names are **conceptual**; do not create directories or code until accepted specification and implementation plan exist.

## Tool contract proposal

| Tool | Side effect | Minimum guard |
|---|---|---|
| `connection_check` | None | Never claim synthetic results are live |
| `find_tasks` | None | Restrict Workspace/List, cap pages and result size |
| `get_task` | None | Validate task belongs to allowed scope |
| `get_attention_report` | None | Explicit duration; group assignees; label metadata semantics and incomplete results |
| `prepare_test_task_update` | Proposal only | Disposable test-task ID allowlist; no ClickUp mutation |
| `commit_approved_test_update` | Yes | Separately approved immutable proposal + replay protection + exact fields |

Keep product tool results short and unambiguous; no customer PII unless strictly necessary and authorized. Track original record identifiers/URLs so user can verify.

## Authentication and storage options

- **MCP client → Worker:** properly implemented OAuth; authorization code + PKCE as required, discovery/registration support compatible with both target clients, sign-in restricted to authorized operator. Account-specific client behaviors require real tests.
- **Worker → ClickUp:** separate personal ClickUp token only for owner-operated POC, stored as a deployment secret, Workspace/List server allowlist. Later, ClickUp OAuth and individual identities for employees.
- **Approval state:** reject a model-supplied 'approved: true' flag. A separate authenticated owner operation confirms the immutable change; use transactional single-use storage for concurrent/production actions. KV's eventual consistency is not enough for a multi-user write service.
- **Logs:** avoid secrets, personal data, full task bodies by default; retention policy required before production.
- **Threats:** prompt injection inside task descriptions, replayed tool calls, confused-deputy OAuth, static shared secret leakage, excess list access, mistaken duplicate writes, API throttling.

## Subscription-connection checks

**ChatGPT:** current OpenAI plugin docs describe Plugins → Add custom MCP server and invoking a personal plugin from supported ChatGPT surfaces. Account/workspace entitlement and OAuth operation MUST be tested on the actual subscription. Source: https://developers.openai.com/plugins/quickstart

**Claude:** current Anthropic docs describe remote custom MCP connectors for individual plans, including Pro; remote requests originate from Anthropic cloud. Test authenticated tools and confirm the right endpoint/allowlist. Source: https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp

**Cloudflare:** Workers remote MCP/OAuth patterns and authentication examples: https://developers.cloudflare.com/agents/model-context-protocol/guides/remote-mcp-server/ and https://developers.cloudflare.com/agents/model-context-protocol/guides/securing-mcp-server/

## Separate, later automation

A scheduled GitHub Action or Cloudflare Cron Trigger can call the REST API without using a chat subscription, to find tasks older than the threshold. **It is a separate background/reporting subsystem**; don't infer it is implemented merely because interactive MCP tools exist. Email alerts, Gmail OAuth and staff rollouts are later scope.

## Quality / release gates

1. Review and approve architecture and tool contracts.
2. Test read-only adapter against fake API, then real authorized ClickUp scope (with separate consent).
3. Secure HTTPS deploy and OAuth; verify denial paths.
4. Test ChatGPT and Claude separately: tool discovery, live read, error case and permission boundary.
5. Independently approved write on ONE disposable task; verify in ClickUp and replay denial.
6. Document actual run logs, request counts, security findings, deployment costs and known limits.
7. Only then prepare any manager-facing business proposal. No promises of staff-wide functionality at POC stage.

**Questions for review:** (1) approve Cloudflare Worker + TS/npm rather than retaining JS? (2) keep POC single operator / one List? (3) do we need an actual write demo initially, or would verified read-only tools suffice? These are not blockers to documentation work, but are blockers to irreversible implementation.
