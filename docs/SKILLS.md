# Established, upstream-authored development skills

**A custom, task-authoring skill is now available:** [clickup-formatting](custom-skills/clickup-formatting/SKILL.md) documents the current plain-text Serviteur tool schema, safe inventory descriptions, comment limits, and readback/rendering verification. It is maintained in this repository, not vendored from Superpowers, and is **not automatically installed in consumer ChatGPT**. The repository vendors verbatim copies of selected [Superpowers](https://github.com/obra/superpowers) skills by Jesse Vincent / Prime Radiant, MIT-licensed, at upstream commit `bb92a77741419a4ab5f06e711a283343f1ada0c3`. Their exact paths and blob hashes are in [`.agents/skills/upstream-manifest.json`](../.agents/skills/upstream-manifest.json); [MIT attribution](../.agents/skills/SUPERPOWERS_LICENSE) is retained.

## Vendored skills (actual SKILL.md files)

- [brainstorming](../.agents/skills/brainstorming/SKILL.md) — architecture discovery and approval gates.
- [writing-plans](../.agents/skills/writing-plans/SKILL.md) — test-first implementation plan.
- [test-driven-development](../.agents/skills/test-driven-development/SKILL.md) — fail/pass/regression evidence.
- [systematic-debugging](../.agents/skills/systematic-debugging/SKILL.md) — diagnose root causes before editing.
- [verification-before-completion](../.agents/skills/verification-before-completion/SKILL.md) — fresh verification before success claims.
- [requesting-code-review](../.agents/skills/requesting-code-review/SKILL.md) — structured review gate.

**Agent Skills format:** `SKILL.md` YAML frontmatter and conventional skill directory as defined by https://agentskills.io/specification. The GitHub repository makes these discoverable to coding agents that scan `.agents/skills/`; it does not auto-install them into ChatGPT or Claude consumer chats.

**Claude Code:** Prefer installing upstream [obra/superpowers](https://github.com/obra/superpowers) as an official Claude Code compatible plugin and using it there. This repo's `CLAUDE.md` carries the shared local project rules. If a particular coding agent cannot discover `.agents/skills`, install the pinned upstream skills through its documented install mechanism; do not assume a path guarantees automatic activation.

**Codex:** Use native Agent Skills discovery/install behavior described in [OpenAI Plugins](https://github.com/openai/plugins). The older [openai/skills](https://github.com/openai/skills) catalog is explicitly deprecated in favor of OpenAI Plugins; do not blindly install from a defunct catalog. The third-party Superpowers upstream remains independent of OpenAI.

**Supply-chain protection:** No floating `latest` auto-install in CI. Before accepting a skill update, review upstream changes/license and pin the new exact commit and Git blob hashes, then intentionally update the manifest. CI's repository policy check ensures vendored source files are byte-for-byte identical to their recorded source. A passing checksum cannot establish that upstream advice is safe, suitable or automatically active.

**Important separation:** Coding-agent skills guide *development*. They are NOT MCP tools for customers, and do not automatically exist in subscribed ChatGPT/Claude chats. MCP is a separate network protocol whose standards are pinned in [MCP_COMPLIANCE.md](MCP_COMPLIANCE.md).
