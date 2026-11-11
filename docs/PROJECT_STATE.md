# 11 November 2026 SAST — M3 Goals + Sprint/List read-only expansion (PR #131)

**Source:** [PR #131](https://github.com/cryogenized-spec/ClickUp-Serviteur-MCP/pull/131) adds three named REST reads to the public source candidate: `clickup_get_workspace_goals`, `clickup_get_goal_details`, and `clickup_get_sprint_task_snapshot`. These bring the reviewed operational catalogue from **71** to **74** REST operations; existing helper tools remain separate.

**Implemented boundaries:** Both Goals operations require explicit OAuth Workspace scope. Goal detail lookup first verifies its exact ID in the authorized Workspace's Goals listing, then validates the returned Goal and any explicit Workspace ancestry. Sprint/List snapshots preflight a verified List, fetch home-List tasks only, validate each returned home List, enforce page/offset bounds, and report **sampled** counts/points only. No Sprint velocity, burndown, commitment report, cross-List task expansion, generic HTTP executor or mutation was added. A Sprint designation cannot be proven by this task read alone.

**Independent evidence (synthetic only):** On PR HEAD `71a58c78201cd497a140411a2c18e058556a291d`, [Strict CI](https://github.com/cryogenized-spec/ClickUp-Serviteur-MCP/actions/runs/43085141028) passed repository policy checks, formatting, ESLint, three TypeScript checks, unit/regression tests, reproducible build, isolated workerd HTTPS OAuth smoke and the high-severity dependency audit. [CodeQL](https://github.com/cryogenized-spec/ClickUp-Serviteur-MCP/actions/runs/43085141075) passed Python, JavaScript/TypeScript and GitHub Actions analysis. This establishes source quality, **not** live ClickUp plan compatibility or staging acceptance.

**Deployment/blockers:** The company Worker is intentionally unchanged (last observed `service_info.build_sha=f1dd7aa3759d584f6acf6f0eb4b96dbfc61a2a48`). Live Goals availability and selected Sprint List behavior still require permissioned staging validation. Issue [#120](https://github.com/cryogenized-spec/ClickUp-Serviteur-MCP/issues/120) remains open for a safe self-DM send/readback acceptance; no staff Chat posts were sent.

**Next action:** Complete final PR #131 review and merge only after the exact final-head security/quality gates. Then test approved, read-only Goals/List responses in staging; unblock company deployment separately after issue #120 staging acceptance.

---

# 7 November 2026 SAST — #88 genuine @mention readback normalization candidate

**Observed:** One owner-approved company task-comment test posted a structured mention. ClickUp's subsequent GET returned a positional `{"type":"tag"}` entry without `user.id`, while the persisted comment and author were present. Existing strict identity readback wrongly reported `CLICKUP_WRITE_OUTCOME_UNKNOWN`; the comment was already created and must not be reposted.

**Source candidate:** Draft [PR #99](https://github.com/cryogenized-spec/ClickUp-Serviteur-MCP/pull/99) modifies only the rich-comment readback check and synthetic mention tests. An ID-free tag may now be acknowledged as **structure-only**: `verified_tag_structure_by_readback:true`, `mention_identity_verified_by_readback:false`, `verified_by_readback:false`, `readback_status:"structure_only"`. The original verified requested IDs remain request metadata, not proof of persisted identities. Provided-but-mismatching IDs, missing tags, changed text, foreign author and uncertain writes remain errors without automatic retries. Existing exact-ID verification remains available.

**Next:** Obtain exact-head green CI and specialist review before owner-controlled merge and protected **manual** company Worker deployment; check the deployed SHA afterward. Do not treat source-only changes as a live fix, claim notifications from self-mentions, or re-post the earlier QA comment. Rich comment editing remains unsupported and #88 stays open.

---

# 5 November 2026 SAST — owner-only task comment editing prepared

A new `clickup_edit_task_comment` capability is being developed on branch `feat/edit-own-task-comments`. It requires an exact task ID, existing comment ID, and replacement text; verifies the task's home List under the authenticated person's grant, then confirms the comment belongs to that same ClickUp user before submitting an update. A post-write readback must confirm the replacement. The company profile permits this non-destructive edit while continuing to deny deleting tasks/comments, moving tasks and authorising cross-List edits. This is SOURCE work only until CI, review, merge, manual Cloudflare deployment and ChatGPT plugin refresh. No live ClickUp comment has been edited by this change.

---

# 3 November 2026 SAST — company read/write requested, destructive mutations blocked

**Updated requirement:** The operator explicitly requested read and write access but **no destructive actions**. PR #73 now prepares a dedicated `clickup-serviteur-company` Worker with `CLICKUP_COMPANY_PROFILE=true` and `CLICKUP_COMPANY_WRITE_MODE=non_destructive`. It advertises optional `mcp:write` only with explicit consent, and the MCP enforces named safe operations server-side before fetching a user credential. Delete/remove/move, document-content replacement, workspace-access expansion and retargeting are disabled in this company profile. Staging remains unchanged.

**Actual shared-List write reach:** The owner clarified that **editing existing tasks must work**. The company List-only profile now exposes single/bulk task editing, status, assignee, priority, due date, description, Custom Field and comment updates, tags, attachments, links and supported time tracking. The server reads and validates each task's exact home List before mutation, including shared-with-me Lists whose Space is not in ordinary hierarchy. A separate Workspace-exclusive OAuth grant is **not** required for these List-verified edits. Foreign-List updates are denied. Delete/remove/move actions and arbitrary Workspace-level writes remain disabled; the tool catalogue reflects which operations are actually enabled.

**Activation:** PR #73 is source-only; no company Worker is deployed and no company tasks have been changed. Complete exact-head CI and Codex review, protected Cloudflare/OAuth setup, a company MCP connection, read-only smoke and owner-approved disposable QA creation before any production work writes. The review and deployment checklist is in [company cutover](COMPANY_WORKSPACE_CUTOVER.md).

---

# 3 November 2026 SAST — company cutover code gates passed on PR #73

**Candidate:** PR #73 in the renamed public repository `cryogenized-spec/ClickUp-Serviteur-MCP`. A shared-List preflight inconsistency identified by Codex at original head `7d2c875` was addressed by centralizing `verifySharedListWorkspace` in `operations.ts` and calling it from catalogue List reads when direct Workspace Space ancestry is absent. The helper accepts **only the configured List ID** in the connected Workspace's `shared.lists`, not a task-only share or unrelated List. Positive and negative tests now cover catalogue List, task, full-text, type and tag reads, malformed and unrelated shares, and rejection before out-of-scope fetch.

**Verified prior code head:** `e44abd45a354c19fd77017f736db54982470f3de`; [Strict CI #41692442341](https://github.com/cryogenized-spec/ClickUp-Serviteur-MCP/actions/runs/41692442341) **success**, 235/235 Vitest, format, lint, TypeScript, build, local OAuth/workerd smoke and npm audit all passed. [CodeQL #41692442224](https://github.com/cryogenized-spec/ClickUp-Serviteur-MCP/actions/runs/41692442224) **success** for Python, Actions and JS/TS. Codex exact-head re-review requested in PR discussion, but new feedback has not yet been confirmed. This documentation commit moves HEAD, so it needs its own exact-head CI before merge.

**Deployment not started:** Company Workspace `[company Workspace ID: protected configuration]` and directly shared Team Serviteur List `[company List ID: protected configuration]` were independently read through the separate work ClickUp connector (work account user `[work user ID: protected configuration]`); this does not mean the custom company MCP is connected. Existing **dummy** staging stays on Workspace `9012707978`. PR #73 remains **draft/unmerged**. A dedicated Cloudflare company Worker, distinct KV/DO storage, company OAuth apps/callbacks and secrets, protected GitHub company environment, manual deployment and read-only company MCP OAuth/List smoke remain uncompleted owner-managed steps. The separate alternative PR #74 overlaps and fails Strict CI; do not merge it merely to clear the queue. No company ClickUp mutations or company MCP credentials have occurred.

**Next:** Complete exact-head CI and independent review of #73; configure isolated company cloud/OAuth infrastructure per [company cutover guide](COMPANY_WORKSPACE_CUTOVER.md), then deploy via the protected manual workflow and connect a **separate** ChatGPT company MCP in **List-only read-only** mode. No production writes authorized.

---

# 3 November 2026 SAST — isolated company ClickUp cutover candidate

The owner confirmed company Workspace and authorized preparing a company-specific MCP profile. A distinct first-party *work* ClickUp account (different user from the dummy account) positively resolves the Team Serviteur List under 'Shared with me'; normal Spaces hierarchy returns no visible Spaces for this user. The existing custom MCP's list ancestry would deny this case. Code candidate adds a fail-closed Workspace-scoped Shared Hierarchy fallback for explicitly shared Lists, a company-read-only server-side write gate, a separate Cloudflare company Worker manifest generator and manual GitHub deployment, plus positive/negative tests. No user token, company task write, company Worker, KV, OAuth secrets or company plugin has been created in this code-only step.

The existing personal dummy staging MCP remains independently connected and must not be repointed. Exact company configuration belongs in a protected GitHub 'company' environment and independent Cloudflare Worker secrets, with reviewed main and manual deployment only. The candidate needs exact-head CI, CodeQL, Codex and a real company read-only OAuth/List smoke before claiming ready. See [cutover instructions](COMPANY_WORKSPACE_CUTOVER.md) and issue #68.

---
# 3 November 2026 SAST — default target reset and ChatGPT discovery root cause

The selector pair `clickup_preview_target` / `clickup_select_target` is already registered in server source and covered by official MCP Streamable HTTP `tools/list`, positive List switch, independent readback, per-user isolation and denial tests. Successful protected staging deployment `41626361578` at main `51dc4295` is confirmed by new `selected_list_id` output. Yet this ChatGPT conversation has a **frozen, previously approved 58-tool snapshot**, excluding the three tool additions/changes. Per OpenAI's documented custom MCP mechanics, the app must be refreshed under Plugins, and any new actions enabled before use. No source-only patch can force ChatGPT to authorize missing actions. [User steps](TARGET_CONFIGURATION.md).

One genuine reset usability issue was addressed as an additive source repair: re-selecting the Worker default now **clears** the per-user List-target record instead of leaving a redundant override. The original Workspace/Space ancestry checks, exact List name, mcp:write scope, owner approval and OAuth connection generation are unchanged. Tests cover selection to another List and resetting to the default, including Vault SQL state and status readback. This code patch is **not live** until reviewed, merged and separately deployed.

---

# 3 November 2026 SAST — merged MCP maintenance and live read-only QA

**Current main baseline:** `fe0c8c8422cafa5dfb6539c8eda6cca1a9944584`, after three safe PR merges: **#28** (`@eslint/js`), **#29** (`eslint`), and **#51** (labelled historical smoke evidence). Both [Strict CI #41613957871](https://github.com/cryogenized-spec/ClickUp-Serviteur-MCP/actions/runs/41613957871) and [CodeQL #41613957627](https://github.com/cryogenized-spec/ClickUp-Serviteur-MCP/actions/runs/41613957627) passed on that exact commit.

**PR cleanup:** six initial open PRs reduced to **zero**. Old #37 was closed unmerged due to merge conflicts and newer reviewed fixes in #55–#67; unique contract tests must still be compared with current main before claiming complete coverage. Incompatible dependency PRs #30 (TypeScript 7 against `typescript-eslint@8.71.1`) and #26 (Wrangler 4.156 against older `workers-types`) were closed unmerged. [Issue #69](https://github.com/cryogenized-spec/ClickUp-Serviteur-MCP/issues/69) tracks coordinated upgrades. **Never bypass npm peer checks** to satisfy a clean PR queue.

**Live approved dummy Workspace audit:** Using ONLY the connected custom `legacy ClickUp MCP`, independently checked its OAuth connection, scoped List, Workspace hierarchy, Workspace members, List metadata, tasks, task detail (both read routes), comments, task/list time entries, Folder metadata, Workspace text search, type/tag searches, current timer (empty), channels, member lookup, attention report and capability metadata. These read routes returned legitimate current results and incomplete flags where relevant. A foreign Workspace ID was rejected with `CLICKUP_SCOPE_OR_SCHEMA_REJECTED`; a foreign List was denied. No task, Doc, comment, Chat message, timer, credential, access grant or target setting was mutated in this session.

**Known live limits:** `clickup_get_task_time_in_status` returned `CLICKUP_UPSTREAM_DENIED`; `clickup_get_list_time_in_status` returned `CLICKUP_STATUS_TIME_DATA_UNAVAILABLE`. Treat these as unavailable with the present ClickUp plan/ClickApp, **not successful measurements**. Three positive fixture gates remain in [issue #65](https://github.com/cryogenized-spec/ClickUp-Serviteur-MCP/issues/65): valid Custom Field write, user-supplied attachment, and populated threaded reply. Complete 48/48 live operational validation has **not** occurred.

**Deployment gap:** Source `main` includes per-user `clickup_preview_target` and `clickup_select_target` from [#67](https://github.com/cryogenized-spec/ClickUp-Serviteur-MCP/pull/67), but the last successful **manual** staging deployment [#41530699184](https://github.com/cryogenized-spec/ClickUp-Serviteur-MCP/actions/runs/41530699184) used older source `6a997edcffb3`. The connected plugin still exposes **58** tools, not the updated source inventory (original expected 59 including workspace-access switch, plus two selector tools). Its connection status lacks selected target details. This is not a merged-code failure; **do not claim the new selector works live** until owner manually deploys reviewed main and reconnects/refetches tool definitions.

**Next precise action:** Owner-triggered [Deploy Serviteur MCP staging (manual)](https://github.com/cryogenized-spec/ClickUp-Serviteur-MCP/actions/workflows/deploy-staging.yml) on final reviewed main, then refresh ChatGPT's custom MCP connection, verify current 61 tool registrations and selector, read-only preview on a second approved dummy List, confirm/reverse a target switch with explicit owner approval, and continue [issue #65](https://github.com/cryogenized-spec/ClickUp-Serviteur-MCP/issues/65) fixtures. Company cutover remains separately blocked by [issue #68](https://github.com/cryogenized-spec/ClickUp-Serviteur-MCP/issues/68). Full observations: [MCP live audit](MCP_LIVE_AUDIT_2026-11-03.md).

---

# 24 October 2026 SAST — Client-aware OAuth consent branding (PR #32, draft)

**Owner clarification:** Consent diagrams must show the logo of the actual connecting client/vendor, not a fixed ChatGPT/Claude identity. The self-contained consent view now chooses between bundled ChatGPT/OpenAI and Claude marks using the matched client name, publisher domain, and OAuth redirect host. Unknown or mismatched clients receive a neutral placeholder; arbitrary client-supplied remote logo URLs are not fetched. Visual matching must not be mistaken for cryptographic client verification.

**Code:** Branch `feature/consent-client-aware-brand-20261024`, [draft PR #32](https://github.com/cryogenized-spec/ClickUp-Serviteur-MCP/pull/32); `src/auth/brand-assets.ts`, `src/auth/consent.ts`, and `tests/consent.test.ts`. Tests were added for ChatGPT, vendor mismatch and unknown fallback. No ClickUp task records, credentials, OAuth grants, production configuration or staging Worker have been changed by this PR.

**Security remediation and evidence (24 October):** Updated root and all nested Zod copies to 4.6.7 and the Miniflare-provided Undici to 7.30.1 using verified tarball SRI hashes and npm overrides; retained MCP SDK 2.3.1 and Wrangler 4.149.0. Code head `8c6e2a0eeabcf4653d9e44550975893609a83b49` passed [Strict CI #40121156676](https://github.com/cryogenized-spec/ClickUp-Serviteur-MCP/actions/runs/40121156676), including all 168 Vitest, typecheck/lint/format, reproducible build, real local workerd OAuth smoke and mandatory npm audit, and [CodeQL #40121156689](https://github.com/cryogenized-spec/ClickUp-Serviteur-MCP/actions/runs/40121156689) succeeded. Focused `@codex review` requested at that exact code head; completion/approval is **not** asserted. This documentation change advances HEAD and requires renewed exact-head CI before merge.

**Release boundary:** PR #32 is still a draft; no merged main, staging deployment, additional ClickUp permission, real task write, or connected-client acceptance is implied. **Next:** verify final exact-head CI and reviewer comments, then owner-authorised merge followed by manual main-branch staging deployment and live ChatGPT consent-page verification.

---

# 21 October 2026 SAST — PR #25 Workspace-bound security candidate

**Owner request:** Resolve the task-move check/use race without dropping any of the 48 tool registrations. The ClickUp API does not document atomic List-bound task-ID writes. Consequently, a strict single-List policy and unrestricted task-ID mutations cannot both be enforced by this MCP alone.

**Candidate code (unmerged):** Introduced server-only opt-in `CLICKUP_RESOURCE_SCOPE=workspace` policy; legacy List mode explicitly denies race-prone task-ID catalogue operations before external API calls, while preserving all 48 tool registrations. Workspace mode validates Lists against the connected Workspace and permits intra-Workspace cross-List operations; task search uses Workspace endpoint only in this mode. The per-user ClickUp OAuth callback now requires exactly one authorised Workspace to store an expanded-privilege credential, and the encrypted per-user Durable Object records that consent evidence transactionally. Existing credentials lack proof and require re-consent.

**Release decision:** D-025 is **PROPOSED**, not ACCEPTED. No expanded policy activated, Cloudflare deployment, ClickUp write, or owner-approved broader access. Live ClickUp verification of token access after external cross-Workspace task moves remains mandatory. See [the design/acceptance plan](PR25_WORKSPACE_SCOPE_PLAN.md) and [original review](PR25_SECURITY_GATE_2026-10-21.md).

**Evidence:** Strict CI and CodeQL are rerunning on the documentation-inclusive PR head. Earlier code-head CI failed formatting and then a test-typecheck issue; both were corrected, but those failures are not release passes. No final exact-head green status claimed until verified. Codex specialist review of the final SHA is also pending.

**Next action:** Obtain exact-HEAD green CI and independent Codex review; then present the broader Workspace boundary for explicit owner acceptance before any staging activation or live mutation.

---

# Security review checkpoint — 21 October 2026 SAST (PR #25 remains blocked)

**Reviewed PR head:** `17eb8df63552781a8559f9a210cbfb8a03e7352f` (prior to this documentation-only update). On that SHA GitHub Strict CI had succeeded, but the latest Codex review retained a P1 task-ID check-then-use race and a P2 cross-List tool semantics issue. The already-implemented home-List search restriction, complete bulk input prevalidation, and preservation of all 48 catalogue adapters remain intact.

**New evidence artifact:** [PR #25 security gate, threat scenario, live acceptance matrix and release options](PR25_SECURITY_GATE_2026-10-21.md), committed first as `f2a266a0572b3f7418448e6b0d0cca90e1158010`. This documents unresolved risk and **does not** claim a code remedy, a successful live ClickUp race test, any security waiver, or owner release approval.

**Release status:** NO MERGE / NO DEPLOY as security-cleared. No staging/production changes or ClickUp writes made. The new documentation commits must be checked against fresh exact-head CI before any specialist re-review or release assessment.

**Next action:** Verify ClickUp permission inheritance and perform controlled cross-List race tests on disposable tasks with independent OAuth accounts; retain all 48 tools and obtain an explicit resource-scope policy decision if single-List isolation cannot be enforced upstream.

---

# Owner correction — 15 October 2026 SAST (PR #25 pending)

**Owner directive:** Do not remove or disable the 22 task-related operations. Restore and retain all **48** operational ClickUp catalogue tool registrations, along with the associated regression tests. The previously proposed 26-tool allowlist and fail-closed dispatcher guard have been reverted on the PR branch. Keep the scoped-List search fix, single-List check and full-batch input validation in PR #25.

**Security status:** The task-ID preflight-to-mutation race remains unresolved. No verified atomic List-bound upstream precondition has been established. The current owner instruction is to preserve feature coverage, **not** an assertion that the race has been fixed or that the owner has approved staging or production exposure of the risk. Do not merge or deploy until independent review and a separately recorded release decision. The exact-head CI and any follow-up review must be repeated after reverting the tool removals.

**Next operational handoff:** The owner can inspect existing Cloudflare staging resources and configure GitHub/Worker secrets through CLI, without deploying or enabling live ClickUp writes. Do not transmit credentials in chat.

---

# Integration checkpoint — 12 October 2026 SAST

**Status: merged and CI-green on main.** Merged [Phase 7 PR #24](https://github.com/cryogenized-spec/ClickUp-Serviteur-MCP/pull/24), its Codex P1/P2 fixes, and Dependabot pinned GitHub Actions updates #9/#10. Final integration commit `46c834c714c08aa1b13e2f026351292c0fcc9315` passed [Strict CI #38225656102](https://github.com/cryogenized-spec/ClickUp-Serviteur-MCP/actions/runs/38225656102). Phase 7's reviewed prior head passed 155/155 Vitest tests (15 suites), lint, format, strict TypeScript, Worker build, local HTTPS/OAuth security smoke, policy checks and npm audit; these are **mocked/local tests, not real ClickUp runtime acceptance**.

**Operational tool coverage:** 48 ClickUp catalogue names now use REST-backed adapters, including the 500 KiB base64 task-attachment operation; each request requires the connected employee's individual OAuth identity and corresponding ClickUp permissions. The original eight Phase 7 Codex findings were patched before merging. A follow-up review was requested but no separate final reviewer approval is asserted here.

**Owner's accepted architecture:** ClickUp is the single task/activity record; Claude/ChatGPT handle their own per-tool prompts. **No separate action journal, rollback database, watchdog, additional tool-approval UI or staff-laptop hosting.** GitHub Actions runs CI/deployment; Cloudflare Workers hosts the remote HTTPS MCP.

**Remaining handoff:** Tonight's GitHub/Cloudflare CLI and configuration/deployment verification comes next (see [PHASE7_STAGING_ACCEPTANCE.md](PHASE7_STAGING_ACCEPTANCE.md)). After staging is updated, independently verify live per-employee ClickUp OAuth, real API route/response compatibility, native ClickUp attribution, Claude and ChatGPT tool discovery and reads/writes, and the official MCP conformance runner. Do not claim production readiness from CI alone. Existing older phase checkpoints below are historical.

---

# Codex P1/P2 remediation — 11 October 2026 SAST

**Current draft:** [PR #23](https://github.com/cryogenized-spec/ClickUp-Serviteur-MCP/pull/23) stacked on draft PR #22. Source: Codex's five findings on #22 (two P1, three P2). Not merged, deployed or tested against live ClickUp.

- **P1 cross-Workspace configuration:** `workspaceId` carried from the individual user's verified ClickUp OAuth grant; every operational tool preflights the configured List's actual Space against the Workspace-specific `GET /team/{workspace_id}/space`. Missing, mismatched or malformed hierarchy fails closed; no model-supplied tenant/list IDs.
- **P1 task move TOCTOU:** remove `update_scoped_task` and `comment_on_scoped_task` entirely from operational tool advertisement and native adapters. There is no documented atomic List-bound precondition on ClickUp task-ID writes, and a GET followed by PUT/POST would not be safe. `get_scoped_task_comments` is also removed due to a related read-after-move exposure risk. Leave ClickUp-native history in ClickUp.
- **P2 write OAuth:** official SDK `requireScopes("mcp:read","mcp:write")` scope challenge for the remaining create task tool, plus existing handler authorization. No server-side permission UI.
- **P2 destructive metadata:** the unsafe task update is no longer advertised or callable, so no false non-destructive annotation is exposed.
- **P2 rate-limit:** propagate bounded upstream write HTTP 429 reset into the same ClickUp-user quota Durable Object; no automatic retries.

**Available direct ClickUp task operations after this change:** read/list/attention report, List metadata, List-bound task creation. The 48 schema-only proposed tools remain inert; no independent audit journal or rollback is built.

**Residual limitations:** List ancestry is verified through upstream reads and is not an atomic lock against a concurrent *List* move; ClickUp's native authorization is the final authority. No task-ID write will be re-enabled without an upstream atomic condition or a proven restricted upstream credential. GitHub-only synthetic CI is not proof of real ClickUp attribution or account consent.

**Release checklist:** strict CI SUCCESS for exact PR #23 SHA, fresh Codex review of that SHA, owner-controlled merge of entire dependency stack, Cloudflare/GitHub secrets staging deployment, four-user OAuth/live List tests and tool response validation. All production mutations remain disabled until acceptance.

---

# Phase 6 native ClickUp tools checkpoint — 11 October 2026 SAST

**Owner-accepted scope:** No Serviteur action journal, rollback backend, duplicate activity UI or duplicate per-tool approval control. ClickUp handles task activity/attribution; AI clients handle allow/deny prompts. Native MCP OAuth `mcp:read` and optional `mcp:write` authenticate access to the MCP resource; individually consented ClickUp OAuth tokens grant actual upstream data rights. No shared ClickUp API token and no laptop-bound service.

**Branch:** `feature/phase6-native-clickup-tools-no-journal-20261011` on [draft PR #22](https://github.com/cryogenized-spec/ClickUp-Serviteur-MCP/pull/22), stacked on #21 → #20 → #18 → #17 → Phase 3. No merge/deploy/real ClickUp mutation. The former [PHASE6_AUDIT_ROLLBACK_CONTRACT.md] proposal has been deleted on this branch.

**Added operational adapters:** `get_scoped_list`, `get_scoped_task_comments`, `create_scoped_task`, `update_scoped_task`, `comment_on_scoped_task`. Each task mutation uses the authenticated staff member's ClickUp token and fixed configured home List, not an LLM-supplied token or arbitrary URL. The 48-model-schema catalogue remains explicitly nonoperational. `service_info` now reports runtime flags without claiming real connectivity.

**Latest full code-only Strict CI:** [run #38148621790](https://github.com/cryogenized-spec/ClickUp-Serviteur-MCP/actions/runs/38148621790) **SUCCESS** on `0bf390c5ae418bd381c4a71eef768a0f22cbe509`. Expected tests: 134/134, strict TypeScript, Prettier, ESLint, pinned Worker build, real local workerd HTTPS OAuth security smoke, 9 Python repository regressions and npm security audit. This documentation update advances HEAD, requiring an **exact-HEAD CI run** before specialist review.

**Not yet proven:** real ClickUp OAuth, permission attribution, REST response shapes, live staging, official MCP conformance, Claude/ChatGPT subscription integration, full 48-capability backend parity, or a clean human-reviewed merge stack. GitHub Actions deployment requires owner-provided Cloudflare GitHub Environment secrets and Worker secrets; none entered in chat.

---

# Owner update — 11 October 2026 SAST: ClickUp-native actions ONLY

Owner explicitly rejected an external action journal, a duplicate rollback system and a separate MCP tool-permission interface. **ClickUp records task history, the AI client controls tool allow/deny prompts, and the MCP merely validates OAuth identity and upstream ClickUp permissions.** The previous Phase 6 audit/rollback proposal is cancelled and deleted on the new feature branch. This branch adds core scoped task create/update/comment and reads, with explicit OAuth `mcp:write` scope. **No deployment, merge or real task mutation has occurred.**

---

# Phase 5 checkpoint — per-user ClickUp OAuth and GitHub-hosted CI/CD (11 October 2026 SAST)

**Owner directive:** Every staff member uses their own ClickUp OAuth. There is **no shared ClickUp API token** and **no laptop-bound service or deployment requirement**. GitHub Actions is the build/test/manual deployment runner; Cloudflare Workers is the actual HTTPS MCP host. Accepted in `docs/DECISIONS.md` D-022/D-023.

**Branch:** `feature/phase5-per-user-clickup-oauth-ci-20261011` on draft [PR #20](https://github.com/cryogenized-spec/ClickUp-Serviteur-MCP/pull/20), stacked on draft PR #18 and #17. No merge, production deployment, stage redeploy, user credentials, live ClickUp calls or task writes.

**Changes:** OAuth-backed `connect_clickup_account`, `get_clickup_connection_status`, `disconnect_clickup_account`, one-time HMAC-signed OAuth state, identity + Workspace check, required one-to-one GitHub-ID/ClickUp-user-ID owner map, AES-GCM-encrypted per-subject Durable Object, strictly per-user ClickUp task token authorization and token-scoped quota. Cloud-only manual main-branch/staging-environment deploy workflow with GitHub environment secrets for Wrangler. Key instructions: [PHASE5_USER_OAUTH_AND_CLOUD_CI.md](PHASE5_USER_OAUTH_AND_CLOUD_CI.md).

**Verification caveat:** A temporary GitHub-hosted formatter and test runner passed 119 OAuth/SDK tests on an earlier code revision. Follow-up security vault tests added 3 cases; initial CI exposed an expected-503 test harness bug, since fixed. **Final exact-HEAD Strict CI remains the authoritative gate**; do not claim green before its actual result. No secrets were added to GitHub.

**Agent action accountability:** ClickUp's native user attribution and signed webhooks remain the first source. Superseded: a separate journal or rollback feature will not be built. ClickUp-native task history remains authoritative.

**Next:** Green final exact-HEAD CI, focused security review of per-user OAuth callback and vault, then owner-managed GitHub/Cloudflare secrets and sandbox account acceptance. Production remains closed.

---

# Schema catalogue checkpoint — 11 October 2026 SAST

**Scope:** Draft [PR #18](https://github.com/cryogenized-spec/ClickUp-Serviteur-MCP/pull/18), `feature/phase4-complete-model-tool-schemas-20261011`, stacked on Phase 4 POC draft PR #17. No merge/deploy or new live ClickUp operation.

**Delivered:** `src/mcp/tool-catalog.ts` contains all **48** named capabilities from ClickUp's published [Supported Tools](https://developer.clickup.com/docs/mcp-tools) listing, with our own closed JSON input schemas, descriptions, examples, effect classes and `schema_only` status. An authenticated `clickup_tool_catalog` offers bounded read-only discovery; **no REST request**. Official MCP SDK registers all 48 only in injected in-process `schemaPreview: true` tests, where all calls fail `CLICKUP_SCHEMA_ONLY`. A normal Worker cannot activate preview through an environment flag. Existing three scoped reads and Phase 3 diagnostic remain unchanged in behavior. See [CLICKUP_TOOL_SCHEMA.md](CLICKUP_TOOL_SCHEMA.md) for the contract and limitations.

**Fresh mechanical evidence:** [Strict CI run #38131409280](https://github.com/cryogenized-spec/ClickUp-Serviteur-MCP/actions/runs/38131409280) **SUCCESS** for code SHA `f81e28c3b9fc249656658a25ddd2e1a7f0ae402e`: 115/115 Vitest in 11 files, 9 repository policy regressions, pinned npm install, Prettier, ESLint, triple TypeScript, Wrangler dry-run, local workerd OAuth security smoke and npm audit (0 reported vulnerabilities). **This added state documentation advances HEAD and requires its own CI**, not a reused green claim.

**What remains unverified:** True ClickUp hosted-MCP runtime JSON schema equivalence (not asserted), all 48 backends (not built), secrets and OAuth approval for ClickUp, dedicated stage deployment, real task reads and real external subscription clients, conformance and specialist review. Owner deferred API tokens. Never advertise `schema_only` entries as working ClickUp operations. No new write capability is authorized.

**Next action:** Obtain exact final HEAD green CI, request specialist reviewer on that unchanged SHA, then leave draft unmerged while owner handles secrets separately. Do not add write methods merely because schemas exist.

---

# Current checkpoint — Phase 4 read-only POC branch (11 October 2026 SAST)

**Branch:** `feature/phase4-clickup-readonly-poc-20261011` (draft [PR #17](https://github.com/cryogenized-spec/ClickUp-Serviteur-MCP/pull/17)); stacked on Phase 3 security test branch from [PR #16](https://github.com/cryogenized-spec/ClickUp-Serviteur-MCP/pull/16), **not merged**.

**Verified evidence:** [Strict CI #38129729291](https://github.com/cryogenized-spec/ClickUp-Serviteur-MCP/actions/runs/38129729291) passed on commit `ffe0d690dfb1c298d30ca8cbc4cf64e4cf363f65`: 108 Vitest tests, nine repository-policy tests, strict triple TypeScript, formatting, ESLint, Wrangler build, workerd OAuth smoke and npm audit (zero vulnerabilities). **Any later commits require fresh CI; this older run does not certify them.**

**Implemented under separate owner-authorized development:** official MCP SDK registrations for `find_scoped_tasks`, `get_scoped_task` and `get_attention_report`; separate GitHub-ID read grant, server-only List ID, GET-only ClickUp REST adapter, conservative shared SQLite Durable Object quota, bounded pagination, 48h SAST attention report and synthetic adversarial tests. See [Phase 4 POC runbook](PHASE4_POC_SETUP.md).

**Live truth:** Earlier Phase 3 staging was independently reported in PR #15 as successfully authenticated from Claude with `service_info`. This does not mean Phase 3 revocation/conformance/multi-staff gates passed. **Phase 4 is not deployed or enabled, has no live ClickUp credential, has not read a ClickUp task through this server and has performed no write.**

**Pending:** Fresh final SHA CI, focused security review, owner-approved single test List + staff READ grant, isolated Cloudflare staging Durable Object migration and secret provisioning, and actual Claude task read/denial. Keep `CLICKUP_LIVE_ENABLED` unset until these approvals. Do not touch the production Worker, merge Phase 3 or merge Phase 4.

---

## Earlier checkpoint (historical; superseded where inconsistent)


**Checkpoint:** 2026-10-10 SAST (time not independently captured). **Current Phase 3:** draft PR [#4](https://github.com/cryogenized-spec/ClickUp-Serviteur-MCP/pull/4), now based on **main**.
**Merged foundation:** PRs [#1](https://github.com/cryogenized-spec/ClickUp-Serviteur-MCP/pull/1), [#2](https://github.com/cryogenized-spec/ClickUp-Serviteur-MCP/pull/2), and [#3](https://github.com/cryogenized-spec/ClickUp-Serviteur-MCP/pull/3) are already merged into main at commit `914c5e69e7366b465f823787225861c3ac40ad29`. Phase 4 design-only PR [#8](https://github.com/cryogenized-spec/ClickUp-Serviteur-MCP/pull/8) remains stacked on #4. Unsafe Node/npm modernization PR #5 is CLOSED without merge.
**Live release status:** NO GO. There is no verified Cloudflare staging account/Worker public HTTPS hostname, real KV namespace, GitHub OAuth App callback/credentials, live personal ChatGPT/Claude connections, or four distinct real employee sign-ins. **No ClickUp reads or production writes.**
**Merge gate:** Maintainer-authorized code merge may be considered separately from release, but current Phase 3 OAuth **live acceptance** is not complete. Do not claim live readiness, deploy or enable ClickUp without the staging runbook tests.

## Latest Phase 3 workerd security smoke (2026-10-10)

- Executable `scripts/staging-local-smoke.mjs` starts the **actual pinned Wrangler/workerd** over loopback-only HTTPS with an ephemeral, self-signed test certificate and **fake nonfunctional** GitHub OAuth app values. In-memory/local KV binding ID is never a real Cloudflare resource. It does NOT contact production services or require runtime secrets.
- CI now runs it after Wrangler build. Missing local KV -> fail-closed **503**. Proper local KV -> unauthenticated **401 Bearer OAuth challenge**; RFC 9728 protected-resource metadata and RFC 8414 authorization-server metadata discoverable with correct issuer, audience and `mcp:read`; forged bearer, spoofed headers and query bypass remain unauthorized.
- Verified first all-green integrated test [run #38081428776](https://github.com/cryogenized-spec/ClickUp-Serviteur-MCP/actions/runs/38081428776), SHA `3edb5e9ccdc0646d4a4cf5a72fac6582881c9258`. **56/56 Vitest**, 9 Python policy regressions, isolated Workerd smoke, strict triple TS, formatting, lint, reproducible Wrangler build and project high-severity npm audit all SUCCESS.
- First smoke run [#38081351855](https://github.com/cryogenized-spec/ClickUp-Serviteur-MCP/actions/runs/38081351855) was RED because pinned Wrangler CLI did not support a newer documented flag; test code was corrected without relaxing expected OAuth results. No production source files were changed.
- **Next action:** Verify quality on this documentation's exact new SHA; request a focused specialist review of the local HTTPS smoke (if final green), then request operator-provisioned isolated Cloudflare/GitHub OAuth staging and actual independent account tests. Do NOT merge and declare Phase 3 operational based on local tests alone.
- Historical handoff notes below describe earlier work and earlier commit states; where those statements conflict with this checkpoint, this current section is authoritative.

## Verified implementation inventory

- **Phase 2 SDK base**: official `@modelcontextprotocol/server@2.3.1`, diagnostic `service_info`; stateless in-process SDK transport. No real ClickUp reads or writes.
- **Phase 3 OAuth provider**: official `@cloudflare/workers-oauth-provider@1.2.3` guards `/mcp`, resource metadata/client registration/PKCE grant lifecycle and token verification. `src/auth/oauth-runtime.ts` requires a verified `ctx.auth` matching the user ID in grant props and checks the current allowlist on every invocation.
- **Identity adapter**: GitHub OAuth App `/authorize` consent → PKCE-bound upstream GitHub login → `/github/callback` → authenticated `GET /user` immutable numeric ID → up to four unique `github:<id>` staff members. This is a POC identity choice: employees need separate GitHub logins in addition to their own ChatGPT/Claude subscriptions. No shared chatbot account.
- **Security**: browser-bound Cloudflare consent/upstream state helpers, escaping user-controlled client metadata, reject forged/expired IDs and missing/invalid token scope. `global_fetch_strictly_public` enables SSRF restrictions for CIMD. No `/mcp` when secrets/KV are unconfigured. No ClickUp keys, production changes, OAuth test backdoors or public deployments.
- **Build**: exact npm-generated lockfile, no temporary write-privileged workflow retained. Three compiler checks: `tsconfig.auth.json` and `tsconfig.mcp.json` each `skipLibCheck:false` plus full app `strict:true` with `skipLibCheck:true` **only to resolve colliding third-party Cloudflare and Node declarations**. Repository policy now requires all three checks and Phase 3 documents.
- **Testing**: 56 deterministic Vitest tests plus isolated real workerd HTTPS security smoke; includes 4 simultaneous staff identities, forged headers/bearers, expired scopes, missing KV, OAuth challenge/metadata and real SDK callbacks. No real OAuth token or multi-user subscription sessions.

## Fresh CI evidence (before last policy/documentation commit)

- [GitHub Actions #38061252610](https://github.com/cryogenized-spec/ClickUp-Serviteur-MCP/actions/runs/38061252610) at `2c91d62f2e4fc94b4cb6a359262fbf466f4ded08`: **quality SUCCESS**, 44/44 Vitest, npm ci, Prettier, ESLint, all three typechecks, Worker dry-run, npm audit 0 vulnerabilities and policy regression suite.
- After that run, additional README, specs, repository policy and checkpoint updates were made. They require **new CI on the final PR #4 HEAD**; the above run is not evidence of later commits. Policy TDD red: [run #38061621439](https://github.com/cryogenized-spec/ClickUp-Serviteur-MCP/actions/runs/38061621439) failed on the intentionally added Phase3 required-docs assertion, followed by repository policy implementation.
- **Unverified:** Actual Cloudflare KV bindings/secrets, deployed HTTPS Worker and 401 challenge, GitHub OAuth app and browser login, token revocation in a real environment, OAuth conformance test, ChatGPT personal Plugin and Claude remote connector invocations, 4 real signed-in staff, ClickUp API and shared request budget. Do not claim Phase 3 live acceptance or final MCP compliance.

## Phase 3 consent-scope adversarial hardening (2026-10-10 SAST)

- **Scope:** Separate PR #4 only; no edits to Phase 2 (#3) or other agent's modernization PR #5. The Phase 3 integration candidate includes the corrected Phase 2 protocol regressions; original Phase 3 is updated only following a verified conflict-free merge and safe coordination.
- **Root cause:** `submitConsent` previously forwarded all browser-submitted `scope` values directly to Cloudflare's consent helper, and Phase 3 advertised `offline_access` although it never issued that scope. A Node unit test importing the full handler also hit the Cloudflare-only `cloudflare:` module loader; testing was moved to a pure policy boundary.
- **RED evidence:** [Actions #38066101760](https://github.com/cryogenized-spec/ClickUp-Serviteur-MCP/actions/runs/38066101760), 5 expected failing scope-policy tests, 41 others passing. Earlier run #38066003572 failed at import boundary, **not** as evidence of a policy failure.
- **GREEN evidence before this checkpoint:** [Actions #38066186197](https://github.com/cryogenized-spec/ClickUp-Serviteur-MCP/actions/runs/38066186197) for commit `0cb51d69b2f295a124801a3630165a3a120bd708`: 46/46 Vitest, strict three-part TypeScript checks, Prettier, ESLint, Wrangler dry-run and `npm audit --audit-level=high` (0 vulnerabilities) all SUCCESS.
- **Fix:** `validatedReadOnlyScopes` rejects unknown, duplicated or empty browser scopes. `submitConsent` returns 400 **before consuming the browser-bound approval handle**. Provider currently advertises only `mcp:read`; refresh/offline authorization is deliberately not claimed in Phase 3.
- **Remaining warning:** Build emitted Node's `url.parse()` deprecation warning from a dependency/runtime path, despite a clean npm audit. Review with toolchain modernization; no waiver/suppression applied.
- **CI-only PR:** [#6](https://github.com/cryogenized-spec/ClickUp-Serviteur-MCP/pull/6) targeted main solely to trigger exact-SHA Actions. It must be closed **without merging** after the final checkpoint commit receives its own successful run.
- **Codex:** PR #4 previously received “create an environment for this repo”, not a completed review. Other agent handles Codex setup/remediation; do not consume duplicate pings. No production deployment or live OAuth checks.
- **Final checkpoint caveat:** This documentation change advances HEAD beyond the green SHA above. Verify **latest HEAD** against a new green Actions run before treating PR #4 as mechanically green.

## Canonical instructions and specifications

- `AGENTS.md` + `CLAUDE.md`: agent instructions and code/test commands.
- `docs/phases/ROADMAP.md`: phases 0–7 and review gates.
- `docs/MCP_COMPLIANCE.md`: MCP protocol requirements and nonclaims.
- `docs/superpowers/specs/2026-10-10-phase3-auth-design.md` and `docs/superpowers/plans/2026-10-10-phase3-auth.md`: Phase 3 design and test-first implementation plan.
- `docs/PHASE3_SETUP.md`: **manual** Cloudflare KV, GitHub OAuth App, Worker secret, custom hostname, account test and OAuth acceptance steps. No secrets in repository/chat.
- `docs/CODEX_REVIEW.md`: require green CI at exact current HEAD before **one** specialist `@codex review`; requesting a review is not completing it.

**GitHub Actions trigger note:** Previous formatter/workflow-bot commits may not trigger a new PR workflow automatically. This human-authorized connector commit intentionally requests fresh CI against the new HEAD. Do not cite any earlier green run as verifying it.

## Codex P1 remediation verified on code SHA (2026-10-10 SAST)

Review: https://github.com/cryogenized-spec/ClickUp-Serviteur-MCP/pull/4 (Codex reviewed merge `9b8d246e78`; two P1 findings).

1. **P1, OAuth provider does not initialize:** The pinned `@cloudflare/workers-oauth-provider@1.2.3` forbids using `requiredScopes` and legacy `resourceMetadata.scopes_supported` together. Removed the obsolete resource metadata scope; retain `scopesSupported: ["mcp:read"]` for the authorization server and `requiredScopes: ["mcp:read"]` for the resource. The first RED job, [#38071287920](https://github.com/cryogenized-spec/ClickUp-Serviteur-MCP/actions/runs/38071287920), reproduced the constructor conflict in an adapter fixture matching pinned provider behavior; the next RED [#38071356014](https://github.com/cryogenized-spec/ClickUp-Serviteur-MCP/actions/runs/38071356014) proved the configuration fix while exposing missing principal forwarding.
2. **P1, verified staff identity lost before tool dispatch:** `src/auth/oauth-runtime.ts` now consumes only `OAuthProvider`-verified `ctx.auth` and `ctx.props`, revalidates the active staff allowlist and `mcp:read`, and passes `authInfo` to the official SDK's `createMcpHandler().fetch(request, {authInfo})`. The per-request `AuthInfo` carries OAuth client ID, resource audience, expiry, least-privilege scope, bearer token and vetted `extra.subject` / `extra.githubId`. Forged headers are ignored; four concurrent user identities remain distinct. No global principal or fallback header identity.
3. **Additional expired-token defense:** An adversarial test proved that a stale context was incorrectly accepted ([RED #38071596569](https://github.com/cryogenized-spec/ClickUp-Serviteur-MCP/actions/runs/38071596569)). The Worker now checks expiry again before SDK dispatch. 
4. **Real SDK test:** A separate in-process official-MCP client/server integration verifies four concurrent tool callbacks see their own identities via `ctx.http.authInfo.extra["subject"]`. This **does not replace** real Cloudflare token verification or hosted ChatGPT/Claude subscriber tests.

**Last verified all-code CI (before this documentation commit):** [run #38072132875](https://github.com/cryogenized-spec/ClickUp-Serviteur-MCP/actions/runs/38072132875), SHA `f3be787042af1a458c63cbb5f94fa7e687ba3fc8`, **SUCCESS**: 56/56 Vitest tests across 7 files, 9 Python policy regressions, Prettier, ESLint, three strict TS profiles, Wrangler dry-run, `npm audit --audit-level=high` (0 reported project dependency vulnerabilities). Node deprecation warnings remain; globally installed package-manager security is a separate gate, and vulnerable npm 12 PR #5 remains closed without merge.

**Temporary formatter CI:** A tightly scoped GitHub Actions formatter ran to normalize newly added regression tests and was then removed from the branch. No elevated workflow remains and no credentials were introduced.

**This checkpoint advances the PR SHA.** A new exact-HEAD quality SUCCESS is REQUIRED before requesting one scoped Codex re-review. PR #4 remains draft, structurally mergeable but not accepted for production or deployment.

## Next exact action

1. Confirm a new `quality` success on the latest PR #4 SHA after this documentation commit.
2. Reply to both original Codex P1 threads with verified resolution and request **one** focused read-only specialist re-review on the final green SHA; do not claim Codex approval without its actual response.
3. Preserve PR stack #1 → #2 → #3 → #4 and owner-controlled merge gate. PR #5/npm 12 modernization stays CLOSED while its global npm bundle audit is RED.
4. Complete real Cloudflare Worker + KV + GitHub OAuth App staging, token audience/PKCE/revocation testing, four separate staff logins and ChatGPT/Claude integration, followed by official MCP conformance, **before** any live ClickUp access or production deployment.

## Phase 2 / Phase 3 conflict-resolution checkpoint (2026-10-10 SAST)

- Integration branch `integration/phase2-oauth-merge-20261010` uses **both** corrected Phase 2 parent `b62d3a438ee5816adc1ae730a94d7cae2e3f8fbf` and Phase 3 OAuth parent `1afe8498547d083a986c37d6e995a1ffc6bd65f0`. The merge retains all Phase 3 OAuth sources, scoped consent verification, Cloudflare Worker bindings, per-staff GitHub identity, and its test/toolchain manifests.
- Conflict resolution: `tests/mcp.test.ts` is restored verbatim from the reviewed Phase 2 foundation; this adds FOUR raw negative MCP transport regressions without deleting Phase 3's 46 authentication tests. This handoff doc retains the advanced Phase 3 checkpoints and adds the foundation resolution. No npm lockfile splicing, no runtime secrets.
- **Do not merge PR #5 here.** Its npm 12.2.0 CLI bundles have a confirmed upstream vulnerability and its supply-chain CI gate currently intentionally fails. OAuth integration stays on its approved npm 10/Node 22 base until the modernization branch is independently corrected and approved.
- The target architecture remains **2–4 independently authenticated staff members**, ChatGPT/Claude integration against one protected MCP backend, server-side ClickUp rights, shared token budget and manual approval before production writes. Real account OAuth/client-conformance checks and Cloudflare provisioning remain outstanding.
- Fresh normal CI on the **exact merge commit** is mandatory before any green/mergeability claim. Test completion alone does not approve deployment or human merge. PRs #1–#4 remain drafts.
