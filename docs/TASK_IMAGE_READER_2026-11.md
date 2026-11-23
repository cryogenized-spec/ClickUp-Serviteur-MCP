# ClickUp task image reader — source candidate (23 November 2026)

## Owner request and scope

Add one read-only tool to the **existing ClickUp Serviteur MCP** so the connected model can inspect a PNG/JPEG/WebP attachment already present on an authorized ClickUp task. This addresses screenshot-only status updates such as the WOOX/Mr Giani enquiry without requiring the operator to re-upload images.

The source-only capability is **clickup_read_task_image** with exactly two inputs: the authorized \`task_id\` and exact \`attachment_id\` from a prior task read. A caller cannot provide a URL, arbitrary file path, credentials, or Workspace ID. The tool returns bounded metadata as text/structured data plus a genuine MCP \`type: "image"\` content block. OCR is not done server-side; the connected model interprets pixels. Do not stringify base64 into the text response.

## Authorization and download boundary

- Use the same independently verified per-user ClickUp OAuth grant and verified task home-List/Workspace check as \`clickup_read_task_pdf\`. Require exact attachment membership in that GET response, cap attachment lists at 200.
- Accept only matching extension/MIME for PNG, JPEG and WebP, with at most 3 MiB actual response body, 8192 pixels on each edge, and 16,777,216 total decoded pixels.
- Select the signed \`url\` only from validated task metadata. HTTPS host must equal \`t{workspaceId}.p.clickup-attachments.com\`, with a \`/t{workspaceId}/\` path prefix. No user-supplied URL, redirect, upstream bearer token forwarding, arbitrary CDN domain, or file proxy.
- Download with manual redirect handling, timeout, streaming byte cap, response MIME check, and file-header dimension validation. No signed URL, OAuth token, query string, or image base64 may appear in text/structured output or error diagnostics.
- Respond fail-closed with specific safe \`CLICKUP_IMAGE_*\` codes. The tool makes no ClickUp mutations and adds no permissions to other Workspace resources.

## Synthetic acceptance tests

Tests exercise valid PNG bytes converted to genuine MCP image content, company List scope, cross-List rejection before CDN contact, unlisted attachment rejection, malicious origins, redirects, wrong file types, oversized streaming content, false image signatures, oversized dimensions, and absence of signed URL/bearer-token leakage. Catalogue registration and counts are updated.

## Remaining gates

1. Strict CI (Python policy, formatting, lint, TypeScript, Vitest, Wrangler dry-run, security checks) on the exact source SHA and source review.
2. Protected internal staging deployment and authenticated end-to-end test of the **real** ClickUp task image, including private-attachment link behavior and ChatGPT/Claude image content handling. A green synthetic test is not live acceptance.
3. Explicit owner-approved promotion to the **same existing company Worker** (not a second ChatGPT connector), then verify \`service_info.build_sha\` and an authorized read of WOOX's current screenshot. If ClickUp's private signed CDN rejects the Worker, report the denied read; never disable attachment privacy or open a generic URL-fetch proxy.

No real customer image was stored in GitHub. No production MCP behavior has been changed by this source candidate.
