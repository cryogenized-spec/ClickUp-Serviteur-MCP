import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  StagingPerimeterFailure,
  probeStagingPublicOAuth,
  stagingOrigin,
} from "../staging-public-oauth-probe.mjs";

import { missingStagingOAuthBindings, stagingOAuthPreflight } from "../staging-oauth-preflight.mjs";

const ORIGIN = "https://clickup-serviteur-staging.cryogenized.workers.dev";
const META = ORIGIN + "/.well-known/oauth-protected-resource/mcp";
const AUTH = ORIGIN + "/.well-known/oauth-authorization-server";

function goodFetch() {
  const urls = [];
  const fetcher = async (url, init) => {
    urls.push({ url: String(url), init });
    if (url === ORIGIN + "/mcp") return new Response("", {
      status: 401,
      headers: {
        "WWW-Authenticate": 'Bearer realm="mcp", resource_metadata="' + META + '", scope="mcp:read"',
      },
    });
    if (url === META) return Response.json({
      resource: ORIGIN + "/mcp",
      scopes_supported: ["mcp:read"],
      authorization_servers: [ORIGIN],
    });
    if (url === AUTH) return Response.json({
      issuer: ORIGIN,
      scopes_supported: ["mcp:read", "mcp:write"],
    });
    throw new Error("unexpected read path: " + url);
  };
  return { fetcher, urls };
}

const assertStage = async (promise, stage) =>
  assert.rejects(
    promise,
    (e) => e instanceof StagingPerimeterFailure && e.stage === stage,
  );

describe("staging public OAuth perimeter smoke (no token or MCP connection)", () => {
  it("accepts only the owner-controlled staging origin", () => {
    assert.equal(stagingOrigin(), ORIGIN);
    for (const origin of [
      "https://clickup-serviteur-company.cryogenized.workers.dev",
      "https://clickup-serviteur-staging.other.workers.dev",
      "https://clickup-serviteur-staging.cryogenized.workers.dev:8443",
      "http://clickup-serviteur-staging.cryogenized.workers.dev",
      "https://clickup-serviteur-staging.cryogenized.workers.dev/mcp",
      "https://clickup-serviteur-staging.cryogenized.workers.dev/?token=abc",
      "https://clickup-serviteur-staging.cryogenized.workers.dev@malicious.example",
    ]) {
      assert.throws(() => stagingOrigin(origin), StagingPerimeterFailure);
    }
  });

  it("verifies live OAuth boundary using exactly three unauthenticated GETs", async () => {
    const { fetcher, urls } = goodFetch();
    assert.equal(await probeStagingPublicOAuth(fetcher), true);
    assert.deepEqual(urls.map((call) => call.url), [ORIGIN + "/mcp", META, AUTH]);
    for (const call of urls) {
      assert.equal(call.init.method, "GET");
      assert.equal(call.init.redirect, "manual");
      assert.equal(call.init.headers.Authorization, undefined);
      assert.equal(call.init.headers.Accept, "application/json");
    }
  });

  it("refuses unauthenticated success, denial, outage or redirect instead of trusting /mcp", async () => {
    for (const status of [200, 302, 403, 404, 429, 503]) {
      const fetcher = async () => new Response("", { status });
      await assertStage(probeStagingPublicOAuth(fetcher), "challenge");
    }
  });

  it("rejects missing bearer challenge or required read scope", async () => {
    for (const header of ["", 'Basic realm="test"', 'Bearer scope="mcp:write"']) {
      const fetcher = async () =>
        new Response("", { status: 401, headers: { "WWW-Authenticate": header } });
      await assertStage(probeStagingPublicOAuth(fetcher), "challenge");
    }
  });

  it("refuses foreign, non-TLS and malformed OAuth metadata URLs before fetching them", async () => {
    const attempts = [
      "https://clickup-serviteur-company.cryogenized.workers.dev/.well-known/oauth-protected-resource/mcp",
      "https://clickup-serviteur-staging.other.workers.dev/.well-known/oauth-protected-resource/mcp",
      "http://clickup-serviteur-staging.cryogenized.workers.dev/.well-known/oauth-protected-resource/mcp",
      ORIGIN + "/private/data",
      ORIGIN + "/.well-known/oauth-protected-resource/mcp?token=abc",
    ];
    for (const address of attempts) {
      const urls = [];
      const fetcher = async (url) => {
        urls.push(url);
        return new Response("", {
          status: 401,
          headers: {
            "WWW-Authenticate": 'Bearer resource_metadata="' + address + '", scope="mcp:read"',
          },
        });
      };
      await assertStage(probeStagingPublicOAuth(fetcher), "metadata_origin");
      assert.deepEqual(urls, [ORIGIN + "/mcp"]);
    }
  });

  it("rejects mismatched resource/issuer and missing required metadata", async () => {
    for (const change of [
      { resource: ORIGIN + "/wrong" },
      { authorization_servers: ["https://evil.example"] },
      { scopes_supported: [] },
    ]) {
      const { fetcher } = goodFetch();
      const modified = async (url, init) => {
        if (url === META) return Response.json({
          resource: ORIGIN + "/mcp", authorization_servers: [ORIGIN],
          scopes_supported: ["mcp:read"], ...change,
        });
        return fetcher(url, init);
      };
      await assertStage(probeStagingPublicOAuth(modified), "resource_metadata");
    }
    const { fetcher } = goodFetch();
    const wrongIssuer = (url, init) =>
      url === AUTH ? Promise.resolve(Response.json({ issuer: "https://evil.example", scopes_supported: ["mcp:read"] })) : fetcher(url, init);
    await assertStage(probeStagingPublicOAuth(wrongIssuer), "authorization_metadata");
  });

  it("rejects oversized metadata, missing data and JSON parse errors", async () => {
    const { fetcher } = goodFetch();
    const oversized = (url, init) =>
      url === META ? Promise.resolve(new Response("x", {
        headers: { "Content-Length": "32769" },
      })) : fetcher(url, init);
    await assertStage(probeStagingPublicOAuth(oversized), "resource_metadata");

    const malformed = (url, init) =>
      url === META ? Promise.resolve(new Response("{invalid json")) : fetcher(url, init);
    await assertStage(probeStagingPublicOAuth(malformed), "resource_metadata");
  });

  it("keeps transport failures generic without exposing remote exception contents", async () => {
    const fail = async () => { throw new Error("private secret or credentials"); };
    await assertStage(probeStagingPublicOAuth(fail), "challenge");
  });
});

describe("staging OAuth deployment preflight", () => {
  const configured = [
    { name: "ALLOWED_GITHUB_IDS", type: "plain_text", text: "11, 22" },
    { name: "GITHUB_CLIENT_ID", type: "plain_text", text: "synthetic-client-id" },
    { name: "GITHUB_CLIENT_SECRET", type: "secret_text" },
  ];

  it("rejects the actual missing staging configuration before deployment", () => {
    assert.deepEqual(missingStagingOAuthBindings([]), [
      "ALLOWED_GITHUB_IDS", "GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET",
    ]);
    assert.deepEqual(missingStagingOAuthBindings(configured.slice(0, 1)), [
      "GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET",
    ]);
  });

  it("accepts isolated configured credentials without reading secret values", () => {
    assert.deepEqual(missingStagingOAuthBindings(configured), []);
    assert.deepEqual(missingStagingOAuthBindings([
      ...configured.slice(0, 2),
      { name: "GITHUB_CLIENT_SECRET", type: "plain_text", text: "not-a-secret-binding" },
    ]), ["GITHUB_CLIENT_SECRET"]);
    for (const text of ["11,11", "9007199254740992", "0"]) {
      assert.deepEqual(missingStagingOAuthBindings([
        { ...configured[0], text }, ...configured.slice(1),
      ]), ["ALLOWED_GITHUB_IDS"]);
    }
  });

  it("reads only staging settings and never follows redirects", async () => {
    const account = "a".repeat(32);
    const calls = [];
    const fetcher = async (url, init) => {
      calls.push({ url, init });
      return Response.json({ success: true, result: { bindings: configured } });
    };
    assert.deepEqual(await stagingOAuthPreflight(fetcher, account, "synthetic-token"), []);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://api.cloudflare.com/client/v4/accounts/" + account +
      "/workers/scripts/clickup-serviteur-staging/settings");
    assert.equal(calls[0].init.method, "GET");
    assert.equal(calls[0].init.redirect, "error");
  });

  it("reports generic errors for unavailable settings, without leaking response details", async () => {
    await assert.rejects(
      stagingOAuthPreflight(async () => { throw new Error("synthetic private value"); }, "a".repeat(32), "synthetic-token"),
      { message: "STAGING_BINDINGS_UNAVAILABLE" },
    );
    await assert.rejects(
      stagingOAuthPreflight(async () => Response.json({ success: false }), "a".repeat(32), "synthetic-token"),
      { message: "STAGING_BINDINGS_UNAVAILABLE" },
    );
  });
});
