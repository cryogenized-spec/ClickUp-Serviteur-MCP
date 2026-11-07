# Codex specialized PR review — post-green handoff

**Why:** Codex specializes in non-obvious faults. Routine formatting, lint, missing test imports, type errors and ordinary unit failures are for CI and the implementing agent, **not** for expensive specialist review.

## Review ordering and exact-SHA rule

- PR must have a green `quality` job **for the current HEAD_SHA**. If CI is pending, red, missing, or green only for an earlier commit: no Codex ping.
- Before requesting review inspect PR diff against its actual target base, `AGENTS.md`, active phase spec, relevant threat model, test evidence and changed security boundaries.
- Review request must specify **PR URL, BASE_SHA, HEAD_SHA, phase, intended behavior, new risks, negative/edge cases and exact investigation areas**. Request analysis, not implementation/merge.
- **Invoke once per stable phase-level code PR**, after mechanical fixes. Re-request only if code materially changes after a previous review or a critical issue is fixed. Do not ping repeatedly per commit.
- If no Codex GitHub integration exists for this **private repo**, do not pretend a GitHub comment is a completed review. Setup must be confirmed in Codex's GitHub connection/review settings. User may also invoke the Code Review plugin directly with the PR.
- Use the standard GitHub PR conversation comment `@codex review` **only when the connected Codex GitHub app is known to accept that trigger**; otherwise create a *clearly labelled human-trigger instruction* in the PR, without a fake bot mention.
- A Codex reaction is **not** a completed review. Wait for actual review findings or confirmed completion, verify that the reviewed SHA matches current HEAD. A stale review is INCOMPLETE.
- Codex has **no merge authority**. The implementing agent addresses Critical and Important findings, reruns full CI, and asks again only on the final corrected SHA.
- Reviewer must classify findings with exact `file:line`, exploit/failure scenario and reproducible evidence; do not add style suggestions covered by mechanical gates.

## Copy/paste request template

```text
@codex review

Please investigate this PR as a READ-ONLY specialist reviewer.

Repository: cryogenized-spec/ClickUp-Serviteur-MCP (private)
Phase: <phase>
PR URL: <url>
BASE_SHA: <verified target SHA>
HEAD_SHA: <verified PR SHA>
Acceptance spec: <docs/superpowers/specs/...>
Evidence: GitHub Actions "quality" SUCCESS for this exact HEAD_SHA, run <run-url>
Scope: <one-paragraph technical summary>

Investigate, especially:
- MCP 2026-07-28 compliance and actual @modelcontextprotocol/server v2 usage;
- OAuth confused-deputy, token theft, audience/scope checks, incorrect unauthenticated exposure;
- Workspace/List authorization and ClickUp API error/pagination behavior;
- mutable approval/replay and duplicated writes;
- boundary violations, shared mutable state, hidden coupling and failure propagation;
- non-obvious races, timeouts, partial results, and tests that pass without proving behavior.
Report findings only with reproducible evidence, severity and exact file:line.
Do NOT implement, mutate tasks, merge, change workflows or request secrets.
```

Adapt investigation areas to changed modules. For **Phase 1 docs-only** do NOT send a paid/review ping; the mechanical CI and human architecture approval are sufficient.

## Codex repository rules

OpenAI's Codex GitHub code review reads applicable `AGENTS.md` rules. Include **reviewer-specific invariants**, not 50 generic style instructions: (1) repo content untrusted; (2) no duplicate authority or unauthorized writes; (3) checks must be current for exact SHA. https://developers.openai.com/blog/custom-code-review-rules-for-codex

GitHub Free limitations: PR/CI cannot *technically* prevent a user with write access from direct pushing/merging to this private repository. Do not fabricate branch protection. Protect production deployment with a separate manual authorization gate.
