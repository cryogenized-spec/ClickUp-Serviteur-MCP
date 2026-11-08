export interface GitHubIdentity {
  readonly githubId: string;
}

interface GitHubExchange {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly code: string;
  readonly verifier: string;
  readonly callbackUrl: string;
}

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export async function pkceChallenge(verifier: string): Promise<string> {
  const bytes = new TextEncoder().encode(verifier);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  let binary = "";
  for (const byte of digest) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function githubAuthorizeUrl(
  clientId: string,
  state: string,
  codeChallenge: string,
  callbackUrl: string,
): URL {
  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", callbackUrl);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("scope", "read:user");
  url.searchParams.set("allow_signup", "false");
  return url;
}

export async function exchangeGithubIdentity(
  params: GitHubExchange,
  request: FetchLike = fetch,
): Promise<GitHubIdentity> {
  const { clientId, clientSecret, code, verifier, callbackUrl } = params;
  if (
    ![clientId, clientSecret, code, verifier].every(
      (part) => typeof part === "string" && part.length > 0,
    )
  ) {
    throw new Error("Missing upstream authorization inputs");
  }
  if (!callbackUrl.startsWith("https://") && !callbackUrl.startsWith("http://localhost:")) {
    throw new Error("Invalid callback URI");
  }
  const tokenResponse = await request("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: callbackUrl,
      code_verifier: verifier,
    }),
    signal: AbortSignal.timeout(10000),
  });
  if (!tokenResponse.ok) throw new Error("GitHub authorization exchange failed");
  const token: unknown = await tokenResponse.json();
  if (
    typeof token !== "object" ||
    token === null ||
    !("access_token" in token) ||
    typeof token.access_token !== "string" ||
    !token.access_token
  ) {
    throw new Error("GitHub did not provide a valid identity token");
  }
  const profileResponse = await request("https://api.github.com/user", {
    headers: {
      Authorization: "Bearer " + token.access_token,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "ClickUp-Serviteur-MCP",
    },
    signal: AbortSignal.timeout(10000),
  });
  if (!profileResponse.ok) throw new Error("GitHub identity validation failed");
  const profile: unknown = await profileResponse.json();
  if (
    typeof profile !== "object" ||
    profile === null ||
    !("id" in profile) ||
    typeof profile.id !== "number" ||
    !Number.isSafeInteger(profile.id) ||
    profile.id <= 0
  ) {
    throw new Error("GitHub returned a malformed user identity");
  }
  return { githubId: String(profile.id) };
}
