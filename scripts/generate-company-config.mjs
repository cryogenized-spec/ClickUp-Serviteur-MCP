/**
 * Dedicated company ClickUp MCP profile. No staging state or credentials reused.
 * Company runtime secrets are configured independently in Cloudflare.
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
if (
  process.env.STAGING_OAUTH_KV_ID &&
  kv.toLowerCase() === process.env.STAGING_OAUTH_KV_ID.toLowerCase()
)
  throw new Error("Company and staging OAuth KV namespaces must differ");
const workspace = numeric("COMPANY_WORKSPACE_ID");
const list = numeric("COMPANY_LIST_ID");
const owner = numeric("COMPANY_GITHUB_OWNER_ID");
const employee = numeric("COMPANY_CLICKUP_USER_ID");
const origin = process.env.COMPANY_PUBLIC_ORIGIN;
if (!origin) throw new Error("Missing COMPANY_PUBLIC_ORIGIN");
let parsed;
try {
  parsed = new URL(origin);
} catch {
  throw new Error("Invalid COMPANY_PUBLIC_ORIGIN");
}
if (
  parsed.protocol !== "https:" ||
  parsed.origin !== origin ||
  parsed.pathname !== "/" ||
  parsed.search ||
  parsed.hash ||
  parsed.username ||
  parsed.password ||
  parsed.hostname.includes("staging") ||
  (process.env.STAGING_PUBLIC_ORIGIN !== undefined &&
    parsed.origin === process.env.STAGING_PUBLIC_ORIGIN) ||
  (parsed.hostname.endsWith(".workers.dev") &&
    parsed.hostname.split(".")[0] !== "clickup-serviteur-company")
)
  throw new Error("COMPANY_PUBLIC_ORIGIN must be the exact dedicated HTTPS Worker origin");
if (workspace === "9012707978" || list === "901219425894")
  throw new Error("Refusing dummy Workspace/List as a company default");
const profile = {
  name: "clickup-serviteur-company",
  main: "src/index.ts",
  compatibility_date: "2026-10-10",
  compatibility_flags: ["global_fetch_strictly_public"],
  workers_dev: true,
  keep_vars: true,
  vars: {
    MCP_PUBLIC_ORIGIN: origin,
    ALLOWED_GITHUB_IDS: owner,
    CLICKUP_READ_GITHUB_IDS: owner,
    CLICKUP_STAFF_USER_MAP: JSON.stringify({ [owner]: employee }),
    CLICKUP_WORKSPACE_ID: workspace,
    CLICKUP_LIST_ID: list,
    // Enable access only for this owner inside the exact OAuth-approved company Workspace.
    CLICKUP_WORKSPACE_GITHUB_IDS: owner,
    CLICKUP_RESOURCE_SCOPE: "workspace",
    CLICKUP_COMPANY_PROFILE: "true",
    CLICKUP_COMPANY_WRITE_MODE: "non_destructive",
    CLICKUP_OAUTH_ENABLED: "true",
    CLICKUP_LIVE_ENABLED: "true",
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
writeFileSync(".wrangler-company.generated.jsonc", JSON.stringify(profile, null, 2) + "\n", {
  mode: 0o600,
});
console.log("Isolated company non-destructive read/write Worker manifest generated (values redacted).");
