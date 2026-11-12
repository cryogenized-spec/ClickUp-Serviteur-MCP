/**
 * Public, unauthenticated OAuth perimeter smoke for the isolated staging Worker.
 * Runs after Cloudflare deployment. No access tokens, ClickUp REST calls,
 * authenticated MCP tools, Chat sends, task writes or additional MCP connectors.
 */
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const STAGING_ORIGIN = "https://clickup-serviteur-staging.cryogenized.workers.dev";
const TIMEOUT_MS = 8000;
const MAX_ATTEMPTS = 3;

export class StagingPerimeterFailure extends Error {
  constructor(stage) {
    super("STAGING_PERIMETER_FAILED");
    this.name = "StagingPerimeterFailure";
    this.stage = stage;
  }
}

export function stagingOrigin(input = STAGING_ORIGIN) {
  let url;
  try {
    url = new URL(input);
  } catch {
    throw new StagingPerimeterFailure("origin");
  }
  if (
    url.origin !== STAGING_ORIGIN ||
    url.href !== STAGING_ORIGIN + "/" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) throw new StagingPerimeterFailure("origin");
  return url.origin;
}

async function requestJson(fetcher, url, stage) {
  let response;
  try {
    response = await fetcher(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new StagingPerimeterFailure(stage);
  }
  if (response.status !== 200) throw new StagingPerimeterFailure(stage);
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > 32_768)
    throw new StagingPerimeterFailure(stage);
  try {
    const body = await response.text();
    if (body.length > 32_768) throw new Error("oversized");
    const parsed = JSON.parse(body);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error("invalid shape");
    return parsed;
  } catch {
    throw new StagingPerimeterFailure(stage);
  }
}

export async function probeStagingPublicOAuth(fetcher, input = STAGING_ORIGIN) {
  const origin = stagingOrigin(input);
  let challengeResponse;
  try {
    challengeResponse = await fetcher(origin + "/mcp", {
      method: "GET",
      headers: { Accept: "application/json" },
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new StagingPerimeterFailure("challenge");
  }
  if (challengeResponse.status !== 401)
    throw new StagingPerimeterFailure("challenge");

  const challenge = challengeResponse.headers.get("www-authenticate") ?? "";
  if (!/^Bearer\b/i.test(challenge) || !/\bscope="mcp:read"/i.test(challenge))
    throw new StagingPerimeterFailure("challenge");

  const metadataAddress = /\bresource_metadata="([^"]+)"/i.exec(challenge)?.[1];
  if (!metadataAddress) throw new StagingPerimeterFailure("challenge");

  let metadataUrl;
  try {
    metadataUrl = new URL(metadataAddress);
  } catch {
    throw new StagingPerimeterFailure("metadata_origin");
  }
  if (
    metadataUrl.origin !== origin ||
    !metadataUrl.pathname.startsWith("/.well-known/oauth-protected-resource") ||
    metadataUrl.search ||
    metadataUrl.hash ||
    metadataUrl.username ||
    metadataUrl.password
  ) throw new StagingPerimeterFailure("metadata_origin");

  const protectedMetadata = await requestJson(
    fetcher, metadataUrl.href, "resource_metadata",
  );
  if (
    protectedMetadata.resource !== origin + "/mcp" ||
    !Array.isArray(protectedMetadata.scopes_supported) ||
    !protectedMetadata.scopes_supported.includes("mcp:read") ||
    !Array.isArray(protectedMetadata.authorization_servers) ||
    protectedMetadata.authorization_servers.length !== 1 ||
    protectedMetadata.authorization_servers[0] !== origin
  ) throw new StagingPerimeterFailure("resource_metadata");

  const issuer = await requestJson(
    fetcher, origin + "/.well-known/oauth-authorization-server", "authorization_metadata",
  );
  if (
    issuer.issuer !== origin ||
    !Array.isArray(issuer.scopes_supported) ||
    !issuer.scopes_supported.includes("mcp:read")
  ) throw new StagingPerimeterFailure("authorization_metadata");

  return true;
}

export async function attemptStagingPublicOAuth(fetcher, report = () => {}) {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      await probeStagingPublicOAuth(fetcher);
      report("PASS staging public OAuth perimeter (no authentication or ClickUp access)");
      return true;
    } catch (error) {
      if (attempt === MAX_ATTEMPTS) {
        const stage = error instanceof StagingPerimeterFailure ? error.stage : "unknown";
        throw new StagingPerimeterFailure(stage);
      }
      // Bounded propagation retries are GET-only; never retry a mutation.
      await new Promise((done) => setTimeout(done, attempt * 1500));
    }
  }
  return false;
}

async function main() {
  try {
    await attemptStagingPublicOAuth(fetch, (message) => process.stdout.write(message + "\n"));
  } catch (error) {
    const stage = error instanceof StagingPerimeterFailure ? error.stage : "unknown";
    // Do not print remote challenge headers, URLs containing query tokens or response bodies.
    process.stderr.write("FAIL staging public OAuth perimeter: " + stage + "\n");
    process.exitCode = 1;
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
  await main();
