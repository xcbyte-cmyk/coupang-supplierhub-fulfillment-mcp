import { describe, expect, it } from "vitest";
import { isAllowedUiRequest } from "../src/ui-request.js";

describe("fulfillment UI request origin", () => {
  const dashboardHeader = { "x-workflow-ui": "supplierhub-dashboard" } as const;

  it("accepts both local loopback names on the fixed port", () => {
    expect(
      isAllowedUiRequest(
        { ...dashboardHeader, origin: "http://127.0.0.1:4310" },
        "localhost",
        4310,
      ),
    ).toBe(true);
    expect(
      isAllowedUiRequest(
        { ...dashboardHeader, origin: "http://localhost:4310" },
        "127.0.0.1",
        4310,
      ),
    ).toBe(true);
  });

  it("rejects a different origin or a missing dashboard marker", () => {
    expect(
      isAllowedUiRequest(
        { ...dashboardHeader, origin: "http://example.com:4310" },
        "127.0.0.1",
        4310,
      ),
    ).toBe(false);
    expect(
      isAllowedUiRequest(
        { origin: "http://127.0.0.1:4310" },
        "127.0.0.1",
        4310,
      ),
    ).toBe(false);
  });
});
