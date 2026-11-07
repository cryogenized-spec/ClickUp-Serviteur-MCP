/**
 * Real workerd/Miniflare HTTPS smoke test using only isolated local KV and
 * nonfunctional GitHub OAuth placeholders. No live OAuth, Cloudflare or ClickUp.
 * Invoked from strict CI after npm ci and Wrangler dry-run.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const root = process.cwd();
const temporary = await mkdtemp(path.join(os.tmpdir(), "Serviteur-workerd-smoke-"));
const configPath = path.join(root, `.workerd-smoke-${process.pid}.json`);
const originIp = "127.0.0.1";
const timeLimit = 75_000;
let child;
let output = "";
let configCreated = false;
let trustedLocalCertificate;

async function openPort() {
  const server = net.createServer();
  server.listen(0, originIp);
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

async function request(port, endpoint, { method = "GET", headers = {} } = {}) {
  assert(trustedLocalCertificate, "Local TLS trust must be initialized before requests");
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: originIp,
        port,
        path: endpoint,
        method,
        headers,
        // Trust only the fresh, generated localhost certificate. TLS verification stays enabled.
        ca: trustedLocalCertificate,
        timeout: 2500,
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (part) => { data += part; });
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
      },
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("local request timed out")));
    req.end();
  });
}

async function waitUntilListening(port) {
  const deadline = Date.now() + timeLimit;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error("workerd exited before binding HTTPS listener");
    }
    try { return await request(port, "/mcp"); } catch {
      await new Promise((resolve) => setTimeout(resolve, 350));
    }
  }
  throw new Error("workerd HTTPS listener did not start within 75 seconds");
}

async function stop() {
  if (!child) return;
  const proc = child;
  child = undefined;
  if (proc.exitCode === null && proc.signalCode === null) {
    proc.kill("SIGTERM");
    await Promise.race([
      once(proc, "exit"),
      new Promise((resolve) => setTimeout(resolve, 4500)),
    ]);
    if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
  }
}

async function runWorker(port, certPath, keyPath, withKv) {
  const origin = `https://${originIp}:${port}`;
  const cfg = {
    name: "clickup-serviteur-mcp-local-security-test",
    main: path.resolve(root, "src/index.ts"),
    compatibility_date: "2026-10-10",
    compatibility_flags: ["global_fetch_strictly_public"],
    workers_dev: false,
    ...(withKv ? { kv_namespaces: [{ binding: "OAUTH_KV", id: "00000000000000000000000000000001" }] } : {}),
    vars: {
      MCP_PUBLIC_ORIGIN: origin,
      ALLOWED_GITHUB_IDS: "11,22,33,44",
      GITHUB_CLIENT_ID: "local-no-real-github-client",
      GITHUB_CLIENT_SECRET: "local-no-real-github-secret",
    },
  };
  await writeFile(configPath, JSON.stringify(cfg));
  configCreated = true;
  child = spawn(
    path.join(root, "node_modules/.bin/wrangler"),
    ["dev", "--config", configPath, "--local", "--ip", originIp, "--port", String(port),
      "--local-protocol=https", "--https-cert-path", certPath, "--https-key-path", keyPath,
      "--persist-to", path.join(temporary, "kv")],
    { cwd: root, env: { ...process.env, CI: "true", WRANGLER_SEND_METRICS: "false", BROWSER: "none" }, stdio: ["ignore", "pipe", "pipe"] },
  );
  for (const stream of [child.stdout, child.stderr]) {
    stream.on("data", (chunk) => { output = (output + String(chunk)).slice(-20000); });
  }
  const ready = await waitUntilListening(port);
  return { origin, ready };
}

try {
  const key = path.join(temporary, "localhost.key");
  const cert = path.join(temporary, "localhost.crt");
  const openssl = spawnSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes",
    "-keyout", key, "-out", cert, "-days", "1", "-subj", "/CN=localhost",
    "-addext", "subjectAltName=IP:127.0.0.1",
  ], { stdio: "pipe" });
  assert.equal(openssl.status, 0, "local OpenSSL certificate generation failed");
  trustedLocalCertificate = await readFile(cert);

  const absentPort = await openPort();
  const withoutBinding = await runWorker(absentPort, cert, key, false);
  assert.equal(withoutBinding.ready.status, 503, "Worker must fail closed without KV binding");
  assert.deepEqual(JSON.parse(withoutBinding.ready.body), { code: "AUTH_NOT_CONFIGURED" });
  console.log("PASS local workerd: missing KV binding returns 503");
  await stop();

  const port = await openPort();
  const { origin, ready } = await runWorker(port, cert, key, true);
  assert.equal(ready.status, 401, `expected OAuth challenge, received ${ready.status}: ${ready.body.slice(0,250)}`);
  const challenge = String(ready.headers["www-authenticate"] ?? "");
  assert.match(challenge, /^Bearer /i, "missing standard OAuth bearer challenge");
  assert.match(challenge, /resource_metadata=/i, "missing RFC 9728 discovery challenge");

  const metadataAddress = /resource_metadata="([^"]+)"/i.exec(challenge)?.[1];
  assert(metadataAddress, "challenge has no protected resource metadata URL");
  const metadataUrl = new URL(metadataAddress);
  assert.equal(metadataUrl.origin, origin, "challenge metadata must be same-origin");
  const metadataResponse = await request(port, metadataUrl.pathname + metadataUrl.search);
  assert.equal(metadataResponse.status, 200, "resource metadata must be discoverable");
  const metadata = JSON.parse(metadataResponse.body);
  assert.equal(metadata.resource, origin + "/mcp");
  // Baseline read scope remains least privilege; the consent page independently
  // offers explicit, unchecked write permission if the client requests only read.
  assert.deepEqual(metadata.scopes_supported, ["mcp:read"]);
  assert.match(challenge, /scope="mcp:read"/, "first-time OAuth challenge needs read scope");
  assert.deepEqual(metadata.authorization_servers, [origin]);
  console.log("PASS local workerd: unauthenticated /mcp returns 401 and discoverable RFC 9728 metadata");

  const authMetadata = await request(port, "/.well-known/oauth-authorization-server");
  assert.equal(authMetadata.status, 200, "authorization server metadata must be discoverable");
  const advertised = JSON.parse(authMetadata.body);
  assert.equal(advertised.issuer, origin);
  assert.deepEqual(advertised.scopes_supported, ["mcp:read", "mcp:write"]);
  console.log("PASS local workerd: issuer and supported scopes match protected resource");

  const spoofed = await request(port, "/mcp", { method: "POST", headers: {
    "Authorization": "Bearer this-is-not-an-access-token",
    "X-User": "github:11",
    "X-Forwarded-Host": "attacker.invalid",
  } });
  assert.equal(spoofed.status, 401, "forged bearer/header must not be accepted");
  console.log("PASS local workerd: forged bearer and user/host headers are rejected");

  const bypass = await request(port, "/mcp?debug=true", { headers: { "X-User": "github:11" } });
  assert.equal(bypass.status, 401, "query-based bypass must not disclose MCP tools");
  console.log("PASS local workerd: query-string bypass attempt still requires OAuth");
  await stop();
  console.log("PASS all actual workerd local security smoke tests (NO live sign-in claim)");
} catch (error) {
  console.error("FAIL workerd local security smoke:", error);
  console.error(output.slice(-9000));
  process.exitCode = 1;
} finally {
  await stop();
  if (configCreated) await rm(configPath, { force: true });
  await rm(temporary, { recursive: true, force: true });
}
