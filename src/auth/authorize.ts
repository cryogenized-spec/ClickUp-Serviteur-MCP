import {
  AuthorizationError,
  CimdFetchError,
  authorizationErrorRedirect,
  type OAuthHelpers,
} from "@cloudflare/workers-oauth-provider";
import { renderConsentPage, validatedReadOnlyScopes } from "./consent.js";
import { exchangeGithubIdentity, githubAuthorizeUrl, pkceChallenge } from "./github.js";
import { oauthUserIdForGitHub, parseStaffAllowlist, requireActivePrincipal } from "./staff.js";
import type { OAuthEnv } from "./env.js";

async function showConsent(
  request: Request,
  oauth: OAuthHelpers,
  env: OAuthEnv,
): Promise<Response> {
  const authorization = await oauth.parseAuthRequest(request);
  const details = await oauth.describeConsent(authorization);
  const consent = await oauth.beginConsent(authorization);
  consent.headers.set("Content-Type", "text/html; charset=utf-8");
  consent.headers.set("Cache-Control", "no-store");
  return new Response(
    renderConsentPage(details, consent.handle, env.CLICKUP_COMPANY_READ_ONLY === "true"),
    { headers: consent.headers },
  );
}

async function submitConsent(
  request: Request,
  oauth: OAuthHelpers,
  env: OAuthEnv,
  origin: string,
): Promise<Response> {
  const form = await request.formData();
  const handle = form.get("handle");
  if (typeof handle !== "string" || !handle)
    return new Response("Invalid consent request", { status: 400 });
  if (form.get("decision") !== "approve") {
    const denied = await oauth.denyConsent(request, handle);
    return new Response(null, { status: 302, headers: denied.headers });
  }
  let approvedScopes: string[];
  try {
    approvedScopes = validatedReadOnlyScopes(
      form.getAll("scope").map(String),
      env.CLICKUP_COMPANY_READ_ONLY === "true",
    );
  } catch {
    return new Response("Invalid consent scope", {
      status: 400,
      headers: { "Cache-Control": "no-store" },
    });
  }
  const approved = await oauth.approveConsent(request, handle, { scope: approvedScopes });
  const verifier = crypto.randomUUID() + crypto.randomUUID();
  const upstream = await oauth.beginUpstream(approved.request, {
    data: { verifier },
    headers: approved.headers,
  });
  upstream.headers.set(
    "Location",
    githubAuthorizeUrl(
      env.GITHUB_CLIENT_ID,
      upstream.state,
      await pkceChallenge(verifier),
      origin + "/github/callback",
    ).toString(),
  );
  return new Response(null, { status: 302, headers: upstream.headers });
}

async function finishGitHub(
  request: Request,
  oauth: OAuthHelpers,
  env: OAuthEnv,
  origin: string,
): Promise<Response> {
  const upstream = await oauth.finishUpstream<{ verifier: string }>(request);
  const query = new URL(request.url).searchParams;
  if (query.has("error")) {
    upstream.headers.set("Location", authorizationErrorRedirect(upstream.request, "access_denied"));
    return new Response(null, { status: 302, headers: upstream.headers });
  }
  const code = query.get("code");
  if (!code || !upstream.data || typeof upstream.data.verifier !== "string") {
    return new Response("Upstream identity could not be verified", { status: 400 });
  }
  const identity = await exchangeGithubIdentity({
    clientId: env.GITHUB_CLIENT_ID,
    clientSecret: env.GITHUB_CLIENT_SECRET,
    code,
    verifier: upstream.data.verifier,
    callbackUrl: origin + "/github/callback",
  });
  const subject = "github:" + identity.githubId;
  const oauthUserId = oauthUserIdForGitHub(identity.githubId);
  if (!parseStaffAllowlist(env.ALLOWED_GITHUB_IDS).has(identity.githubId)) {
    upstream.headers.set("Location", authorizationErrorRedirect(upstream.request, "access_denied"));
    return new Response(null, { status: 302, headers: upstream.headers });
  }
  // Check the exact subject before storing the grant. No GitHub access token is persisted.
  const consentedScopes = validatedReadOnlyScopes(
    upstream.request.scope,
    env.CLICKUP_COMPANY_READ_ONLY === "true",
  );
  requireActivePrincipal({ userId: subject }, oauthUserId, consentedScopes, env.ALLOWED_GITHUB_IDS);
  const completed = await oauth.completeAuthorization({
    request: upstream.request,
    userId: oauthUserId,
    metadata: {},
    scope: consentedScopes,
    props: { userId: subject },
  });
  upstream.headers.set("Location", completed.redirectTo);
  return new Response(null, { status: 302, headers: upstream.headers });
}

export async function handleAuthorizationPage(
  request: Request,
  env: OAuthEnv,
  origin: string,
): Promise<Response> {
  const path = new URL(request.url).pathname;
  if (path !== "/authorize" && path !== "/github/callback") {
    return new Response(null, { status: 404, headers: { "Cache-Control": "no-store" } });
  }
  try {
    if (path === "/github/callback") {
      if (request.method !== "GET") return new Response(null, { status: 405 });
      return await finishGitHub(request, env.OAUTH_PROVIDER, env, origin);
    }
    if (request.method === "GET") return await showConsent(request, env.OAUTH_PROVIDER, env);
    if (request.method === "POST")
      return await submitConsent(request, env.OAUTH_PROVIDER, env, origin);
    return new Response(null, { status: 405 });
  } catch (error) {
    if (error instanceof AuthorizationError) {
      if (error.redirectTo) return Response.redirect(error.redirectTo, 302);
      return new Response("Authorization request rejected", { status: 400 });
    }
    if (error instanceof CimdFetchError) {
      return new Response("OAuth client identity could not be verified", { status: 400 });
    }
    return new Response("Identity provider temporarily unavailable", {
      status: 503,
      headers: { "Cache-Control": "no-store" },
    });
  }
}
