import { chatGptGlyph, claudeGlyph } from "./brand-assets.js";

interface ConsentDisplay {
  readonly clientName: string;
  readonly clientDomain?: string | undefined;
  readonly redirectHost: string;
  readonly redirectIsLoopback: boolean;
  readonly scope: readonly string[];
}

/**
 * Client branding is presentation only, never an authentication decision.
 * Require an exact identity tuple: displaying a provider's mark based on
 * clientName alone would let a self-declared OAuth client impersonate it.
 * New clients can be registered here after their origins and assets are reviewed.
 */
const CLIENT_BRANDS: readonly {
  readonly name: string;
  readonly domain: string;
  readonly redirectHost: string;
  readonly glyph: string;
}[] = [
  { name: "Claude", domain: "claude.ai", redirectHost: "claude.ai", glyph: claudeGlyph },
  { name: "ChatGPT", domain: "chatgpt.com", redirectHost: "chatgpt.com", glyph: chatGptGlyph },
];

const genericClientGlyph =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="4"/><path d="M9 12h6M12 9v6"/></svg>';

function clientGlyphFor(details: ConsentDisplay): string {
  const known = CLIENT_BRANDS.find(
    (brand) =>
      details.clientName === brand.name &&
      details.clientDomain === brand.domain &&
      details.redirectHost === brand.redirectHost,
  );
  return known?.glyph ?? genericClientGlyph;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => "&#" + char.charCodeAt(0) + ";");
}

/** Browser binding, CSRF and frame headers are supplied by beginConsent(); this escapes the page. */
export function renderConsentPage(
  details: ConsentDisplay,
  handle: string,
  companyReadOnly = false,
  companyNonDestructive = false,
): string {
  const name = escapeHtml(details.clientName);
  const origin = details.clientDomain
    ? "Published by " + escapeHtml(details.clientDomain) + "."
    : "This application's name is self-declared and has not been independently verified.";
  // describeConsent() only lists scopes the CLIENT asked for. Some MCP clients
  // initiate a read-only grant even when the authorization server supports writes
  // and cannot launch a later step-up browser prompt. Cloudflare's approveConsent
  // explicitly permits the human to select additional *supported* scopes.
  // Offer write as an optional, UNCHECKED choice; never add it invisibly.
  const scopes = [
    ...details.scope
      .filter((scope) => !companyReadOnly || scope !== "mcp:write")
      .map(
        (scope) =>
          '<label><input name="scope" type="checkbox" checked value="' +
          escapeHtml(scope) +
          '"> ' +
          escapeHtml(scope) +
          "</label>",
      ),
    ...(!companyReadOnly &&
    details.scope.includes("mcp:read") &&
    !details.scope.includes("mcp:write")
      ? [
          `<label><input name="scope" type="checkbox" value="mcp:write"><span>mcp:write <span class="permission-hint">${companyNonDestructive ? "Optional: create and edit authorized ClickUp records only. Deletion and destructive actions are disabled by the server." : "Optional: create, change and delete authorized ClickUp records. Leave unchecked for read-only access."}</span></span></label>`,
        ]
      : []),
  ].join("\n");
  const clientGlyph = clientGlyphFor(details);
  const loopbackWarning = details.redirectIsLoopback
    ? '<div class="info warning"><strong>Local destination:</strong> This sends access to an app on your computer. Verify that you trust it.</div>'
    : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark">
<meta name="robots" content="noindex,nofollow">
<title>Review connection · ClickUp Serviteur</title>
<style>
:root{font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color-scheme:dark;font-synthesis:none;background:#080e1b;color:#f6f8ff}
*{box-sizing:border-box}
body{margin:0;min-height:100svh;background:radial-gradient(ellipse 85% 65% at 50% -18%,#1f3c6b 0%,transparent 72%),#080e1b;display:flex;flex-direction:column}
button,input{font:inherit}
.page{width:min(100% - 32px,550px);margin:0 auto}
.masthead{padding:32px 0 18px;display:flex;align-items:center;justify-content:space-between;gap:12px}
.brand{display:flex;align-items:center;gap:11px;text-decoration:none;color:#f9fbff;font-weight:800;letter-spacing:.09em;font-size:13px}
.brand-mark{width:36px;height:36px;display:grid;place-items:center;border-radius:11px;background:linear-gradient(145deg,#347af6,#1441a9);box-shadow:0 9px 30px #1a5ada44;font-weight:900;font-size:19px;letter-spacing:-.08em}
.environment{font-size:10px;font-weight:750;color:#a7b9d9;letter-spacing:.11em;text-transform:uppercase;border:1px solid #34435d;border-radius:99px;padding:7px 11px;white-space:nowrap}
main{flex:1;display:flex;align-items:center;padding:8px 0 32px}
.card{width:100%;background:linear-gradient(145deg,#17243b 0%,#101a2d 55%,#0f192a 100%);border:1px solid #30425f;border-radius:22px;padding:32px;box-shadow:0 28px 80px #0007,0 2px 10px #0004}
.eyebrow{display:flex;align-items:center;gap:8px;text-transform:uppercase;color:#a9c4ff;font-size:11px;font-weight:800;letter-spacing:.14em}
.eyebrow:before{content:"";width:7px;height:7px;border-radius:50%;background:#66d6b1;box-shadow:0 0 0 4px #66d6b11a}
.connection-flow{display:grid;grid-template-columns:minmax(0,1fr) 52px minmax(0,1fr);align-items:center;gap:9px;max-width:388px;margin:25px auto 20px}
.connection-endpoint{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:9px;min-width:0;color:#c3d1e8;font-size:12px;font-weight:650;text-align:center}
.connection-endpoint span{max-width:100%;overflow-wrap:anywhere}
.connection-tile{display:grid;place-items:center;width:92px;height:92px;border:1px solid #3a5277;border-radius:22px;background:#091428;box-shadow:0 12px 26px #0003}
.connection-tile svg{width:49px;height:49px;color:#f8fbff}
.connection-tile.mcp{background:radial-gradient(ellipse at center,#1a3e77 0%,#091428 74%)}
.serviteur-mark{font-size:46px;font-weight:900;letter-spacing:-.08em;color:#a8d0ff}
.connection-arrows{display:grid;place-items:center;color:#85b9ff;padding-bottom:24px}
.connection-arrows svg{width:35px;height:35px;overflow:visible}
.hero-icon{margin-top:25px;width:54px;height:54px;border-radius:16px;display:grid;place-items:center;background:#1a3561;border:1px solid #3b6096;color:#a8d0ff}
.hero-icon svg{width:27px;height:27px}
h1{font-size:clamp(26px,5vw,32px);line-height:1.16;letter-spacing:-.035em;margin:18px 0 9px;font-weight:760;overflow-wrap:anywhere}
.intro{margin:0 0 26px;color:#b9c6dc;font-size:14px;line-height:1.7}
.details{border:1px solid #354662;border-radius:15px;overflow:hidden;background:#0b1425}
.detail{padding:14px 17px;display:flex;justify-content:space-between;gap:16px;align-items:flex-start}
.detail+.detail{border-top:1px solid #283952}
.detail-title{color:#90a5c6;font-size:12px;min-width:95px}
.detail-value{font-size:13px;font-weight:650;text-align:right;overflow-wrap:anywhere;min-width:0}
.publisher{color:#b4c6e4;font-size:12px;margin:11px 2px 24px;line-height:1.5;overflow-wrap:anywhere}
.permissions-title{font-size:14px;margin:0 0 5px;font-weight:780}
.permissions-intro{font-size:12px;line-height:1.55;color:#a6b7d3;margin:0 0 12px}
.permission-list{display:grid;gap:9px;margin-bottom:22px}
.permission-list label{display:flex;gap:13px;align-items:center;padding:14px 15px;background:#111f36;border:1px solid #395273;border-radius:13px;color:#e7f0ff;overflow-wrap:anywhere;font-size:13px;font-weight:700;cursor:pointer}
.permission-list label:focus-within{outline:2px solid #83b9ff;outline-offset:2px}
.permission-list input{width:18px;height:18px;flex:0 0 auto;accent-color:#5298ff;cursor:pointer}
.permission-hint{display:block;color:#b3c8e6;font-size:11px;font-weight:450;line-height:1.55;margin-top:3px}
.info{padding:13px 14px;border-radius:12px;border:1px solid #37547b;background:#172d4b;color:#c7d8f2;line-height:1.55;font-size:12px;margin-bottom:22px}
.info strong{color:#f0f5ff}
.info.warning{border-color:#a17d45;background:#322719;color:#ffdfaf}
.actions{display:flex;flex-direction:column;gap:10px}
.actions button{width:100%;min-height:46px;border-radius:11px;border:1px solid transparent;font-weight:750;font-size:14px;cursor:pointer;transition:background .15s ease,border-color .15s ease}
.actions button:focus-visible{outline:3px solid #b1d4ff;outline-offset:3px}
.actions button[name=decision][value=approve]{background:#488ef5;color:#08162c}
.actions button[name=decision][value=approve]:hover{background:#77adff}
.actions button[name=decision][value=deny]{background:transparent;border-color:#41526c;color:#e2eafa}
.actions button[name=decision][value=deny]:hover{background:#24334c}
.disclaimer{border-top:1px solid #293b56;margin-top:25px;padding-top:17px;display:flex;gap:10px;align-items:flex-start;color:#92a5c4;font-size:11px;line-height:1.65}
.disclaimer svg{flex:none;margin-top:2px}
.footer{padding:0 0 24px;text-align:center;color:#7187a8;font-size:11px}
@media(max-width:520px){.masthead{padding:20px 0 12px}.card{padding:23px 19px;border-radius:17px}.detail{display:block}.detail-value{text-align:left;margin-top:5px}.detail-title{min-width:0}.hero-icon{margin-top:20px}.connection-flow{grid-template-columns:minmax(0,1fr) 38px minmax(0,1fr);gap:4px}.connection-tile{width:76px;height:76px;border-radius:18px}.serviteur-mark{font-size:38px}.connection-tile svg{width:42px;height:42px}.connection-arrows svg{width:28px;height:28px}.environment{font-size:9px}}
@media(prefers-reduced-motion:reduce){.actions button{transition:none}}
</style>
</head>
<body>
<header class="page masthead">
<div class="brand"><span class="brand-mark" aria-hidden="true">S</span><span>CLICKUP SERVITEUR</span></div>
<span class="environment">MCP · ${companyReadOnly ? "READ ONLY" : companyNonDestructive ? "READ / WRITE" : "STAGING"}</span>
</header>
<main class="page">
<section class="card" aria-labelledby="consent-heading">
<div class="eyebrow">Secure authorization</div>
<div class="connection-flow" role="group" aria-label="Client application connects to ClickUp Serviteur MCP">
<div class="connection-endpoint"><div class="connection-tile" aria-hidden="true">${clientGlyph}</div><span>${name}</span></div>
<div class="connection-arrows" aria-hidden="true"><svg viewBox="0 0 36 36" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 13h25m0 0-7-7m7 7-7 7M31 24H6m0 0 7-7m-7 7 7 7"/></svg></div>
<div class="connection-endpoint"><div class="connection-tile mcp"><span class="serviteur-mark" aria-hidden="true">S</span></div><span>ClickUp Serviteur MCP</span></div>
</div>
<h1 id="consent-heading">Allow ${name} to connect?</h1>
<p class="intro">Review the application, destination, and requested permission before continuing.</p>
<div class="details">
<div class="detail"><span class="detail-title">Application</span><span class="detail-value">${name}</span></div>
<div class="detail"><span class="detail-title">Access returned to</span><span class="detail-value">${escapeHtml(details.redirectHost)}</span></div>
</div>
<p class="publisher">${origin}</p>
${loopbackWarning}
<h2 class="permissions-title" id="permissions-heading">Requested permission</h2>
<p class="permissions-intro">${companyReadOnly ? "This connection is read-only. Creating, changing and deleting ClickUp records is disabled by the server." : companyNonDestructive ? "This work connection permits explicitly approved creation and edits within your authorized scope. Deletion, removal, moves and other destructive actions are blocked by the server. Optional write permission is not enabled without your consent." : "Review the permission requested by your client. Optional write access is not enabled unless you explicitly check it. Per-tool approvals are handled by your client."}</p>
<form method="post" action="/authorize" aria-labelledby="permissions-heading">
<input type="hidden" name="handle" value="${escapeHtml(handle)}">
<div class="permission-list">${scopes}</div>
<div class="info"><strong>Before you allow:</strong> Only approve if you started this connection. Authorization is tied to this browser session.</div>
<div class="actions">
<button type="submit" name="decision" value="approve">Allow connection</button>
<button type="submit" name="decision" value="deny">Deny request</button>
</div>
</form>
<div class="disclaimer"><svg aria-hidden="true" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 7.5v.5"/></svg><span>Authorization grants access to the capabilities shown above. Never approve a request you do not recognize.</span></div>
</section>
</main>
<footer class="footer page">ClickUp Serviteur MCP · ${companyReadOnly ? "Read-only work connection" : companyNonDestructive ? "Non-destructive work connection" : "Secure staging environment"}</footer>
</body>
</html>`;
}

/** MCP OAuth distinguishes reads from mutations, without duplicating client-side tool approval. */
export function validatedReadOnlyScopes(
  submitted: readonly string[],
  companyReadOnly = false,
): string[] {
  if (
    !submitted.includes("mcp:read") ||
    submitted.length < 1 ||
    submitted.length > 2 ||
    new Set(submitted).size !== submitted.length ||
    submitted.some((scope) => scope !== "mcp:read" && scope !== "mcp:write") ||
    (companyReadOnly && submitted.includes("mcp:write"))
  ) {
    throw new Error("Invalid MCP consent scope");
  }
  return submitted.includes("mcp:write") ? ["mcp:read", "mcp:write"] : ["mcp:read"];
}
