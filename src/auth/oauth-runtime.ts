import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { createProtocolHandler } from "../mcp/handler.js";
import { requireActivePrincipal } from "./staff.js";
import { handleAuthorizationPage } from "./authorize.js";
import type { OAuthEnv } from "./env.js";

/**
 * Cloudflare OAuthProvider supplies authenticated ctx.props and ctx.auth only after
 * verifying a resource-audience-bound token. An ordinary exported handler avoids
 * introducing a second runtime-specific WorkerEntrypoint class.
 */
export function handleOAuthRequest(
  request: Request,
  env: OAuthEnv,
  context: Parameters<OAuthProvider<OAuthEnv>["fetch"]>[2],
  origin: string,
): Promise<Response> {
  const provider = new OAuthProvider<OAuthEnv>({
    apiRoute: "/mcp",
    apiHandler: {
      async fetch(incoming, currentEnv, ctx) {
        if (new URL(incoming.url).pathname !== "/mcp") return new Response(null, { status: 404 });
        const verified = ctx as unknown as {
          props?: { readonly userId?: unknown };
          auth?: {
            readonly userId?: unknown;
            readonly scope?: unknown;
            readonly token?: unknown;
            readonly clientId?: unknown;
            readonly audience?: unknown;
            readonly expiresAt?: unknown;
          };
        };
        const claims = verified.auth;
        if (
          !verified.props ||
          !claims ||
          !Array.isArray(claims.scope) ||
          !claims.scope.every((scope: unknown) => typeof scope === "string") ||
          typeof claims.token !== "string" ||
          !claims.token ||
          typeof claims.clientId !== "string" ||
          !claims.clientId ||
          claims.audience !== new URL(incoming.url).origin + "/mcp" ||
          typeof claims.expiresAt !== "number" ||
          !Number.isFinite(claims.expiresAt) ||
          claims.expiresAt <= Date.now() / 1000
        ) {
          return new Response("Forbidden", { status: 403 });
        }
        try {
          const principal = requireActivePrincipal(
            verified.props,
            claims.userId,
            claims.scope as string[],
            currentEnv.ALLOWED_GITHUB_IDS,
          );
          // These facts come ONLY from the OAuthProvider-validated context.
          // MCP does not validate Authorization headers or reconstruct authInfo.
          return createProtocolHandler({ bindings: currentEnv }).fetch(incoming, {
            authInfo: {
              token: claims.token,
              clientId: claims.clientId,
              scopes: [...principal.scopes],
              expiresAt: claims.expiresAt,
              resource: new URL(claims.audience),
              extra: { subject: principal.subject, githubId: principal.githubId },
            },
          });
        } catch {
          return new Response("Forbidden", { status: 403 });
        }
      },
    },
    defaultHandler: {
      fetch: (incoming, currentEnv) => handleAuthorizationPage(incoming, currentEnv, origin),
    },
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/oauth/token",
    clientRegistrationEndpoint: "/oauth/register",
    scopesSupported:
      env.CLICKUP_COMPANY_READ_ONLY === "true" ? ["mcp:read"] : ["mcp:read", "mcp:write"],
    // Basic MCP operations need only read access. During OAuth consent the user
    // may separately opt in to write access even when the client asks only for
    // read. Mutation handlers still enforce mcp:write on every operation.
    requiredScopes: ["mcp:read"],
    resourceMetadata: {
      resource: origin + "/mcp",
      authorization_servers: [origin],
      resource_name: "ClickUp Serviteur MCP",
    },
    clientIdMetadataDocumentEnabled: true,
  });
  return provider.fetch(request, env, context);
}
