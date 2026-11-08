# Phased delivery roadmap — ClickUp Serviteur MCP

**Owner-directed process, 2026-10-10 SAST.** Every phase must have a focused PR, deterministic CI evidence, review of the exact HEAD_SHA, documented risks, and a human merge decision. Finishing one phase does **not** authorize implementing the next. No branch rules are technically enforced on this private GitHub Free repository.

| Phase | One deliverable | Mandatory independent evidence | Status |
|---|---|---|---|
| **0: Standards** | Cross-vendor AGENTS.md, upstream Superpowers skills, MCP contract, CI guard | GitHub Actions `quality` green on exact SHA | Review in [PR #1](https://github.com/cryogenized-spec/ClickUp-Serviteur-MCP/pull/1) |
| **1: Perimeter** | Ratified modular boundaries, security threat model, GitHub Free manual gate, post-green Codex protocol and phase integrity checks | Policy regression tests + workflow `quality` green; docs reviewed | Implementation & CI green, draft [PR #2](https://github.com/cryogenized-spec/ClickUp-Serviteur-MCP/pull/2) unmerged |
| **2: SDK skeleton** | Official SDK v2, in-process HTTP tool discovery, strict TS/npm lockfile, fail-closed public Worker, zero ClickUp | `npm ci`, lint, strict typecheck, 11 tests, Worker build and security audit green; **full official conformance not yet claimed** | **CURRENT:** code CI green, draft [PR #3](https://github.com/cryogenized-spec/ClickUp-Serviteur-MCP/pull/3), review pending |
| **3: Identity/authorization** | OAuth Provider 1.x, four distinct GitHub-authenticated staff principals, current allowlist, client consent, protected MCP | Negative identity, schema, consent, GitHub failure, concurrency tests; **real KV/credentials + subscription login still required** | **CURRENT:** Phase 3 code CI green, draft [PR #4](https://github.com/cryogenized-spec/ClickUp-Serviteur-MCP/pull/4); live acceptance outstanding |
| **4: Read-only ClickUp** | One Workspace/List allowlist + bounded tasks and 48-hour report | Mocked adapter, shared cross-instance request budget (same ClickUp token), fairness/429/PII tests, owner-verified real list read | PLANNED |
| **5: Two AI subscription clients** | Same MCP endpoint functioning in ChatGPT plugin and Claude custom connector | Actual user-subscription tool calls recorded per client | PLANNED |
| **6: Approval-gated writes** | ONE disposable test-task update and replay denial | Independent human approval, transaction receipt, ClickUp audit verification | PLANNED |
| **7: Demonstration/pitch** | Falsifiable recorded POC, limits/cost and risk assessment | All claimed capabilities verified; no marketing before evidence | PLANNED |

## Phase discipline

1. **Design:** one written, reviewed spec, exact files and tests, threat-boundary changes documented.
2. **Implement:** smallest vertical slice. One external authority per role. No new technology without explicit decision record.
3. **Mechanical checks:** format → lint → type check → unit/contract tests → build → dependency/security → protocol conformance as relevant. Red CI means STOP, no Codex request.
4. **Evidence:** record PR URL, exact HEAD SHA and green workflow run ID. CI evidence from an older SHA is **stale**.
5. **Specialist review:** after a code-bearing PR is green, request focused Codex review on that exact SHA (see [CODEX_REVIEW.md](../CODEX_REVIEW.md)). Docs-only changes are generally excluded to avoid consuming specialist review time, unless they alter trust boundaries.
6. **Owner merge gate:** human reviews CI, Codex findings and unchanged SHA; consciously merges. On GitHub Free **this is procedural, not enforceable**.
7. **Handoff:** update PROJECT_STATE with exact completed phase, evidence, unresolved findings and the next authorized phase.

No claim that a phase is complete before its required evidence. Do not call a simulated MCP protocol result "compliant" or a subscription client's availability "connected" without the actual acceptance test. **A phase is blocked if a gate is unavailable.**
