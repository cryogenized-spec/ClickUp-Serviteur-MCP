# Architecture and policy decision log

**Status language:** ACCEPTED = expressly confirmed by owner; PROPOSED = written for discussion; REJECTED = ruled out; SUPERSEDED = replaced by a dated accepted decision. Do not silently promote proposals.

| ID | Date (SAST) | Status | Decision / scope | Reason or next check |
|---|---|---|---|---|
| D-001 | 2026-10-10 | ACCEPTED (user direction) | Build a real working POC **before** pitching a benefit to management | Show evidence, not speculative claims |
| D-002 | 2026-10-10 | ACCEPTED (user direction) | Maintain the project in the **private** `cryogenized-spec/ClickUp-Serviteur-MCP` repository | Keep a persistent shared source of truth |
| D-003 | 2026-10-10 | ACCEPTED (user direction) | Support **both** ChatGPT subscription plugin and Claude subscription connector | One integration should serve both |
| D-004 | 2026-10-10 | ACCEPTED (user direction) | Establish `README.md`, `AGENTS.md` and memory-efficient working documentation **before** more app coding | Context reliability and reviewability |
| D-005 | 2026-10-10 | ACCEPTED (user direction) | Use TypeScript/npm/Node locally, Cloudflare Workers + Wrangler for deployment, official MCP SDK and OAuth | Owner said proceed; auth design still needs separate review |
| D-006 | 2026-10-10 | SUPERSEDED by D-017 | Initial operator = one authorized owner and ClickUp allowlist = one Workspace/List | User requires 2–4 independently authenticated staff |
| D-007 | 2026-10-10 | PROPOSED | Read-only tools first; one disposable task may be changed only via separate human approval | No production mutation based on AI prose |
| D-008 | 2026-10-10 | PROPOSED | Keep old JavaScript POC archive as test/reference rather than silently importing all source | Different dependency/auth/security trade-offs |
| D-009 | 2026-10-10 | ACCEPTED (user direction) | Use upstream professional skills, strict review/verification and `docs/PROJECT_STATE.md` session handoff | Use upstream authored skills with provenance; no fabricated agent memory |

| D-010 | 2026-10-10 | ACCEPTED (user direction) | Target published MCP 2026-07-28 with official TypeScript SDK v2; verify official conformance and both clients | Do not implement 'MCP-like' homebrew |
| D-011 | 2026-10-10 | ACCEPTED (user direction) | Modular architecture with isolatable adapters and strict TypeScript checks | Prevent blast radius and hard-to-debug monoliths |
| D-012 | 2026-10-10 | ACCEPTED (user direction) | Strict CI with fail-closed mandatory checks and branch protection | CI alone is not enforcement; private GitHub plan may require Pro/Team |
| D-013 | 2026-10-10 | ACCEPTED (user direction) | Vendor reviewed upstream skill sources with exact revision and hashes | No handwritten agent skills; MIT attribution preserved |

| D-014 | 2026-10-10 | ACCEPTED (user direction) | Implement as discrete phases, CI green on current SHA before specialist Codex review, reserve Codex for complex errors | Avoid reviewer noise and weak evidence |
| D-015 | 2026-10-10 | ACCEPTED (user direction) | GitHub Free private repo: manual owner merge discipline rather than false claims of enforced branch protection | No paid plan; do not weaken standards |
| D-016 | 2026-10-10 | ACCEPTED (user direction) | Reuse Elara Relay engineering invariants selectively, not its entire unrelated monolithic review skill | One authority per boundary, evidence-driven exact-SHA certification |

| D-017 | 2026-10-10 | ACCEPTED (user direction) | Design for 2–4 independently authenticated Serviteur staff using their own ChatGPT/Claude subscription accounts | Per-user authorization, isolation and audit; shared ClickUp token budget never substitutes for identity |
| D-018 | 2026-10-10 | ACCEPTED (user direction) | Adversarial and concurrency regression tests required from early phases | Test malformed inputs, duplicate requests, unexpected failures and race conditions |

| D-019 | 2026-10-10 | PROPOSED (Phase 3 implementation) | For POC, use independent GitHub OAuth App sign-in with stable numeric GitHub-ID allowlist, official Cloudflare OAuthProvider v1.2.3 | Staff must have individual GitHub accounts; may replace identity provider after review, do not expose real ClickUp yet |
| D-020 | 2026-10-10 | PROPOSED (Phase 3 compiler design) | Run isolated strict `skipLibCheck:false` checks for OAuth and MCP modules AND combined `strict:true` full-project check with `skipLibCheck:true` for incompatible third-party CF/Node globals | Preserves strict app/test checking; requires Codex scrutiny of dependency declaration compatibility |
| D-021 | 2026-10-10 | ACCEPTED (owner architecture) | Two parallel agents work on isolated branches; reconcile Phase 3 only after Phase 2 remediation is reviewed | Avoid write collisions and stale parent commits |

| D-022 | 2026-10-11 | ACCEPTED (owner direction) | Each staff member authorizes ClickUp through their own ClickUp OAuth; retire shared ClickUp API-token design. GitHub OAuth still authenticates each MCP principal. | Preserve ClickUp-native user attribution and independent token permissions; Cloudflare stores credentials encrypted per verified staff subject. |
| D-023 | 2026-10-11 | ACCEPTED (owner direction) | No laptop-bound hosting or deployments. GitHub Actions is the cloud-based CI/CD runner; Cloudflare Workers is the persistent remote MCP host. | Manual reviewed staging deploy; GitHub encrypted secrets for Cloudflare deploy, Worker secrets for app runtime. |

| D-024 | 2026-10-11 | ACCEPTED (owner direction) | **No separate action journal, rollback subsystem, activity dashboard or duplicate client tool-approval settings.** ClickUp handles native task history; Claude/ChatGPT handle per-tool prompts. | Avoid duplicated state and extra failure modes. Keep only necessary OAuth identity, resource authorization and quota protections. |

| D-025 | 2026-10-21 | PROPOSED — NOT ACTIVATED | Make Serviteur Workspace (not a single List) the authority for the 48-operation catalogue **only after explicit owner acceptance**. Require one-Workspace ClickUp OAuth consent per staff member and preserve legacy List mode with fail-closed task-ID tools. | Resolves the incompatible cross-List requirements without claiming a nonexistent atomic List precondition; live ClickUp scope/permission and cross-Workspace move tests remain release gates. See [PR25_WORKSPACE_SCOPE_PLAN.md](PR25_WORKSPACE_SCOPE_PLAN.md). |

| D-026 | 2026-11-12 | ACCEPTED (owner direction) | **One operational ClickUp Serviteur MCP connection and one unified tool catalogue** in ChatGPT; do not require a second staging connector. | The separate Cloudflare staging Worker is internal release infrastructure only, for isolated tests through protected CI or explicit operator-operated probes. Promote approved source into the same existing company MCP connection after gates; never reuse company OAuth credentials for staging or bypass its authorization. |

## Record an accepted decision

Add a new row (or change PROPOSED → ACCEPTED) with the owner's actual review decision, date/time in SAST if known, trade-offs, and affected files. For changed decisions, mark original SUPERSEDED and link the replacement. Don't fabricate approval.

## Not architecture decisions

REST API rate limits, OpenAI/Anthropic account capabilities and Cloudflare product limits are **external facts** requiring periodic verification against official docs; they are not guarantees or user choices.

- ClickUp REST rate limits: https://developer.clickup.com/docs/rate-limits
- ChatGPT custom plugin integration: https://developers.openai.com/plugins/quickstart
- Claude remote connectors: https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp
