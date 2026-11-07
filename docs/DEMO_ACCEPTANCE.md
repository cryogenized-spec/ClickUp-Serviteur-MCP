> **12 October 2026 update:** This is a historical POC checklist with its original dates and prior observations retained for reference. The main branch now contains OAuth and 48 ClickUp catalogue REST adapters with green CI. The owner reports a previous Claude custom-connector handshake against the staging Cloudflare Worker; the real ClickUp task/Doc/Chat operations, native attribution and both subscription clients' acceptance are NOT yet verified. See [PHASE7_STAGING_ACCEPTANCE.md](PHASE7_STAGING_ACCEPTANCE.md) for the current acceptance runbook.

# POC acceptance checklist — Sunday 11 October 2026 target

**Target demonstration:** ~13:00 SAST Sunday 2026-10-11, aspirational only, not a guarantee. **This is an evidence checklist, not a claim of readiness.**

| ID | Criterion | Current status on 2026-10-10 | Evidence required |
|---|---|---|---|
| A1 | Run prior local POC package tests | PASS — 12/12 re-run during docs session | `npm test` output in prior local starter |
| A2 | MCP init, tools/list, synthetic tools/call | PRIOR SESSION REPORTED PASS; not re-run here | Fresh local inspector/smoke transcript |
| A3 | Synthetic data explicitly labeled and zero real ClickUp calls | PASS in local tests only | Mock-source assertions |
| A4 | Read actual authorized Serviteur ClickUp data | NOT TESTED | Result IDs/links checked independently in ClickUp |
| A5 | 48-hour and overdue report matches selected ClickUp List | NOT TESTED | Deterministic comparison and partial-results checks |
| A6 | Unauthorized reads/writes blocked | SIMULATED only | Hosted OAuth/allowlist negative tests |
| A7 | Deployed remote HTTPS Streamable HTTP MCP + OAuth | NOT DONE | Real HTTPS endpoint plus auth flow and denial test |
| A8 | ChatGPT ordinary subscription personal plugin executes live tool | NOT DONE | Recorded user-initiated live round trip |
| A9 | Claude ordinary subscription remote connector executes live tool | NOT DONE | Recorded user-initiated live round trip |
| A10 | Independently approved disposable test task update | NOT TESTED live | Owner approval, task audit, replay denial |
| A11 | No secret leakage and safe logs | DESIGN RULES only | Repo scan, runtime config review and negative tests |
| A12 | Costs, request budgets, limitations evidenced | NOT DONE | Actual counts, pricing sources, exception cases |
| A13 | Four distinct subscription users cannot see or act as each other | NOT TESTED | Four separate OAuth identities, distinct scopes, parallel calls, audit provenance and denial tests |
| A14 | Coordinated budget handles burst and API 429 safely across Worker instances | NOT TESTED | Four-client burst, 429/Retry-After and cross-instance coordination tests |
| A15 | SDK v2 internal diagnostics, public HTTP denial, strict TS and audit | PASS **on Phase 2 pre-checkpoint SHA only** | [GitHub Actions #38054050247](https://github.com/cryogenized-spec/ClickUp-Serviteur-MCP/actions/runs/38054050247): 11 tests, typed lint, TS, build, high audit green. Does NOT validate OAuth or official conformance |

| A16 | Phase 3 OAuth identity logic, upstream consent and fail-closed configuration tests | UNIT TESTS PASS; LIVE NOT TESTED | Draft PR #4 and GitHub `quality` 44/44 tests on Phase 3 pre-documentation SHA; real Cloudflare KV/PKCE/ChatGPT/Claude round trip still NOT TESTED |
| A17 | Four real individuals authenticate and keep sessions isolated | NOT TESTED | 4 separate GitHub OAuth sign-ins; app-specific consent, expired/revoked token denial and cross-user controls |
| A18 | OAuth 2026-07-28 conformance and live resource metadata | NOT TESTED | Official conformance, authenticated 401 challenge/resource metadata, real ChatGPT and Claude client connections |

**GO / NO-GO:** Do not call the project a working *cross-client* POC until A4, A5, A7, A8 and A9 pass. Do not claim write capability until A10 passes. Do not pitch business outcomes until those claims have reproducible evidence.

**Disclaimers:** 100 REST API requests/minute/token on ClickUp Free Forever is a rate limit, not free unlimited operations. `date_updated` reflects ClickUp task metadata; no claim of employee inactivity is implied. Subscription features depend on account/workspace availability and must be verified.
