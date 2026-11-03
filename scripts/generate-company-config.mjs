/**
 * Generate a SEPARATE owner-approved company Worker manifest.
 * Does not contact Cloudflare or enable OAuth. Never reads staging bindings.
 * GitHub's protected "company" environment supplies non-secret identity IDs;
 * per-profile OAuth client secrets live only in Cloudflare Worker secrets.
 */
import { writeFileSync } from "node:fs";

function numeric(name) {
  const value = process.env[name];
  if (typeof value !== "string" || !/^[1-9]\d{0,17}$/.test(value))
    throw new Error("Missing or invalid " + name);
  return value;
}

const kv = process.env.COMPANY_OAUTH_KV_ID;
if (typeof kv !== "string" || !/^[a-f0-9]{32}$/i.test(kv))
  throw new Error("Missing valid COMPANY_OAUTH_KV_ID");
if (kv === process.env.STAGING_OAUTH_KV_ID)
  throw new Error("Company OAuth KV must differ from staging");

const companyWorkspace = numeric("COMPANY_WORKSPACE_ID");
const companyList = numeric("COMPANY_LIST_ID");
const ownerGitHub = numeric("COMPANY_OWNER_GITHUB_ID");
const ownerClickUp = numeric("COMPANY_CLICKUP_USER_ID");
if (companyWorkspace === process.env.STAGING_WORKSPACE_ID)
  throw new Error("Refusing staging Workspace as company Workspace");

const manifest = {
  name: "neonsales-clickup-mcp-company",
  main: "src/index.ts",
  compatibility_date: "2026-10-10",
  compatibility_flags: ["global_fetch_strictly_public"],
  workers_dev: true,
  // Allow future deployment to retain distinct, dashboard-managed secrets.
  keep_vars: true,
  vars: {
    CLICKUP_WORKSPACE_ID: companyWorkspace,
    CLICKUP_LIST_ID: companyList,
    ALLOWED_GITHUB_IDS: ownerGitHub,
    CLICKUP_READ_GITHUB_IDS: ownerGitHub,
    CLICKUP_STAFF_USER_MAP: JSON.stringify({ [ownerGitHub]: ownerClickUp }),
    CLICKUP_RESOURCE_SCOPE: "list",
    CLICKUP_COMPANY_READ_ONLY: "true",
  },
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
writeFileSync(".wrangler-company.generated.jsonc", JSON.stringify(manifest, null, 2) + "\n", {
  mode: 0o600,
});
console.log("Isolated company manifest generated; IDs and secrets redacted.");
