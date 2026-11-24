import type { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { configurationUnavailable, validatedOAuthOrigin, type OAuthEnv } from "./auth/env.js";

/** No query/header/test escape hatch can expose MCP without full OAuth configuration. */
export default {
  async fetch(
    request: Request,
    env?: OAuthEnv,
    context?: Parameters<OAuthProvider<OAuthEnv>["fetch"]>[2],
  ): Promise<Response> {
    const origin = validatedOAuthOrigin(env, request);
    if (!origin || !env || !context) {
      if (new URL(request.url).pathname === "/mcp") return configurationUnavailable();
      return new Response(null, {
        status: 404,
        headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
      });
    }
    if (new URL(request.url).pathname === "/clickup/webhook") {
      const { handleClickUpWebhook } = await import("./clickup/webhook-route.js");
      return handleClickUpWebhook(request, env);
    }
    if (new URL(request.url).pathname === "/clickup/callback") {
      const { finishClickUpOAuth } = await import("./clickup/per-user-oauth.js");
      return finishClickUpOAuth(request, env);
    }
    const { handleOAuthRequest } = await import("./auth/oauth-runtime.js");
    return handleOAuthRequest(request, env, context, origin);
  },
};

export { ClickUpQuota } from "./clickup/quota-object.js";
export { ClickUpUserConnection } from "./clickup/user-connection.js";

export { ClickUpWebhookEvents } from "./clickup/webhook-event-store.js";
