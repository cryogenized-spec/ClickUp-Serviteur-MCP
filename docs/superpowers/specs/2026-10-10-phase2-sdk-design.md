# Phase 2 — Official MCP SDK foundation (design)

**Date:** 2026-10-10 SAST. **Owner authorization:** proceed with the next development phase using modular, adversarial and phased verification. This specification fixes the Phase 2 scope, not deployment or live ClickUp actions.

## Objective

Build the smallest **real** TypeScript MCP SDK v2 runtime using official `@modelcontextprotocol/server@2.3.1` (MCP 2026-07-28) and pinned npm dependencies. Provide an internal stateless protocol handler and a Cloudflare Worker entrypoint which deliberately **fails closed** until Phase 3 OAuth authentication exists. There is no public unauthenticated MCP access, no ClickUp token and no production state.

## Four-user nonnegotiable requirement

The intended product serves **2–4 different authorized Serviteur staff**, connecting using their own ChatGPT or Claude subscriptions. A shared MCP host must not confuse users, identities, scopes, approval rights, cached results or audit records. The same ClickUp backend credential or organizational quota may be shared only behind server-side authorization and rate-budget enforcement. **Do not assume 100 REST calls/minute remains uncongested under parallel fan-out**.

**Phase 2 design-only contracts:** future `Principal` is a server-validated immutable tuple of `subject`, `clientId`, allowed scopes and organization/list policy. Phase 3 will implement real OAuth, role mapping and verified per-user identity. Phase 4 will implement coordinated cross-instance rate limiting. Absolutely no user identity is derived from untrusted headers or client-provided tool parameters.

## Architecture decisions

- **MCP library:** official SDK v2 stable; `McpServer`, `registerTool`, `createMcpHandler`, and the official `fromJsonSchema` adapter for the closed empty-input diagnostic (rather than an incompatible older Zod StandardJSONSchema interface); not v1 or handwritten JSON-RPC parsing. References: https://ts.sdk.modelcontextprotocol.io/v2/migration/support-2026-07-28 and https://ts.sdk.modelcontextprotocol.io/v2/get-started/first-server
- **SDK factory:** `src/mcp/create-server.ts` exports `createServer()` with one static diagnostic tool `service_info`. No secrets or task data. Each invocation gets fresh server state.
- **Transport:** `src/mcp/handler.ts` constructs a stateless `createMcpHandler(createServer)` for tests/internal inspection. Only the SDK owns JSON-RPC.
- **HTTP entrypoint:** `src/index.ts` exports Cloudflare Worker `fetch` which returns 404 outside `/mcp` and returns 503/denied on `/mcp` while OAuth is not configured. It must not provide `?test=1`, magic headers, environment bypass or synthetic administrator identity. The genuine MCP handler is deliberately **not exposed** by this public entrypoint in Phase 2.
- **No business adapter yet:** ClickUp connectivity, authorization, OAuth and calls are forbidden in this phase.
- **Application dependencies:** package versions pinned exactly; an authentic npm-generated `package-lock.json` required. No handcrafted lockfile. Test runner, strict TypeScript compiler, ESLint with `--max-warnings 0`, Prettier `--check`, Wrangler `--dry-run` or equivalent reproducible Worker build.
- **Tool data:** diagnostic tool returns `phase: 2`, `liveClickUp: false`, `authentication: not-configured`. Do not expose secrets, a user record or false connected state.
- **Concurrency:** no global mutable `Principal`, ClickUp bearer token or request context. Concurrent anonymous requests must all be denied at HTTP boundary. Test 4 concurrent requests.
- **Failure handling:** HTTP errors are deliberate, stable, bounded and labelled `Cache-Control: no-store`; malformed paths and requests cannot enter MCP.

## Module units

`src/mcp/create-server.ts` -> MCP registration and tool schema. `src/mcp/handler.ts` -> SDK handler. `src/index.ts` -> Cloudflare platform denial boundary. `tests/` -> behavior and adversarial tests. `docs/phases/` -> evidence and acceptance.

## Adversarial acceptance

1. Real SDK v2 `server/discover`, `tools/list`, `tools/call` works **only** on internal test handler; invalid input rejected by SDK.
2. External Worker `/mcp` denies GET/POST/OPTIONS/DELETE and cannot be bypassed with forged `Authorization`, `X-User`, `X-Forwarded-User` or `?debug`.
3. Four simultaneous forged-user requests are denied; identical outputs regardless of header/claimed identity.
4. No accidental API calls, no module-global identity; test repeated handler factories.
5. Negative tests for malformed JSON, unknown tool and wrong version via official SDK internal boundary.
6. CI successfully runs `npm ci --ignore-scripts`, formatting, typed lint, strict TS, unit/adversarial tests, build and dependency audit.
7. Phase 2 **not** declared externally deployable or MCP fully compliant until official conformance and OAuth acceptance tests (Phase 3+).

## Explicit limits

GitHub Free private branch protection remains procedural. A green CI run at the exact PR SHA does not prevent an admin bypass. Codex specialist review requested **only after** full code CI green, with the exact SHA and focused threat/model/protocol questions; review is not assumed completed by a PR comment.
