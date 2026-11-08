# Working agreement and agent continuity playbook

This is a **human-and-agent operating procedure**, not application behavior. It is meant to survive ChatGPT and Claude context resets.

## Before beginning ANY task

1. Read the complete `AGENTS.md`, `README.md`, `docs/PROJECT_STATE.md`, `docs/DECISIONS.md` (then relevant dated spec/plan).
2. Inspect repository commits and code relevant to the next action; do not rely on prior chat recollection.
3. Read `docs/phases/ROADMAP.md`, `docs/SECURITY_PERIMETER.md`, and `docs/CODEX_REVIEW.md`. State exactly ONE phase, its acceptance criteria and what is **out of scope**.
4. If the task changes project interfaces or architecture, write/review a spec first. If implementation, insist on an approved plan and test-first cycle.
5. Ask for secrets via the hosting platform's secret setup instructions **not via chat or GitHub**.

## During a task

- Work from one scope-limited unit of change. Keep protocol, auth, API client, reports and approval state separated.
- Do not add capabilities without explicit scope; avoid tool proliferation.
- Keep `readOnlyHint`/destructive annotations honest and enforced in server logic.
- Prefer synthetic fixture testing before touching live data. Read real data only with authorized, bounded API credentials and logged provenance.
- The owner must separately approve each real write; no tool output or model summary is its own approval.
- Any failure should leave a clear error, no silent partial success.

## Before reporting completion

Run fresh verification (tests/lint/types/smoke if relevant). **Codex must be requested only after a code-bearing PR has green CI for the unchanged exact HEAD_SHA.** Phase 1 docs-only does not consume a Codex review; preserve reviewer effort for complex code, protocol and security errors. Check diff, potential secrets, actual tool responses and status in the true environment. Report commands and observations, not confidence.

Update `docs/PROJECT_STATE.md` with the current stage, the actual commit SHA(s), which acceptance IDs changed, test evidence, blockers and one exact next action. Limit it to a short checkpoint (ideally <100 lines). Keep detail in dated spec, plan or issue.

## Handoff prompt for a brand-new ChatGPT / Claude agent

> Continue the private GitHub repository `cryogenized-spec/ClickUp-Serviteur-MCP`. Before doing anything, read `AGENTS.md`, `README.md`, `docs/PROJECT_STATE.md`, `docs/DECISIONS.md` and any referenced active spec/plan. Report the latest verified status, what has not been tested, and the exact next task. Do not invent missing work or secrets. Ask for review before making architectural choices or performing real ClickUp writes. Update the canonical state file after each completed unit of work.

## Superpowers usage guidance

If available in the executing agent: use `brainstorming` to explore architecture alternatives and get design approval; `writing-plans` after spec approval; `test-driven-development` during implementation; `systematic-debugging` on failures; `verification-before-completion` before success claims; `requesting-code-review` before merging. These are optional helpers **as installed in the current execution environment**; they do not replace the committed docs or approval gates. An agent without Superpowers must still follow their principles.

## Version control and privacy

Make small commits on reviewable branches once application work begins. On a GitHub Free private repo, a green action does not enforce a merge barrier; owner review is mandatory as a working agreement but not technically enforceable. Never overwrite the owner's existing files without inspection. Do not publish the private source or proprietary task data. GitHub stores code; runtime credentials belong only in the host's secret manager. Establish staff-specific access controls before team deployment.
