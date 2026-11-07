# Changelog

## [0.3.0-beta.1] — release candidate, 7 November 2026

First public source beta candidate for ClickUp Serviteur MCP.

### Available in the source

- Real ClickUp REST-backed remote MCP tools with separately verified MCP identity and personal ClickUp OAuth, isolated Workspace/List permissions and bounded responses.
- Tasks, Lists, folders, comments, assignments, tags, task links/dependencies, Custom Fields, time-tracking adapters, Docs/Chat operations where the respective upstream API supports them.
- Markdown-native task/List descriptions; separate Markdown/plain-text formats for Docs and Chat; native comment-rich segments for emphasis, links, lists, checklists, code, emoji and verified user mentions.
- Owner-only company cleanup of individual tasks, the owner's comments and task relationships, under exact-object checks.
- Secure Cloudflare Worker hosting, reproducible npm lockfile, GitHub Actions checks, CodeQL and protected manual company/staging deployment.
- Independent source distribution under the MIT license; refreshed branding, security policy, contribution guidance and self-hosting instructions.

### Not yet a general-availability guarantee

- Native tables in task comments and native horizontal rules are not documented in ClickUp's public comment API.
- Docs/Chat deletion coverage, full UI rendering parity, all attachment variants and every upstream feature/plan combination remain incomplete or require live validation.
- This source beta is not an npm publication, public multi-tenant hosted service or first-party ClickUp MCP.
- Migrating from any older staging Worker hostname requires explicit OAuth redirect, connector and Cloudflare resource work. A renamed Worker does not inherit stored state.

For ongoing development evidence and known issues, see [GitHub Issues](https://github.com/cryogenized-spec/ClickUp-Serviteur-MCP/issues).
