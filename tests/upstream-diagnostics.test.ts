import { describe, expect, it } from "vitest";
import { apiDiagnostic, ReadFailure } from "../src/clickup/policy.js";
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
