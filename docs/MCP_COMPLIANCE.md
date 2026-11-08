# MCP conformance contract — baseline 2026-07-28

**Status:** Architecture acceptance criteria, not a conformance certificate. Last researched 2026-10-10 SAST.

## Normative sources (in priority order)

1. Official [MCP specification, revision 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28) and linked Basic Protocol, Transport, Server, Tools, Authorization, Security Best Practices and Changelog documents.
2. Official [MCP TypeScript SDK v2](https://ts.sdk.modelcontextprotocol.io/v2/) and [server library](https://ts.sdk.modelcontextprotocol.io/v2/api/%40modelcontextprotocol/server/).
3. Official [MCP conformance test framework](https://github.com/modelcontextprotocol/conformance) and [MCP Inspector](https://modelcontextprotocol.io/docs/tools/inspector).

The older `@modelcontextprotocol/sdk` v1.x implements the 2025-11-25 spec only. For this new project **use stable SDK v2, `@modelcontextprotocol/server`**, not v1. Build tools with the SDK rather than rolling a partial JSON-RPC handler.

## Required remote MCP capabilities

- Genuine JSON-RPC 2.0 protocol and MCP lifecycle/capability negotiation matching the selected spec revision. Advertise only implemented capabilities.
- Standard MCP `tools/list` and `tools/call` with stable names, declared JSON Schema 2020-12 tool input/output, type-safe runtime input validation, and valid structured results/errors.
- Revised **Streamable HTTP** over HTTPS, one `/mcp` POST endpoint as specified for 2026-07-28; do not blindly copy pre-2026 session IDs, long-lived GET stream endpoints or old HTTP+SSE examples.
- Honor MCP protocol version negotiation, correct headers, request-scoped streams if used, bounded request size, timeouts and cancellation where supported. Never report protocol-level success for a business operation that failed.
- The server must require authenticated access before it can touch any real ClickUp record. Implement standard OAuth authorization compatible with the clients' actual capabilities, protected resource / authorization server metadata as needed, PKCE, scope/identity checks and exact redirect URI rules. Do not confuse MCP client OAuth with backend ClickUp API credential storage.
- Enforce Workspace/List allowlists, read/write scopes, output minimization and OAuth read/write scopes independently of tool metadata. Claude/ChatGPT own their tool approval prompts; the server does not duplicate those settings. Tool descriptions are NOT an access-control system.
- Treat task body content as untrusted; logs must omit secrets. Negative tests must cover unauthenticated, wrong scope, wrong list, replay and 429/partial pagination cases.
- Never return simulated data as live. Tool responses expose explicit `source` and partial-result status when applicable.

## Cross-vendor acceptance

The *same* URL, registered tool definitions and backend adapter must be usable from ChatGPT custom plugin and Claude remote connector. Version fallbacks are permissible only when supported by the official SDK and tested; never invent a proprietary per-vendor 'MCP-like' protocol. A passing local MCP Inspector run cannot substitute for actual connection from both subscription UIs.

## Verification steps — required BEFORE 'MCP compliant' claim

1. Run deterministic SDK integration tests that start the server against synthetic ClickUp fixtures, including invalid initialize requests, tools/list, tools/call, malformed JSON-RPC, malformed schemas and auth denial.
2. Run the **official conformance suite** with the `2026-07-28` requirements, pinned package version, against a reachable test instance. The current upstream command is `npx @modelcontextprotocol/conformance server --url <test-url> --requirements 2026-07-28`. Re-check flags against upstream documentation before adding it to CI.
3. Run MCP Inspector manually on the authenticated test endpoint.
4. Test separate chat-subscription connections: discovery, legitimate reads, rejection of unauthorized requests, and correct denial/error conditions for ChatGPT and Claude.
5. Test official ClickUp REST adapter with bounded real authorized data; verify IDs against ClickUp independently.
6. Save command outputs, tool trace (redacted), spec revision, SDK and conformance versions, SHA, and PASS/FAIL in `docs/DEMO_ACCEPTANCE.md`.
7. Refuse deployment or 'fully compliant' claim if a required protocol, auth or conformance test fails. Never use `continue-on-error` or baseline known failures to conceal failures.

**Implementation update, 2026-10-10:** Phase 2 uses the official `@modelcontextprotocol/server@2.3.1` factory and actual `@modelcontextprotocol/client` to verify tool listing, modern 2026-07-28 handshake, legacy path, invalid argument rejection and four concurrent protocol test clients. These passed on [CI run 38054050247](https://github.com/cryogenized-spec/ClickUp-Serviteur-MCP/actions/runs/38054050247). The public Worker deliberately DENIES access (HTTP 503) pending Phase 3 OAuth. **The official conformance runner, MCP Inspector and two real subscription clients have not been tested. Do not claim conformance certification.**

## Phase 3 OAuth verification status (2026-10-10 SAST)

OAuth code was added with upstream Cloudflare Workers OAuthProvider v1.2.3, its `/mcp` protected route, client-metadata discovery support, per-client consent helpers, GitHub PKCE upstream sign-in and read-only per-request staff allowlist. No homemade token issuance, no GitHub token passthrough to ClickUp or models.

**What CI proves:** strict TypeScript app checks including separate `skipLibCheck:false` Cloudflare and MCP profiles, combined project check, unit/adversarial tests and build/audit. **What it does not prove:** a deployed Cloudflare Worker with KV and GitHub OAuth credentials, end-to-end 401/redirect/token flow, both subscription clients, or the official MCP conformance suite. These require the manual acceptance gates in [PHASE3_SETUP.md](PHASE3_SETUP.md). No MCP conformance certification is asserted.
