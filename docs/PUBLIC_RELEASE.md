# Public source beta: v0.3.0-beta.1

ClickUp Serviteur is an independent, source-available remote MCP implementation distributed under MIT. It is **not** a public shared service, an npm package, or an endorsement from ClickUp.

## Support and release checklist

**Demonstrated in an owner-operated company Worker:** ClickUp OAuth connection, Workspace-bound permissions, task creation with owner assignment, native Markdown task description submission and readback, native rich comment submission/readback, listed cleanup tools and identical deployment/source build SHA. Strict CI, TypeScript, tests, isolated workerd smoke and CodeQL have passed on reviewed PRs. This is not evidence of every ClickUp endpoint and every UI element.

**Before each beta tag:** Require Strict CI and CodeQL on the exact release commit; run a secret/token scan, verify that upstream action versions are pinned, verify the license, and confirm no organization-specific branding remains in the tracked tree. Prefer signed annotated Git tags and release notes that identify a concrete SHA. Protected Cloudflare Workers are deployed separately after source review. The current source branch is a PR, not a completed tag.

## Per-installation configuration

Use an independent Cloudflare Worker, GitHub OAuth app, ClickUp OAuth app, dedicated OAuth KV namespace and encryption secrets. Do **not** point external users to the maintainer's private company Worker. All OAuth client permissions depend on an explicit authorized person and the exact ClickUp Workspace. Never hardcode the original maintainer's GitHub ID into a self-hosted deployment.

### Representative non-secret settings

| Setting | Purpose |
| --- | --- |
| `MCP_PUBLIC_ORIGIN` | Exact HTTPS URL for your individual Worker; must match registered callbacks |
| `ALLOWED_GITHUB_IDS`, `CLICKUP_READ_GITHUB_IDS` | GitHub identities approved for your instance |
| `CLICKUP_WORKSPACE_GITHUB_IDS` | Narrow owner approval for Workspace-wide operations |
| `CLICKUP_RESOURCE_SCOPE` | `list` unless deliberate Workspace authority is configured |
| `CLICKUP_WORKSPACE_ID`, `CLICKUP_LIST_ID` | Your ClickUp Workspace and home List, verified through OAuth |
| `CLICKUP_STAFF_USER_MAP` | Map authorized GitHub user IDs to corresponding ClickUp user IDs |
| `CLICKUP_OAUTH_ENABLED`, `CLICKUP_LIVE_ENABLED` | Explicit switches for active OAuth/live API |
| `CLICKUP_COMPANY_PROFILE` | Enables the company-specific write policy when true |
| `CLICKUP_COMPANY_WRITE_MODE` | `non_destructive` for normal company writes |
| `CLICKUP_COMPANY_CLEANUP_ENABLED` | Additional owner-only destructive cleanup capability |

These variables alone **never prove permission**; the per-user OAuth credential and upstream ClickUp ACL remain mandatory.

### Secrets and state

Create `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `CLICKUP_CLIENT_ID`, `CLICKUP_CLIENT_SECRET`, `CLICKUP_STATE_KEY`, `CLICKUP_TOKEN_KEY` in the right protected Cloudflare environment. Do not include their values in GitHub public variables, issues, sample configuration, screenshots, AI prompts or logs. The OAuth KV and Cloudflare Durable Objects must be dedicated to your deployment and protected with appropriate account rights. Encryption key rotation must be planned before replacing a deployed key.

For the **staging** workflow, configure GitHub environment `STAGING_OAUTH_KV_ID` and **explicitly** `STAGING_WORKSPACE_GITHUB_IDS` (one or more numeric user IDs). The beta intentionally fails closed if the owner allowlist is absent. Staging manifest generation does not contain secrets; configure those in the Worker service.

For the **company** workflow, configure GitHub environment variables `COMPANY_OAUTH_KV_ID`, `COMPANY_WORKSPACE_ID`, `COMPANY_LIST_ID`, `COMPANY_GITHUB_OWNER_ID`, `COMPANY_CLICKUP_USER_ID` and `COMPANY_PUBLIC_ORIGIN`. Review the company-specific generator and adapt the hostname/owner model before using it. The reference company profile enables owner cleanup unless `COMPANY_CLEANUP_ENABLED=false` is explicitly set; choose that setting deliberately before deployment.

### Migration from older staging

The beta changes the staging Worker name to `clickup-serviteur-staging` and the generic `wrangler.jsonc` name to `clickup-serviteur-mcp`. This does **not** rename an existing Cloudflare resource in place, migrate KV/Durable Objects or update OAuth callbacks. Export or retain credentials and data through approved administrative routes, register new OAuth redirect origins, update clients, deploy and verify the new Worker, then explicitly decommission the old staging resource after confirming access. Do not assume a rename preserves state. The protected company Worker continues to use `clickup-serviteur-company`.

### Safe acceptance

1. Connect with an approved MCP client and verify `service_info.build_sha` against the source commit.
2. Check `get_clickup_connection_status` (Workspace exclusivity, read/write permission, authorized selected List).
3. Use read-only tools, then one explicitly approved disposable task; inspect stored Markdown and rendered formatting.
4. For native comments, use `rich_segments`. The public comment API does **not** document real table cells or horizontal-rule blocks. Unsupported formats must be disclosed or use a visible fallback.
5. Confirm readback and any cleanup action by exact ID. Do not repeat an uncertain write blindly.
6. Keep live API data and security logs out of the public repository.

## Beta gaps

Native table blocks in task comments, complete Docs/Chat cleanup, some image attachment flows and complete renderer parity remain unfinished or unverified. For a list of current issues, see [project issues](https://github.com/cryogenized-spec/ClickUp-Serviteur-MCP/issues). The private company Worker is not open to anonymous users. Third-party hosting, licensing compliance, data retention and user consent are the responsibility of each self-hosted operator.

## Distribution

Publish a GitHub source release after reviewed PR merge, CI/CodeQL and a reproducible release commit. The npm package remains intentionally `private: true`: a GitHub release is distinct from uploading to the public npm registry. If npm distribution is desired later, review distributable files and deployment credentials separately.
