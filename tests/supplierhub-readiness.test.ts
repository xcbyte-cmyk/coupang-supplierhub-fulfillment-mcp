import { describe, expect, it, vi } from "vitest";
import { SupplierHubFulfillmentBrowserAdapter } from "../src/fulfillment-adapters.js";

function setup(afterWait: "ready" | "login" | "empty") {
  let rendered = false;
  let url = "https://supplier.coupang.com/po-web/cplb/po/list";
  const heading = {
    first: () => heading,
    waitFor: vi.fn(async () => {
      if (afterWait === "login") url = "https://supplier.coupang.com/login";
      if (afterWait === "empty") throw new Error("timeout");
      rendered = afterWait === "ready";
    }),
    count: async () => rendered ? 1 : 0,
    nth: () => ({ isVisible: async () => rendered }),
  };
  const page = { url: () => url, locator: (selector: string) => selector === "body"
    ? { evaluate: async () => false } : heading };
  const adapter = Object.assign(Object.create(SupplierHubFulfillmentBrowserAdapter.prototype), {
    selectors: { readyHeading: "h1" },
  });
  return { check: () => adapter.privateLabelConnection(page), heading };
}

describe("Supplier Hub list rendering readiness", () => {
  it("waits for a delayed SPA heading before declaring ready", async () => {
    const { check, heading } = setup("ready");
    expect((await check()).status).toBe("ready");
    expect(heading.waitFor).toHaveBeenCalledWith({ state: "visible", timeout: 15000 });
  });
  it("rechecks login redirects after waiting", async () => {
    expect((await setup("login").check()).status).toBe("login_required");
  });
  it("does not mark an unrendered list ready", async () => {
    const result = await setup("empty").check();
    expect(result.status).toBe("blocked");
    expect(result.message).toContain("15초");
  });
});
