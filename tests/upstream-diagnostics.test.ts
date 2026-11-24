import { describe, expect, it } from "vitest";
import { apiDiagnostic, authorizationDiagnostic, ReadFailure } from "../src/clickup/policy.js";
import { toolError } from "../src/mcp/create-server.js";

describe("sanitized upstream HTTP diagnostics", () => {
  it.each([401, 403, 404, 429, 503])("retains HTTP %i for reads", (status) => {
    expect(apiDiagnostic("GET", status)).toEqual({
      endpoint_category: "clickup_api_read",
      http_status: status,
    });
  });

  it.each([401, 403, 404, 429])("classifies rejected writes at HTTP %i", (status) => {
    expect(apiDiagnostic("POST", status)).toMatchObject({
      endpoint_category: "clickup_api_write",
      http_status: status,
      write_outcome: "rejected",
    });
  });

  it.each([408, 425, 500, 503])("preserves uncertain write classification at HTTP %i", (status) => {
    expect(apiDiagnostic("POST", status)).toMatchObject({ write_outcome: "unknown" });
  });

  it("identifies the exact denied resource and exposes only a documented code", async () => {
    const response = Response.json(
      { ECODE: "OAUTH_027", err: "private data that must not escape" },
      { status: 401 },
    );
    const diagnostic = await authorizationDiagnostic("GET", response, "api/v2/list/12345");
    expect(diagnostic).toEqual({
      endpoint_category: "clickup_api_read",
      http_status: 401,
      authorization_target: "list",
      upstream_ecode: "OAUTH_027",
    });
    const error = toolError(new ReadFailure("CLICKUP_UPSTREAM_DENIED", diagnostic));
    expect(error.content[0]?.text).not.toContain("private data");
    expect(error.content[0]?.text).not.toContain("12345");
    expect(error.content[0]?.text).toContain("OAUTH_027");
  });

  it("rejects arbitrary codes, malformed JSON and oversized error responses", async () => {
    for (const response of [
      Response.json({ ECODE: "PRIVATE_SECRET" }, { status: 401 }),
      new Response("invalid JSON", { status: 401 }),
      Response.json({ ECODE: "OAUTH_027", err: "x".repeat(3000) }, { status: 401 }),
    ]) {
      expect(await authorizationDiagnostic("GET", response, "task/abc123")).toEqual({
        endpoint_category: "clickup_api_read",
        http_status: 401,
        authorization_target: "task",
      });
    }
  });

  it("serializes only local diagnostic fields, not the error message", () => {
    const error = new ReadFailure("CLICKUP_UPSTREAM_DENIED", apiDiagnostic("GET", 403));
    error.message = "private upstream error";
    expect(toolError(error)).toEqual({
      isError: true,
      content: [
        {
          type: "text",
          text: JSON.stringify({
            code: "CLICKUP_UPSTREAM_DENIED",
            endpoint_category: "clickup_api_read",
            http_status: 403,
          }),
        },
      ],
    });
  });
});
