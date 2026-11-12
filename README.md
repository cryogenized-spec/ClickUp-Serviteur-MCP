# ClickUp Serviteur MCP

**Self-hosted ClickUp integration for MCP clients** · TypeScript · Cloudflare Workers · dual OAuth · [MIT License](LICENSE)

**Release candidate: v0.3.0-beta.1 — public source beta (7 November 2026)**

**Official MCP Registry:** [View the active v0.3.0-beta.1 listing (JSON)](https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.cryogenized-spec%2Fclickup-serviteur-mcp) · [Self-hosting and registry setup](docs/MCP_REGISTRY.md) · [Glama maintainer metadata](glama.json)

ClickUp Serviteur is a remote [Model Context Protocol](https://modelcontextprotocol.io/) server exposing ClickUp REST operations to MCP-compatible AI clients, including ChatGPT and Claude clients that support remote MCP. Each installation is operated by its own administrator, uses a separate Cloudflare Worker, and verifies both MCP-client identity and the individual's ClickUp OAuth credentials. This is an independent community project, **not** a product of or affiliated with ClickUp.

**Public source does not mean public access to a running Worker.** The reference company deployment is a privately authorized installation. Do not connect strangers to that endpoint, copy another operator's Workspace IDs, or reuse any shared credentials.

**Registry listings are discovery metadata, not public access.** Each user must supply the HTTPS hostname of their *own* configured Worker; there is no shared public ClickUp service.

## Features

- Real ClickUp REST-backed tools for scoped task search, task creation, assignment and editing; lists, folders, tags, dependencies, task links, comments, Custom Fields, time entries, Docs and Chat where supported by the upstream REST API.
- Native task/List Markdown descriptions and Markdown readback; Docs and Chat have separate `text/md` and `text/plain` handling. Native structured rich task comments support emphasis, links, list/checklist/toggle formatting, code, emojis, and verified genuine @mentions.
- A bounded PDF reader for supported text-based attachments. Image/file-upload adapters and several less-common API paths still have open acceptance work; see [Known limitations](#known-limitations).
- Authenticated company-owner cleanup of an exact task, the owner's own comments, tags, links and dependencies, with explicit confirmation and scope validation. This is **not** unrestricted bulk deletion.
- OAuth-bound Workspace or List scope, individual user tokens, encryption at rest for stored credentials, API rate-limit handling, strict request validation and no blind retry after uncertain writes.
- Cloudflare Workers HTTPS hosting, GitHub Actions CI, CodeQL and manually invoked protected deployments.

### What has actually been verified

In November 2026, a protected company deployment was checked against its exact GitHub build SHA. With an individually authorized ClickUp connection, we verified successful creation and assignment of a disposable task, native Markdown description storage, a rich comment with stored formatting segments, and exact task/comment readback. **API readback alone is not proof of visual fidelity for every editor-only block.** Not every endpoint or third-party MCP client has completed live acceptance.

[Formatting compatibility matrix](docs/clickup-formatting-compatibility.md) · [Release notes](CHANGELOG.md) · [Project limitations](docs/PUBLIC_RELEASE.md) · [Security](SECURITY.md)

## Requirements

- Node.js **22.20.0 or newer** and npm for development or GitHub Actions builds.
- A Cloudflare account with Workers, a dedicated OAuth KV namespace and the required SQLite Durable Objects.
- GitHub OAuth credentials to authenticate MCP users; ClickUp OAuth app credentials to authorize each person against their own ClickUp account.
- A specific ClickUp Workspace/List and individually authorized users. Configure your own IDs and OAuth clients; sample values are never production grants.
- An MCP client that can connect to an OAuth-protected remote server.

## Run the checks

```bash
git clone https://github.com/cryogenized-spec/ClickUp-Serviteur-MCP.git
cd ClickUp-Serviteur-MCP
npm ci --ignore-scripts --no-audit --no-fund
python3 scripts/check_repo_policy.py
python3 -m unittest discover -s scripts/tests -p 'test_*.py' -v
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
node scripts/staging-local-smoke.mjs
npm audit --audit-level=high
```

The root package is intentionally `private: true`: this beta is **open-source on GitHub**, not a published npm package. Do not treat a green test suite as confirmation of configured cloud secrets or ClickUp authorization.

## Deploy your own instance

The maintained deployment paths are [staging](.github/workflows/deploy-staging.yml) and [isolated company](.github/workflows/deploy-company.yml). They are invoked manually from reviewed `main`; they do **not** publish an unauthenticated ClickUp gateway.

**One user-facing MCP integration:** The company Worker is the sole ClickUp Serviteur connection in ChatGPT. Staging is internal release-validation infrastructure, **not** a second ChatGPT plugin. The staging deploy pipeline uses an [unauthenticated OAuth perimeter probe](docs/STAGING_PUBLIC_OAUTH_GATE.md) that checks fail-closed discovery and metadata without tokens or ClickUp writes; this check is distinct from authenticated acceptance.

1. Fork the source or create a repository you control. Configure two separate OAuth clients (GitHub for the MCP connection, ClickUp for the upstream personal account) and register the exact HTTPS redirect origins. Use different credentials and stores for staging and company environments.
2. Create Cloudflare OAuth KV and the Worker/Durable Object bindings. Store **GITHUB_CLIENT_SECRET, CLICKUP_CLIENT_SECRET, CLICKUP_STATE_KEY and CLICKUP_TOKEN_KEY** only as Cloudflare secrets or appropriate protected deployment secrets, never as Git-tracked files. Confirm the key encoding requirements in [OAuth setup](docs/PHASE5_USER_OAUTH_AND_CLOUD_CI.md).
3. Configure repository **staging** environment variable `STAGING_OAUTH_KV_ID` and an explicit comma-separated allowlist `STAGING_WORKSPACE_GITHUB_IDS` containing only GitHub identities you authorize. The public beta no longer defaults to the original repository owner's GitHub ID.
4. Choose your own Worker hostname and configure its OAuth callbacks, public origin, ClickUp Workspace/List bindings and staff mapping. See [Deployment and permissions](docs/PUBLIC_RELEASE.md) and [Workspace targeting](docs/TARGET_CONFIGURATION.md). The reference company generator validates `COMPANY_OAUTH_KV_ID`, `COMPANY_WORKSPACE_ID`, `COMPANY_LIST_ID`, `COMPANY_GITHUB_OWNER_ID`, `COMPANY_CLICKUP_USER_ID`, and `COMPANY_PUBLIC_ORIGIN`. It targets a dedicated owner-only Worker; adapt it if you need an entirely separate tenancy model.
5. Trigger the matching **GitHub Actions manual deployment**, connect your MCP client to your *own* Worker HTTPS endpoint, complete both OAuth grants, and call `service_info` and `get_clickup_connection_status` to verify the deployed build and exclusive Workspace access.
6. Exercise reads first, then write/readback against an approved disposable task. Plan cleanup before creating records. Never rely on a task title alone for authorization.

**Migration warning:** This release renames the legacy staging Worker and the generic `wrangler.jsonc` project name. Existing staging URLs, OAuth callbacks, stored Worker state and custom client connectors do **not** automatically migrate. Reconfigure the new origin and Cloudflare resources before switching endpoints, and retire old infrastructure separately. The protected company Worker name is unchanged.

## Known limitations

- ClickUp's public task-comment API does **not** document native table cells or a native horizontal-rule block; plain pipe tables and `---` can display literally. Use a genuine task-description Markdown table or a label/value comment fallback.
- Docs Markdown can be lossy for editor-only tables, toggles, colors and other native components. Chat message and Docs cleanup coverage is not complete.
- There is no general rollback engine. A delete is destructive; ownership, Workspace bounds and explicit consent still matter. Some upstream features depend on ClickUp plan settings and API availability.
- Many older `docs/` records are **historical engineering evidence**, not current instructions. The README and [public release guide](docs/PUBLIC_RELEASE.md) supersede stale operational claims in archived notes.
- Source is publicly readable; the connected private Worker, customer data, staff accounts and API keys are **not** public.

## Project and community

Bug reports and feature proposals: [GitHub Issues](https://github.com/cryogenized-spec/ClickUp-Serviteur-MCP/issues). Contributions: [CONTRIBUTING.md](CONTRIBUTING.md). Report security issues **privately**, as described in [SECURITY.md](SECURITY.md). See [CHANGELOG.md](CHANGELOG.md) for release changes.

**License:** MIT. ClickUp is a trademark of its respective owner; this project does not claim ClickUp endorsement.
