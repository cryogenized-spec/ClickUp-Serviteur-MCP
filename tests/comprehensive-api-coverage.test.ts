import { describe, expect, it, vi } from "vitest";
import { runCatalogOperation } from "../src/clickup/catalog-runtime.js";
import type { ReadGrant } from "../src/clickup/policy.js";

const grant: ReadGrant = {
  subject: "github:11",
  clickupUserId: "707",
  workspaceId: "555",
  listId: "12345",
  resourceScope: "workspace",
  apiToken: "test-token",
  quota: {
    idFromName: (name: string) => name,
    get: () => ({ fetch: async () => Response.json({ allowed: true }) }),
  },
};

const webhookId = "7689a169-a000-4985-8676-6902b96d6627";
const origin = "https://serviteur.example";
const endpoint = origin + "/clickup/webhook";

describe("comprehensive API expansion", () => {
  it("uses Workspace Custom Field metadata only in the bound Workspace", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe(
        "https://api.clickup.com/api/v2/team/555/field?include_applied_objects=true",
      );
      return Response.json({ fields: [{ id: "field-1", type: "text" }] });
    });
    await expect(
      runCatalogOperation("clickup_get_workspace_custom_fields", {}, grant, fetcher),
    ).resolves.toMatchObject({ fields: [{ id: "field-1" }], incomplete: false });
    await expect(
      runCatalogOperation(
        "clickup_get_workspace_custom_fields",
        { workspace_id: "999" },
        grant,
        fetcher,
      ),
    ).rejects.toThrow("CLICKUP_SCOPE_OR_SCHEMA_REJECTED");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("creates only a fixed-destination webhook and never returns its signing secret", async () => {
    const vault = vi.fn(async (request: Request) => {
      expect(new URL(request.url).searchParams.get("webhook_id")).toBe(webhookId);
      expect(await request.json()).toEqual({
        workspaceId: "555",
        subject: "github:11",
        secret: "private-test-secret",
      });
      return new Response(null, { status: 204 });
    });
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("https://api.clickup.com/api/v2/team/555/webhook");
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toEqual({
        endpoint,
        events: ["taskUpdated"],
      });
      return Response.json({
        id: webhookId,
        webhook: { id: webhookId, secret: "private-test-secret" },
      });
    });
    const g = {
      ...grant,
      webhookOrigin: origin,
      webhookEvents: { idFromName: (name: string) => name, get: () => ({ fetch: vault }) },
    };
    const args = { webhook_events: ["taskUpdated"] };
    await expect(
      runCatalogOperation("clickup_create_webhook_subscription", args, g, fetcher),
    ).rejects.toThrow("CLICKUP_INVALID_ARGUMENT");
    expect(fetcher).not.toHaveBeenCalled();
    const result = await runCatalogOperation(
      "clickup_create_webhook_subscription",
      { ...args, confirm_subscription: true },
      g,
      fetcher,
    );
    expect(result).toMatchObject({
      webhook_id: webhookId,
      registered: true,
      signing_secret_saved: true,
      delivery_verified: false,
    });
    expect(JSON.stringify(result)).not.toContain("private-test-secret");
    expect(vault).toHaveBeenCalledTimes(1);
  });

  it("rejects deletion of a subscription owned by a different Serviteur principal", async () => {
    const vault = vi.fn(async () =>
      Response.json({ workspaceId: "555", subject: "github:22", secret: "other" }),
    );
    const fetcher = vi.fn(async () => Response.json({}));
    await expect(
      runCatalogOperation(
        "clickup_delete_webhook_subscription",
        { webhook_id: webhookId, confirm_delete: true },
        {
          ...grant,
          webhookOrigin: origin,
          webhookEvents: { idFromName: (name: string) => name, get: () => ({ fetch: vault }) },
        },
        fetcher,
      ),
    ).rejects.toThrow("CLICKUP_SCOPE_OR_SCHEMA_REJECTED");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects another user's timer even if it is visible in the Workspace", async () => {
    const fetcher = vi.fn(async () =>
      Response.json({ data: { id: "987654", user: { id: "999" }, duration: "5000" } }),
    );
    await expect(
      runCatalogOperation(
        "clickup_update_own_time_entry",
        { timer_id: "987654", billable: true },
        grant,
        fetcher,
      ),
    ).rejects.toThrow("CLICKUP_SCOPE_OR_SCHEMA_REJECTED");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("rejects a saved view whose verified parent differs from the requested parent", async () => {
    const fetcher = vi.fn(async () =>
      Response.json({ view: { id: "view1", parent: { id: "999", type: 7 }, name: "Other" } }),
    );
    await expect(
      runCatalogOperation(
        "clickup_rename_saved_view",
        { view_id: "view1", view_parent_type: "workspace", view_parent_id: "555", name: "New" },
        grant,
        fetcher,
      ),
    ).rejects.toThrow("CLICKUP_SCOPE_OR_SCHEMA_REJECTED");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
