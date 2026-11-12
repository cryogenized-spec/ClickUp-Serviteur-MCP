# Internal staging OAuth perimeter verification — 12 November 2026

**Single-connector design:** ChatGPT uses **one** ClickUp Serviteur MCP connection to the company Worker. The staging Worker is a separate Cloudflare deployment used **only for internal acceptance**; users are not asked to install a second ChatGPT plugin or MCP connector. All new production tools remain in one unified catalogue.

## Purpose

The staging deployment workflow previously considered a successful Wrangler deployment sufficient evidence of availability. A deploy can finish while the public Worker lacks an OAuth binding, returns 503/403, points at another issuer, or redirects unexpectedly. This is not acceptable as a release-readiness signal.

After the protected `Deploy reviewed HEAD to staging Worker only` step, GitHub Actions now executes:

```bash
node scripts/staging-public-oauth-probe.mjs
```

The new probe uses **no bearer token and no ClickUp credentials**. It sends exactly three classes of HTTPS GET requests to the fixed owner-controlled staging hostname:

1. `GET /mcp` without Authorization must yield HTTP `401`, an RFC 9728-style Bearer challenge with `mcp:read`, and a metadata URL.
2. The challenge's protected-resource metadata URL must be HTTPS, on the **same exact staging origin**, beneath `/.well-known/oauth-protected-resource`. The response must confirm `resource: <origin>/mcp`, read scope, and exactly the staging origin as authorization server.
3. `GET /.well-known/oauth-authorization-server` must confirm the same issuer and advertised read scope.

An unexpected HTTP 200, redirect, 403, 404, 429/5xx, invalid response JSON, wrong origin or mismatched issuer is a failure. Requests never follow redirects. Up to three short retries cover temporary deployment propagation; they are **read-only GETs**. The CLI emits only fixed status/category text, never response bodies, OAuth challenge headers, tokens or account identifiers. Eight Node native regression cases test positive and adversarial conditions.

## Evidence and limitations

A successful staging deployment plus a passed public OAuth probe proves that the **public OAuth perimeter responds**. It **does not** prove the authenticated user or connected ClickUp account, source build SHA from `service_info`, upstream Goals/Lists compatibility, or private Chat self-DM delivery. The protected [staging read-only acceptance](STAGING_READONLY_PROBE.md) remains available to an authorized operator using a *staging-only* ephemeral credential, without creating an additional ChatGPT connector. The pending [private-Chat acceptance](CHAT_STAGING_ACCEPTANCE_2026-11.md) must not be replaced by a company-staff DM smoke test.

**Release policy:** Staging is a test environment; company remains the sole user-facing MCP. No changes to company Worker are made by this CI enhancement. Company deployment is a separate, manual step after owner authorization and the remaining acceptance gates.
