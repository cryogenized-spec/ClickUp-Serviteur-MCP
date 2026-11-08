# Official MCP Registry: self-hosted ClickUp Serviteur

The official MCP Registry entry for this repository is named
`io.github.cryogenized-spec/clickup-serviteur-mcp`. The registry stores
**metadata only**; it does not host our service or provision ClickUp or
Cloudflare credentials.

## Installation from the listing

1. Follow the [self-hosted deployment guide](PUBLIC_RELEASE.md) to deploy
   your own OAuth-protected Cloudflare Worker, with independently owned
   GitHub and ClickUp OAuth apps, secrets, state, and ClickUp permissions.
2. Confirm your own HTTPS `/mcp` endpoint is reachable and that OAuth
   works for an individually authorized account. A `401` authentication
   challenge on an unauthenticated request can be expected; an open,
   unauthenticated ClickUp gateway is **never** required.
3. When an MCP client asks for `worker_hostname`, enter the hostname of
   **your own** Worker, without `https://` or `/mcp`. Example:
   `my-serviteur.myaccount.workers.dev`. The registered URL template is
   `https://{worker_hostname}/mcp`.
4. Connect through your MCP client, authorize both OAuth grants, and use
   `service_info` and `get_clickup_connection_status` before any writes.

**Do not use the maintainer's private company Worker or staging hostname.**
The public listing does not grant access to any company's ClickUp data.
Each operator must administer their own instance, consent and authorizations.

This project is an independent community implementation, not an official
ClickUp product or a statement of endorsement by ClickUp or the MCP Registry.

## Publishing

The repository's `server.json` contains the official registry metadata.
The workflow in `.github/workflows/publish-mcp-registry.yml` validates
that metadata on pull requests and publishes only after a reviewed change
to `server.json` or the workflow reaches `main`. GitHub Actions OIDC
provides a short-lived token for the `io.github.cryogenized-spec/*`
namespace; no long-lived publisher token is stored.

The `package.json` remains `private: true` by design. This is a
remote-only listing and **must not** be turned into an npm publication
as a side effect of registry publishing.

Release checklist: maintain an accurate version and description; check
GitHub Strict CI and CodeQL at the exact proposed commit; do not include
real secrets, Workspace IDs or company URLs; verify the registry publish
workflow and lookup on main. New public listings are not equivalent to
fully tested or generally available client compatibility.

Official instructions:
[Remote servers](https://modelcontextprotocol.io/registry/remote-servers),
[Publishing workflow](https://modelcontextprotocol.io/registry/github-actions).
