# Archived local POC v0.1 README — 2026-10-10

> **Historical reference only.** The following summarizes the earlier locally generated starter, which **has NOT been imported** into this repository. File names and commands below refer to that separately generated local archive `clickup-serviteur-mcp-poc-v0.1.zip`. This archive and its source code are not present in this GitHub repository. See ../README.md and PROJECT_STATE.md for authoritative current status. Do not assume any deployment or real ClickUp access.

# ClickUp Serviteur MCP — Proof of Concept v0.1

**Status (2026-10-10, SAST):** local implementation, mocked ClickUp contract tests, and a local HTTP/MCP smoke test reported as completed. **NOT YET a live, deployed, ChatGPT/Claude-connected product.** No real ClickUp records have been accessed or modified by this POC. The test task names are synthetic. This is an engineering starter to support an honest internal demonstration.

## Why this exists

The official ClickUp MCP daily allowance is restrictive for daily operations. ClickUp's public REST API has a separate per-token rate limit (100 requests/minute on Free Forever, as documented October 2026). This custom MCP speaks to the REST API, not to ClickUp's hosted MCP. It consumes REST API requests and is still subject to ClickUp plans, access control, and API terms.

## Previously implemented in the separate local archive

1. `connection_check`: disclose synthetic vs. live status.
2. `find_tasks`: paged lookup by task name, ID, status.
3. `get_task`: fetch one task, restricted to approved List where configured.
4. `get_attention_report`: query tasks overdue and last-updated before a 48-hour threshold; deduplicate, group by assignee, and label partial results with SAST timestamps.
5. `prepare_test_task_update`: create a proposal for **one disposable test task only**, stored in a Cloudflare KV binding.
6. `commit_approved_test_update`: execute only after separate administrator approval at `/admin/proposal/:id` and `/admin/approve`.

The prototype exposed `POST /mcp` and pure JavaScript functions. No npm dependencies were needed to run its unit tests or local server. Compatibility with both subscription UIs was **not** established.

**Inactivity is not proof of employee inactivity.** `date_updated` is metadata; it may change for unrelated reasons and work can happen elsewhere.

## Original local quickstart (requires the archive)

On Linux Mint with Node 20+:

```bash
unzip clickup-serviteur-mcp-poc-v0.1.zip
cd clickup-serviteur-mcp-poc
cp .env.example .env
# Set MCP_ACCESS_TOKEN to a new long random value (e.g. openssl rand -hex 32)
npm test
npm run dev
```

In another terminal: `node scripts/smoke-test.mjs`. In `MOCK_MODE=true`, fixtures are deliberately fake and **zero requests** go to ClickUp.

## Real ClickUp read configuration (not done in this project yet)

In the archive's local `.env` (never commit):

```text
MOCK_MODE=false
CLICKUP_API_TOKEN=<private token; do not paste in chat>
CLICKUP_TEAM_ID=<private numeric Workspace ID>
CLICKUP_LIST_ID=<private approved List ID>
WRITE_ENABLED=false
MCP_ACCESS_TOKEN=<unique server test token, not the ClickUp token>
```

Restart and run the local smoke test. Check response `source: live` and verify actual task IDs/links independently. The personal ClickUp token is used only by the backend as Authorization; it must never be supplied in an LLM prompt.

## Archived independent test-task approval instructions

Only after read-only live tests succeed, create a disposable task with no real customer information. Configure `CLICKUP_TEST_TASK_ID`, `WRITE_ENABLED=true` and a distinct `ADMIN_APPROVAL_TOKEN` kept out of AI chats. The original sample required a Cloudflare KV binding `APPROVALS`. An AI tool prepares a proposal without a write. An administrator inspects it and independently approves with `node scripts/approve-proposal.mjs <proposalId> <https-server-base-url>`, then the AI commits that approved exact proposal. Check the ClickUp audit afterward and reject replay.

**Caution:** KV is eventually consistent and NOT safe for atomic single-use transitions under concurrency. For production, migrate to transactional storage / Durable Object and add trusted operator identity and audit logging. Keep writes disabled until independently reviewed.

## Archived hosting/auth caveat

The original starter used a custom `Authorization: Bearer <MCP_ACCESS_TOKEN>` for local tests and MCP Inspector. It did **not** provide production OAuth, which must be added for ChatGPT-compatible authenticated plugin use. Never select `No authentication` on a public endpoint containing real ClickUp credentials. Cloudflare Workers/Wrangler was proposed; no Cloudflare deployment occurred. GitHub Actions does not host a persistent remote MCP server.

Secrets should be configured using the chosen runtime secret manager, such as Cloudflare Wrangler secrets, not committed into source control.

## Original subscription acceptance path

- ChatGPT: in supported ChatGPT Plugins surfaces, add custom MCP server with HTTPS `/mcp` URL and proper authentication; install and invoke in supported Work/chat interface. Verify actual account feature availability.
- Claude: Customize → Connectors → Add custom connector; connect remotely over HTTPS, authenticate and test real tools.
- Success = subscription chat → authenticated MCP tool → actual ClickUp REST API → real record → accurate response.
- A write success additionally requires **separate recorded human approval** and a verifiable update to the designated disposable test task.

These interfaces do not themselves require separate AI model API purchase, but subscription limits, Cloudflare hosting, OAuth accounts and ClickUp permissions remain relevant.

## Archived demonstration prompts

1. Use `connection_check` and tell me whether results are real.
2. Use `get_attention_report` for 48 hours, overdue first, grouped by staff, flag partial results.
3. Find tasks matching 'dispatch' with the custom MCP.
4. Read a specific disposable test task and prepare a status change, **do not apply**.
5. After separate administrator approval, commit proposal, read task back and reject replay.

## Hard stops

Do **not** pitch as deployed or money-saving until a live read, both client connections, OAuth authorization, correct permission boundaries, and safe independently approved write (if claimed) are verified. REST rate limits, pagination and 429 errors still apply.

## Official resources

- https://developer.clickup.com/docs/rate-limits
- https://developer.clickup.com/reference/getfilteredteamtasks
- https://developer.clickup.com/reference/updatetask
- https://developers.openai.com/api/docs/guides/custom-mcp-server
- https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp
- https://developers.cloudflare.com/agents/model-context-protocol/guides/remote-mcp-server/

**Archival note:** This document is a faithful *operational summary* of the previous POC README, not an assertion the source code has been uploaded. Retain its known limitations; compare it with the reviewed architecture before importing source.
