/** Verify the native ClickUp X-Signature against the unmodified request body.
 * The caller must retrieve the secret for the exact registered webhook from
 * protected storage. Do not log or expose the secret or raw event payload.
 */
export async function verifyClickUpWebhookSignature(
  body: Uint8Array,
  signature: string,
  secret: string,
): Promise<boolean> {
  if (!/^[0-9a-f]{64}$/i.test(signature) || !secret || body.byteLength > 1_000_000) return false;
  const signatureBytes = new Uint8Array(32);
  for (let i = 0; i < signatureBytes.length; i++)
    signatureBytes[i] = Number.parseInt(signature.slice(i * 2, i * 2 + 2), 16);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  return crypto.subtle.verify("HMAC", key, signatureBytes, new Uint8Array(body));
}
