import { parseStaffAllowlist } from "../auth/staff.js";
import type { OAuthEnv } from "../auth/env.js";
import { receiveClickUpWebhook, type WebhookRegistration } from "./webhook-ingress.js";

interface EventBinding {
  idFromName(name: string): unknown;
  get(id: never): { fetch(request: Request): Promise<Response> };
}

/** Operator-provisioned secret JSON, not a user-supplied endpoint or signing key.
 * No webhook data is made available to MCP clients by this route.
 */
export async function handleClickUpWebhook(request: Request, env: OAuthEnv): Promise<Response> {
  const binding = env.CLICKUP_WEBHOOK_EVENTS as EventBinding | undefined;
  if (
    env.CLICKUP_WEBHOOK_ENABLED !== "true" ||
    !env.CLICKUP_WORKSPACE_ID ||
    !binding ||
    typeof binding.idFromName !== "function" ||
    typeof binding.get !== "function"
  )
    return new Response(null, { status: 404 });
  const workspaceId = env.CLICKUP_WORKSPACE_ID;
  const allowed = parseStaffAllowlist(env.ALLOWED_GITHUB_IDS);
  let registrations: unknown;
  try {
    registrations = JSON.parse(env.CLICKUP_WEBHOOK_REGISTRATIONS ?? "[]");
  } catch {
    return new Response(null, { status: 503 });
  }
  if (!Array.isArray(registrations) || registrations.length > 100)
    return new Response(null, { status: 503 });
  const configured = new Map<string, WebhookRegistration>();
  for (const item of registrations) {
    if (item === null || typeof item !== "object" || Array.isArray(item))
      return new Response(null, { status: 503 });
    const row = item as Record<string, unknown>;
    const webhookId = row["webhookId"];
    const subject = row["subject"];
    const secret = row["secret"];
    if (
      typeof webhookId !== "string" ||
      !/^[a-f0-9-]{36}$/i.test(webhookId) ||
      configured.has(webhookId) ||
      row["workspaceId"] !== workspaceId ||
      typeof subject !== "string" ||
      !subject.startsWith("github:") ||
      !allowed.has(subject.slice(7)) ||
      typeof secret !== "string" ||
      !secret ||
      secret.length > 512
    )
      return new Response(null, { status: 503 });
    configured.set(webhookId, { workspaceId, subject, secret });
  }
  return receiveClickUpWebhook(request, {
    resolve: async (id) => {
      const manual = configured.get(id);
      if (manual) return manual;
      const stub = binding.get(binding.idFromName("registry:" + workspaceId) as never);
      const response = await stub.fetch(
        new Request("https://internal/registry?webhook_id=" + encodeURIComponent(id)),
      );
      if (response.status === 404) return null;
      if (!response.ok) throw new Error("REGISTRY_UNAVAILABLE");
      const row = (await response.json()) as WebhookRegistration;
      if (
        row.workspaceId !== workspaceId ||
        typeof row.subject !== "string" ||
        !row.subject.startsWith("github:") ||
        !allowed.has(row.subject.slice(7)) ||
        typeof row.secret !== "string"
      )
        return null;
      return row;
    },
    persist: async (registration, hints) => {
      const key = registration.workspaceId + ":" + registration.subject;
      const stub = binding.get(binding.idFromName(key) as never);
      const result = await stub.fetch(
        new Request("https://internal/ingest", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            workspaceId: registration.workspaceId,
            subject: registration.subject,
            hints,
          }),
        }),
      );
      if (!result.ok) throw new Error("EVENT_STORAGE_FAILED");
    },
  });
}
