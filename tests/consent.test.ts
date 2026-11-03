import { describe, expect, it } from "vitest";
import { renderConsentPage, validatedReadOnlyScopes } from "../src/auth/consent.js";

describe("browser-bound OAuth consent UI", () => {
  it("escapes attacker-controlled client name, domain, scopes and handle", () => {
    const html = renderConsentPage(
      {
        clientName: "<img src=x onerror=alert(1)>",
        clientDomain: "evil.example<svg onload=alert(2)>",
        redirectHost: "localhost",
        redirectIsLoopback: true,
        scope: ['mcp:read"><script>alert(3)</script>'],
      },
      '" onfocus="alert(4)',
    );
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("evil.example<svg");
    expect(html).not.toContain("<script");
    expect(html).not.toContain('value="" onfocus');
    expect(html).toContain("localhost");
    expect(html).toContain("computer");
    expect(html).toContain('name="decision" value="deny"');
  });
});

describe("explicit optional write consent", () => {
  it("offers unchecked mcp:write even when ChatGPT requested only mcp:read", () => {
    const html = renderConsentPage(
      {
        clientName: "ChatGPT",
        clientDomain: "chatgpt.com",
        redirectHost: "chatgpt.com",
        redirectIsLoopback: false,
        scope: ["mcp:read"],
      },
      "browser-bound-handle",
    );
    expect(html).toContain('name="scope" type="checkbox" checked value="mcp:read"');
    expect(html).toContain('name="scope" type="checkbox" value="mcp:write"');
    expect(html).not.toContain('checked value="mcp:write"');
    expect(html).toContain("Optional: create, change and delete authorized ClickUp records");
    expect(html).toContain("Leave unchecked for read-only access.");
    // Merely rendering an extra checkbox must not elevate the submitted grant.
    expect(validatedReadOnlyScopes(["mcp:read"])).toEqual(["mcp:read"]);
    expect(validatedReadOnlyScopes(["mcp:read", "mcp:write"])).toEqual(["mcp:read", "mcp:write"]);
  });

  it("does not duplicate client-requested write scope", () => {
    const html = renderConsentPage(
      {
        clientName: "ChatGPT",
        clientDomain: "chatgpt.com",
        redirectHost: "chatgpt.com",
        redirectIsLoopback: false,
        scope: ["mcp:read", "mcp:write"],
      },
      "browser-bound-handle",
    );
    expect(html.match(/value="mcp:write"/g)).toHaveLength(1);
    expect(html).toContain('checked value="mcp:write"');
  });

  it("does not offer write to a client that has not requested read", () => {
    const html = renderConsentPage(
      {
        clientName: "Other",
        redirectHost: "localhost",
        redirectIsLoopback: true,
        scope: ["unexpected"],
      },
      "browser-bound-handle",
    );
    expect(html).not.toContain('value="mcp:write"');
  });
});

describe("professional consent page invariants", () => {
  it("renders a responsive self-contained page without scripts or third-party assets", () => {
    const html = renderConsentPage(
      {
        clientName: "Claude",
        clientDomain: "claude.ai",
        redirectHost: "claude.ai",
        redirectIsLoopback: false,
        scope: ["mcp:read"],
      },
      "opaque-consent-handle",
    );
    expect(html).toContain('<meta name="viewport"');
    expect(html).toContain("@media(max-width:520px)");
    expect(html).toContain('aria-labelledby="consent-heading"');
    expect(html).toContain('method="post" action="/authorize"');
    expect(html).toContain('name="handle" value="opaque-consent-handle"');
    expect(html).toContain('name="scope" type="checkbox" checked value="mcp:read"');
    expect(html).toContain('name="decision" value="approve"');
    expect(html).toContain('name="decision" value="deny"');
    expect(html).not.toContain("<script");
    expect(html).not.toContain('<link rel="stylesheet"');
    expect(html).not.toContain('src="http');
  });

  it("warns clearly for localhost redirects and unknown publishers", () => {
    const html = renderConsentPage(
      {
        clientName: "Self-claimed",
        redirectHost: "localhost",
        redirectIsLoopback: true,
        scope: ["mcp:read"],
      },
      "handle",
    );
    expect(html).toContain("name is self-declared");
    expect(html).toContain("an app on your computer");
  });
});

describe("branded consent identity diagram", () => {
  it("renders a self-contained Claude glyph and neutral Serviteur endpoint mark", () => {
    const html = renderConsentPage(
      {
        clientName: "Claude",
        clientDomain: "claude.ai",
        redirectHost: "claude.ai",
        redirectIsLoopback: false,
        scope: ["mcp:read"],
      },
      "browser-bound-handle",
    );
    expect(html).toContain('class="connection-flow"');
    expect(html).toContain('class="connection-arrows"');
    expect(html).toContain('class="connection-tile mcp"');
    expect(html).toContain('class="serviteur-mark"');
    expect(html).not.toContain('src="data:image/webp');
    expect(html).toContain('viewBox="0 0 256 257"');
    expect(html).toContain("ClickUp Serviteur MCP");
    expect(html).toContain("CLICKUP SERVITEUR");
    expect(html).not.toContain("Cryogenized MCP");
    expect(html).toContain("@media(max-width:520px)");
    expect(html).not.toContain('src="https://');
    expect(html).not.toContain("<script");
  });

  it("uses the ChatGPT knot only for the matching client identity tuple", () => {
    const html = renderConsentPage(
      {
        clientName: "ChatGPT",
        clientDomain: "chatgpt.com",
        redirectHost: "chatgpt.com",
        redirectIsLoopback: false,
        scope: ["mcp:read"],
      },
      "browser-bound-handle",
    );
    expect(html).toContain('data-client-brand="chatgpt"');
    expect(html).not.toContain('viewBox="0 0 256 257"');
    expect(html).not.toContain('src="https://');
    expect(html).not.toContain("<script");
  });

  it("falls back to a neutral glyph for unknown clients and spoofed known brands", () => {
    const identities = [
      { clientName: "ChatGPT", clientDomain: "evil.example", redirectHost: "chatgpt.com" },
      { clientName: "ChatGPT", clientDomain: "chatgpt.com", redirectHost: "evil.example" },
      { clientName: "Not ChatGPT", clientDomain: "chatgpt.com", redirectHost: "chatgpt.com" },
      { clientName: "Claude", clientDomain: "claude.ai", redirectHost: "evil.example" },
      { clientName: "Cursor", clientDomain: "cursor.com", redirectHost: "cursor.com" },
    ];
    for (const identity of identities) {
      const html = renderConsentPage(
        { ...identity, redirectIsLoopback: false, scope: ["mcp:read"] },
        "browser-bound-handle",
      );
      expect(html).toContain('viewBox="0 0 24 24"');
      expect(html).toContain('<rect x="4" y="4" width="16" height="16" rx="4"/>');
      expect(html).not.toContain('data-client-brand="chatgpt"');
      expect(html).not.toContain('viewBox="0 0 256 257"');
    }
  });

  it("never lends Claude branding to a spoofed or unrecognized client", () => {
    for (const client of [
      {
        clientName: "Claude",
        clientDomain: "claude.ai",
        redirectHost: "evil.example",
      },
      {
        clientName: "Other",
        clientDomain: "claude.ai",
        redirectHost: "claude.ai",
      },
      {
        clientName: "Claude",
        clientDomain: "evil.example",
        redirectHost: "claude.ai",
      },
    ]) {
      const html = renderConsentPage(
        { ...client, redirectIsLoopback: false, scope: ["mcp:read"] },
        "handle",
      );
      expect(html).not.toContain('viewBox="0 0 256 257"');
      expect(html).toContain('viewBox="0 0 24 24"');
      expect(html).toContain('name="decision" value="deny"');
    }
  });
});

describe("company read-only OAuth consent boundary", () => {
  it("does not offer, preselect or accept write permissions on the company profile", () => {
    const html = renderConsentPage(
      {
        clientName: "ChatGPT",
        clientDomain: "chatgpt.com",
        redirectHost: "chatgpt.com",
        redirectIsLoopback: false,
        scope: ["mcp:read", "mcp:write"],
      },
      "work-consent-handle",
      true,
    );
    expect(html).toContain("MCP · READ ONLY");
    expect(html).toContain("disabled by the server");
    expect(html).toContain("ClickUp Serviteur MCP");
    expect(html).not.toContain('value="mcp:write"');
    expect(html).not.toContain("NEONSALES");
    expect(validatedReadOnlyScopes(["mcp:read"], true)).toEqual(["mcp:read"]);
    expect(() => validatedReadOnlyScopes(["mcp:read", "mcp:write"], true)).toThrow();
  });
});

describe("read-only OAuth consent scope enforcement", () => {
  it.each([[["mcp:read", "offline_access"]], [["mcp:read", "mcp:read"]], [[""]], [[]]])(
    "rejects forged, duplicate and empty scopes: %j",
    (values) => {
      expect(() => validatedReadOnlyScopes(values)).toThrow();
    },
  );

  it("allows read-only and explicitly consented write scopes without duplicates", () => {
    expect(validatedReadOnlyScopes(["mcp:read"])).toEqual(["mcp:read"]);
    expect(validatedReadOnlyScopes(["mcp:write", "mcp:read"])).toEqual(["mcp:read", "mcp:write"]);
  });
});
