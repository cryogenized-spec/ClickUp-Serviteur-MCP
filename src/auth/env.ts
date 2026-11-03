import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { parseStaffAllowlist } from "./staff.js";

export interface OAuthEnv {
  /** Runtime binding provided by Cloudflare, validated at the trust boundary. */
  readonly OAUTH_KV: unknown;
  readonly OAUTH_PROVIDER: OAuthHelpers;
  readonly MCP_PUBLIC_ORIGIN: string;
  readonly ALLOWED_GITHUB_IDS: string;
  readonly GITHUB_CLIENT_ID: string;
  readonly GITHUB_CLIENT_SECRET: string;
  /** Phase 4: optional and separately gated; absent bindings deny every read. */
  readonly CLICKUP_LIVE_ENABLED?: string;
  /** Individually consented ClickUp accounts; no shared API token. */
  readonly CLICKUP_OAUTH_ENABLED?: string;
  /** A dedicated work profile can block all mutations at the server boundary. */
  readonly CLICKUP_COMPANY_READ_ONLY?: string;
  readonly CLICKUP_CLIENT_ID?: string;
  readonly CLICKUP_CLIENT_SECRET?: string;
  readonly CLICKUP_STATE_KEY?: string;
  readonly CLICKUP_TOKEN_KEY?: string;
  readonly CLICKUP_WORKSPACE_ID?: string;
  readonly CLICKUP_STAFF_USER_MAP?: string;
  readonly CLICKUP_CONNECTIONS?: unknown;
  readonly CLICKUP_LIST_ID?: string;
  readonly CLICKUP_READ_GITHUB_IDS?: string;
  readonly CLICKUP_QUOTA?: unknown;
}

export function validatedOAuthOrigin(env: unknown, request: Request): string | null {
  if (typeof env !== "object" || env === null) return null;
  if (!("MCP_PUBLIC_ORIGIN" in env) || typeof env.MCP_PUBLIC_ORIGIN !== "string") return null;
  if (!("ALLOWED_GITHUB_IDS" in env) || typeof env.ALLOWED_GITHUB_IDS !== "string") return null;
  if (
    !("GITHUB_CLIENT_ID" in env) ||
    typeof env.GITHUB_CLIENT_ID !== "string" ||
    !env.GITHUB_CLIENT_ID
  )
    return null;
  if (
    !("GITHUB_CLIENT_SECRET" in env) ||
    typeof env.GITHUB_CLIENT_SECRET !== "string" ||
    !env.GITHUB_CLIENT_SECRET
  )
    return null;
  if (!("OAUTH_KV" in env) || !env.OAUTH_KV || typeof env.OAUTH_KV !== "object") return null;
  if (!("get" in env.OAUTH_KV) || typeof env.OAUTH_KV.get !== "function") return null;
  if (!("put" in env.OAUTH_KV) || typeof env.OAUTH_KV.put !== "function") return null;
  try {
    parseStaffAllowlist(env.ALLOWED_GITHUB_IDS);
    const origin = new URL(env.MCP_PUBLIC_ORIGIN);
    if (
      origin.protocol !== "https:" ||
      origin.pathname !== "/" ||
      origin.search ||
      origin.hash ||
      origin.username ||
      origin.password ||
      origin.origin !== env.MCP_PUBLIC_ORIGIN
    )
      return null;
    if (new URL(request.url).origin !== origin.origin) return null;
    return origin.origin;
  } catch {
    return null;
  }
}

export function configurationUnavailable(): Response {
  return new Response(JSON.stringify({ code: "AUTH_NOT_CONFIGURED" }), {
    status: 503,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
