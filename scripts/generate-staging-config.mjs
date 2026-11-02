/**
 * GitHub-hosted Actions creates an isolated staging-only Worker manifest.
 * Never include auth/client secrets in this manifest or in generated logs.
 * OAuth client secrets and individual user credentials live only on Cloudflare.
 */
import { writeFileSync } from "node:fs";

const kv = process.env.STAGING_OAUTH_KV_ID;
if (typeof kv !== "string" || !/^[a-f0-9]{32}$/i.test(kv)) {
  throw new Error("Missing valid STAGING_OAUTH_KV_ID in GitHub staging environment vars");
}
// The repository owner's public numeric GitHub ID. It is NOT an OAuth token.
// Workspace mode defaults on for this staging owner allowlist only.
// Other users stay List-scoped, and exclusive ClickUp OAuth remains required.
const workspaceOwnerIds = process.env.STAGING_WORKSPACE_GITHUB_IDS ?? "256972168";
if (!/^[1-9]\d{0,15}(?:,[1-9]\d{0,15}){0,3}$/.test(workspaceOwnerIds)) {
  throw new Error("STAGING_WORKSPACE_GITHUB_IDS contains invalid GitHub ID(s)");
}
const stage = {
  name: "neonsales-clickup-mcp-staging",
  vars: { CLICKUP_WORKSPACE_GITHUB_IDS: workspaceOwnerIds, CLICKUP_RESOURCE_SCOPE: "workspace" },
  // Existing OAuth/ClickUp dashboard variables must not disappear on deploy.
  // Cloudflare documents keep_vars for preserving dashboard-managed bindings.
  keep_vars: true,
  main: "src/index.ts",
  compatibility_date: "2026-10-10",
  compatibility_flags: ["global_fetch_strictly_public"],
  workers_dev: true,
  kv_namespaces: [{ binding: "OAUTH_KV", id: kv }],
  durable_objects: {
    bindings: [
      { name: "CLICKUP_QUOTA", class_name: "ClickUpQuota" },
      { name: "CLICKUP_CONNECTIONS", class_name: "ClickUpUserConnection" },
    ],
  },
  migrations: [
    { tag: "phase4-v1", new_sqlite_classes: ["ClickUpQuota"] },
    { tag: "phase5-user-oauth", new_sqlite_classes: ["ClickUpUserConnection"] },
  ],
};
writeFileSync(".wrangler-staging.generated.jsonc", JSON.stringify(stage, null, 2) + "\n", { mode: 0o600 });
console.log("Isolated staging manifest generated (KV ID and all secrets redacted).");
