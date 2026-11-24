import { describe, expect, it, vi } from "vitest";
import { receiveClickUpWebhook } from "../src/clickup/webhook-ingress.js";

const webhookId = "7689a169-a000-4985-8676-6902b96d6627";
const registration = { workspaceId: "555", subject: "github:11", secret: "test-secret" };
const body = JSON.stringify({
  webhook_id: webhookId,
  event: "taskCommentPosted",
  task_id: "abc123",
  history_items: [{ id: "history1", comment: { text: "private comment" } }],
});

async function signedRequest(content: string, secret = registration.secret): Promise<Request> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(content));
  const signature = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join(
    "",
  );
  return new Request("https://example.test/clickup/webhook", {
    method: "POST",
    headers: { "X-Signature": signature },
    body: content,
  });
}

describe("ClickUp webhook ingress", () => {
  it("persists only minimal actor-scoped change hints with stable replay keys", async () => {
    const persist = vi.fn(async () => {});
    const deps = { resolve: async () => registration, persist };
    for (const now of [1000, 2000]) {
      const result = await receiveClickUpWebhook(await signedRequest(body), deps, now);
      expect(result.status).toBe(204);
    }
    expect(persist).toHaveBeenNthCalledWith(1, registration, [
      { key: webhookId + ":history1", taskId: "abc123", event: "taskCommentPosted", receivedAt: 1000 },
    ]);
    expect(persist).toHaveBeenNthCalledWith(2, registration, [
      { key: webhookId + ":history1", taskId: "abc123", event: "taskCommentPosted", receivedAt: 2000 },
    ]);
    expect(JSON.stringify(persist.mock.calls)).not.toContain("private comment");
  });

  it("rejects unknown registrations and invalid signatures before persistence", async () => {
    const persist = vi.fn(async () => {});
    const unknown = await receiveClickUpWebhook(await signedRequest(body), {
      resolve: async () => null,
      persist,
    });
    const invalid = await receiveClickUpWebhook(await signedRequest(body, "wrong"), {
      resolve: async () => registration,
      persist,
    });
    expect(unknown.status).toBe(401);
    expect(invalid.status).toBe(401);
    expect(persist).not.toHaveBeenCalled();
  });

  it("returns a retryable failure rather than acknowledging lost events", async () => {
    const result = await receiveClickUpWebhook(await signedRequest(body), {
      resolve: async () => registration,
      persist: async () => {
        throw Error("storage offline");
      },
    });
    expect(result.status).toBe(503);
  });
});
