# Release-readiness and 48-tool truth-in-advertising roadmap

> **Updated live evidence:** [2 November MCP smoke test: 3 new tasks, 11 catalogue tools passing in limited scenarios, 13 correctly guarded, 24 not yet tested](MCP_LIVE_SMOKE_2026-11-02.md). Tool discovery issue [#50](https://github.com/cryogenized-spec/NeonSales-ClickUp-MCP-/issues/50) remains a Workspace-enabled acceptance blocker.

**Live baseline:** 2026-11-02 (SAST, UTC+02:00). **Scope:** the owner's **dummy** ClickUp Workspace `9012707978` and approved List `901219425894` (Workshop Action Register), NOT a production NeonSales Workspace. **No live business task changes authorised by this document.**

## Evidence checkpoint — what is actually known

- The **staging deployment completed successfully**, deploying `main` commit `f0485c2c3fa327bfdccfe42cd858dd73087c84f3`: [GitHub Actions run 41485760603](https://github.com/cryogenized-spec/NeonSales-ClickUp-MCP-/actions/runs/41485760603). Same-SHA [Strict CI](https://github.com/cryogenized-spec/NeonSales-ClickUp-MCP-/actions/runs/41484404678) and [CodeQL](https://github.com/cryogenized-spec/NeonSales-ClickUp-MCP-/actions/runs/41484404731) succeeded.
- A real ChatGPT MCP call to `get_clickup_connection_status` returned `connected: true`, `workspace_exclusive: true`, `workspace_scope_approved: true`, `workspace_scope_enabled: false`, `mcp_read_scope_granted: true`, `mcp_write_scope_granted: true`. The authenticated ClickUp user ID is `164542998`.
- Live **successful read** cases: `get_scoped_list`, `find_scoped_tasks` (21 complete task summaries), `get_scoped_task` (bounded description/format/truncation/priority), `get_attention_report`, `clickup_get_list`, `clickup_get_task`, and `clickup_search_workspace` (one matching authorized task; zero Docs, Lists or Folders returned in List mode). Single-list access is real, not merely synthetic.
- Live **expected denial** cases: `clickup_get_task_comments`, `clickup_get_task_time_entries`, `clickup_get_workspace_hierarchy` returned `CLICKUP_WORKSPACE_SCOPE_REQUIRED`. This proves those routes failed closed in the tested default configuration, **not** that they succeed when authorized.
- The code registers `clickup_set_workspace_access` (explicit owner-only revocable opt-in), but the **ChatGPT connector's current tool enumeration exposes 58 tools and omits it**, although the server responds with new per-user scope-status fields. Expected tool inventory is 48 catalogue + 11 supporting tools = 59. Investigate registration/tool-list refresh/client cache before any Workspace opt-in.
- The source and model-visible tool descriptions do not wholly agree in this session: for example the advertised `clickup_get_task` description still contains legacy “schema-only ... disabled” wording, even though it returned live authorized task data. Diagnose and correct this user-facing discovery discrepancy; never market it as fully synchronized.
- **Open API response-contract risks found by source inspection:** `src/clickup/catalog-runtime.ts` currently maps 204/205 (other than DELETE) and empty `{}` write acknowledgements to `CLICKUP_WRITE_OUTCOME_UNKNOWN`. That can misreport valid upstream writes, depending on the ClickUp route. It also requires top-level JSON objects, while PR #37's prior contract audit identified the ClickUp v3 Docs `page_listing` response as an array. These are likely compatibility failures needing endpoint-specific tests and narrow fixes before their tools can be called reliable. Do not blindly retry an uncertain write or merge PR #37 wholesale onto current OAuth code.
- **No live write or delete acceptance test** was executed in this checkpoint. Never infer write success from `mcp:write` scope alone.
- Codex reviewed PR #46 (scope/input fixes) and PR #47 (staging owner allowlist regex fix) with no major findings. They were merged into `main`. The earlier PR #37 contract audit is still an old draft and **must not be merged blindly**. A read-only differential Codex review was requested on 2026-11-02; review of the original old head alone is not proof its changes are missing from current main.

## Honesty rule

**48 REST-backed catalogue adapters are coded and advertised, but 48/48 real-world functionality is NOT established.** “Registered”, “compiles”, “passes synthetic tests”, “permitted by auth”, “successfully executes one request”, and “fully acceptance-tested” are different states. A tool is VERIFIED only when its declared inputs/effects/scope/errors and native ClickUp outcomes have been independently checked on the deployed version. Expected denial is tagged GUARDED, never counted as working success. User-visible names and descriptions must accurately describe actual active boundaries.

## Release gates and next actions

| Gate | Work | Pass evidence | Status |
|---|---|---|---|
| **R0 — staging deployment** | Deploy reviewed main, CI, CodeQL | Same-SHA success, server health | **PASS** for `f0485c2`; no production deployment |
| **R1 — discovery parity** | Refresh/reconnect ChatGPT custom MCP; re-run `tools/list`; compare advertised metadata with `src/mcp/create-server.ts`; verify 59 expected tools including `clickup_set_workspace_access` and accurate descriptions | Exact tool inventory, schema, version, client screenshot or redacted trace | **OPEN / BLOCKER for expanded scope** |
| **R2 — current List-mode read acceptance** | Exercise applicable scoped reads, search, pagination, dates/partial flags, error surfaces, no foreign-resource leakage | Real disposable IDs and readback; 403 and scope denial traces | **PARTIAL PASS** |
| **R3 — explicit owner-only Workspace opt-in** | In dummy Workspace ONLY, verify owner GitHub allowlist, exclusive ClickUp OAuth, `mcp:write` scope, and explicit owner consent before calling `clickup_set_workspace_access(enabled:true)`. Verify no other user silently gains access. | Updated status `workspace_scope_enabled:true`; refusal for nonowner/wrong Workspace; reversible switch | **NOT STARTED**; requires explicit owner approval |
| **R4 — 48-tool acceptance matrix** | Exercise each catalogue adapter with authorized disposables/harmless reads, native readback, declared schema and deny cases; record date, result and GitHub/ClickUp evidence | 48 row-by-row results, correct status/effects, no unclear outcomes | **NOT COMPLETE**; some reads only |
| **R5 — security & protocol** | OAuth revocation, token isolation, malicious text, task-move race assumptions, limited/redacted outputs, rate limits, 429/cooldown, 5xx uncertain write, parallel users, time precision, official MCP conformance suite | Reproducible negative tests, redacted logs, conformance result, human-reviewed risk exceptions | **PARTIAL** (synthetic CI exists; live required) |
| **R6 — cross-client and operational pilot** | ChatGPT + Claude tool discovery; native ClickUp attribution; staged staff permission tests; error recovery; usage and cost evidence | Two clients real tests, owner go/no-go, documented support and revocation | **NOT COMPLETE** |
| **R7 — production rollout** | Owner-approved authorised workspace, least privilege, staged migration/rollback via ClickUp native history, staff education | Explicit owner acceptance and signed evidence; no unapproved use | **NOT AUTHORIZED** |

## 48-capability functional acceptance groups

Each group must test the documented *read* or *write* behaviour and separately test the expected denial under insufficient permissions. No actual business tasks or private user records should be used for destructive tests.

| Group | Tools | Current evidence and next test |
|---|---:|---|
| Workspace/task search | 3 | **PARTIAL**: text search returns correct dummy List task, no Docs/foreign Lists in List mode. Validate tag/type searches, pagination, malformed IDs, Workspace-enabled behaviour. |
| Task create/get/update/field/delete | 5 | **PARTIAL**: get works. Create/update/custom fields/DELETE not independently accepted; use owner-approved disposable task, verify native activity and exact fields; delete only disposable and with separate approval. |
| Bulk task create/update | 2 | **NOT LIVE-VERIFIED**: verify partial success, input rejection, duplicate prevention, safe handling of network loss. |
| Attachment upload | 1 | **NOT LIVE-VERIFIED**: use harmless small file, <=500 KiB, check native visibility and type. |
| Comments and threaded replies | 3 | **GUARDED** in List mode. When authorized, read/post threaded comments on disposable task and confirm correct attribution. |
| Tags | 2 | **NOT LIVE-VERIFIED**: add/remove existing test tags, no unintended tag creation. |
| Task links/dependencies | 4 | **NOT LIVE-VERIFIED**: test link vs blocker semantics on two disposable tasks, reverse and verify. |
| Multi-List relationships | 2 | **NOT LIVE-VERIFIED**: test add/move with approved dummy Lists, check task-move race and scope. |
| Time tracking | 6 | **GUARDED** for tested entry read. Test timer start/stop, manual time, totals and failure/permission behaviour using a dummy task only. |
| Workspace hierarchy | 8 | **PARTIAL**: Get List works; Workspace hierarchy was **GUARDED**. Test creation/update Folder/List using disposable hierarchy only. |
| Members and assignees | 3 | **NOT LIVE-VERIFIED**: resolve identities exactly and handle ambiguity/privacy; no impersonation. |
| ClickUp Chat | 2 | **NOT LIVE-VERIFIED**: only on approved dummy channel, with separate permission before sending. |
| ClickUp Docs | 5 | **NOT LIVE-VERIFIED**: create/read/update disposable Doc/page, verify access, content and API response types. |
| Time-in-status reporting | 2 | **NOT LIVE-VERIFIED**: verify prerequisite ClickApp and readback. |
| **Total** | **48** | **No claim of complete parity or complete acceptance** |

## Known hazards, design constraints, and safety rules

1. **No deception by omission:** publish each tool's operational status, current permission scope and known plan limits; correct stale tool descriptions or cached inventory before offering a wider deployment.
2. **No false atomicity:** task-ID mutations on the ClickUp REST API lack a proven atomic home-List precondition; the owner-only Workspace grant changes the trust boundary deliberately. Do not silently widen a regular staff user's grant.
3. **No blind retries:** on ambiguous POST/PUT outcomes, read ClickUp state first to prevent duplicate tasks or comments. Bulk operations can partly succeed.
4. **No privileged secrets in ChatGPT:** GitHub Actions staging environment stores Cloudflare deployment secrets; Cloudflare Worker secrets hold OAuth keys; no credentials in Git, tool outputs or chat.
5. **No hidden sharing:** ClickUp remains the task/activity ledger; Claude/ChatGPT handle client confirmation; this MCP does not create an independent journal, custom rollback engine, or separate approval UI.
6. **No production writes as tests:** use disposable records in the dummy Workspace; explicit owner approval for any test mutation and further approval for destructive deletion, Chat or broad Workspace scope.
7. **Privacy:** confirm private staff/customer data is not exposed in unnecessary tool fields. Do not opt confidential operational data into model training without organizational permission.
8. **Rate limiting:** native ClickUp REST API limits apply per connected account even when the first-party MCP's daily call allocation is not used.
9. **Evidence freshness:** tests run against older branch heads or synthetic fixtures do not establish functionality of the deployed staging revision.
10. **Endpoint-specific ClickUp payloads:** verify empty write acknowledgements and Docs page-listing arrays against the documented and actual REST response. A tool that incorrectly reports a successful write as uncertain is not 'working as advertised'.

## Immediate next session

1. Refresh the custom MCP connection in ChatGPT to force fresh tool discovery. Verify `clickup_set_workspace_access` is visible and compare actual 59 tool declarations against source. If missing, troubleshoot MCP registration/client discovery (no grant changes).
2. Re-run the previously passing List-mode read/denial smoke tests after reconnection, retaining dummy Workspace scope.
3. Obtain separate owner approval to enable Workspace access on the dummy board, test explicit opt-in and opt-out; **leave it off after acceptance**.
4. With owner approval, create a bounded disposable task suite and systematically work through the 48-group matrix, recording PASS/FAIL/GUARDED/UNTESTED and tool response accuracy.
5. Run live negative-security and official MCP conformance checks. Only then consider real NeonSales staff pilot and production-readiness claims.

**Next milestone:** the ChatGPT tool-list mismatch is resolved and at least the List-mode read/scope tests have repeatable evidence. **Definition of done:** 48/48 tools individually accepted (or accurately marked unsupported), safe revocation, successful conformance, and explicit owner-authorized production release.
