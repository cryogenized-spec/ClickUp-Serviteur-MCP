/** Check required staging-only OAuth bindings before uploading a new version.
 * Never log credentials, account identifiers, remote bodies or arbitrary errors.
 * Uses the same Cloudflare credentials as the existing manual deploy workflow.
 */
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

export function missingStagingOAuthBindings(bindings) {
  if (!Array.isArray(bindings)) throw new Error("STAGING_BINDINGS_UNAVAILABLE");
  const find = (name) => bindings.find((binding) => binding?.name === name);
  const missing = [];
  const allowlist = find("ALLOWED_GITHUB_IDS");
  if (!allowlist || allowlist.type !== "plain_text" ||
      !/^[1-9]\d*(?:,[1-9]\d*){0,3}$/.test(allowlist.text ?? "")) {
    missing.push("ALLOWED_GITHUB_IDS");
  }
  const id = find("GITHUB_CLIENT_ID");
  if (!id || !["plain_text", "secret_text"].includes(id.type) ||
      (id.type === "plain_text" && !id.text?.trim())) {
    missing.push("GITHUB_CLIENT_ID");
  }
  if (find("GITHUB_CLIENT_SECRET")?.type !== "secret_text") {
    missing.push("GITHUB_CLIENT_SECRET");
  }
  return missing;
}

export async function stagingOAuthPreflight(fetcher, account, token) {
  if (typeof account !== "string" || !/^[a-f0-9]{32}$/i.test(account) ||
      typeof token !== "string" || !token.trim()) {
    throw new Error("STAGING_DEPLOY_CREDENTIALS_UNAVAILABLE");
  }
  let body;
  try {
    const response = await fetcher(
      "https://api.cloudflare.com/client/v4/accounts/" + account +
      "/workers/scripts/clickup-serviteur-staging/settings",
      {
        method: "GET",
        headers: { Authorization: "Bearer " + token, Accept: "application/json" },
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!response.ok) throw new Error();
    body = await response.json();
    if (body?.success !== true || !Array.isArray(body.result?.bindings)) throw new Error();
  } catch {
    throw new Error("STAGING_BINDINGS_UNAVAILABLE");
  }
  return missingStagingOAuthBindings(body.result.bindings);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const missing = await stagingOAuthPreflight(
      fetch, process.env.CLOUDFLARE_ACCOUNT_ID, process.env.CLOUDFLARE_API_TOKEN,
    );
    if (missing.length) {
      console.error("STAGING_AUTH_NOT_CONFIGURED: configure Cloudflare staging bindings: " + missing.join(", "));
      process.exitCode = 1;
    } else {
      console.log("PASS staging OAuth binding preflight (credential values never logged)");
    }
  } catch (error) {
    const code = error instanceof Error && [
      "STAGING_DEPLOY_CREDENTIALS_UNAVAILABLE", "STAGING_BINDINGS_UNAVAILABLE",
    ].includes(error.message) ? error.message : "STAGING_PREFLIGHT_FAILED";
    console.error(code);
    process.exitCode = 1;
  }
}
