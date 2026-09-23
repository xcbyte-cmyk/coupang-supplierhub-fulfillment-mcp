import type { Locator, Page } from "playwright-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SingleFlight, waitForChangedRows, waitForVisibleCandidates } from "../src/browser-readiness.js";
import { SupplierHubFulfillmentBrowserAdapter } from "../src/fulfillment-adapters.js";

afterEach(() => vi.useRealTimers());
function candidates(visible: () => boolean[]) {
  const nodes = [0, 1].map(index => ({ isVisible: async () => visible()[index] === true }));
  return { count: async () => visible().length, nth: (index: number) => nodes[index] } as unknown as Locator;
}
describe("bounded read-only readiness", () => {
  it("handles delayed insertion and a hidden first match", async () => {
    vi.useFakeTimers();
    const start = Date.now();
    const locator = candidates(() => Date.now() - start < 300 ? [] : [false, true]);
    const pending = waitForVisibleCandidates(locator, 1000);
    await vi.advanceTimersByTimeAsync(300);
    expect(await pending).toEqual([locator.nth(1)]);
  });
  it("returns ambiguity instead of guessing and does not sleep when ready", async () => {
    expect(await waitForVisibleCandidates(candidates(() => [true, true]))).toHaveLength(2);
  });
  it("stops at the deadline with no visible candidate", async () => {
    vi.useFakeTimers();
    const pending = waitForVisibleCandidates(candidates(() => [false]), 350);
    await vi.advanceTimersByTimeAsync(350);
    expect(await pending).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("propagates closed-session errors instead of hiding them", async () => {
    const locator = { count: async () => { throw new Error("closed"); } } as unknown as Locator;
    await expect(waitForVisibleCandidates(locator)).rejects.toThrow("closed");
  });
});
describe("browser initialization single flight", () => {
  it("shares concurrent initialization and permits a fresh attempt after failure", async () => {
    const flight = new SingleFlight<string>();
    const start = vi.fn().mockRejectedValueOnce(new Error("busy profile")).mockResolvedValue("page");
    const first = flight.run(start);
    const second = flight.run(start);
    expect(first).toBe(second);
    await expect(first).rejects.toThrow("busy profile");
    await expect(flight.run(start)).resolves.toBe("page");
    expect(start).toHaveBeenCalledTimes(2);
  });
});

describe("download event ordering", () => {
  function setup() {
    const download = { suggestedFilename: () => "orders.xlsx" };
    const page = {
      once: vi.fn(), off: vi.fn(),
      waitForEvent: vi.fn(() => new Promise(resolve => setTimeout(() => resolve(download), 15000))),
      locator: vi.fn(() => ({ first: () => ({ waitFor: () => new Promise((_, reject) => setTimeout(() => reject(new Error("no modal")), 10000)) }) })),
    };
    const adapter = Object.create(SupplierHubFulfillmentBrowserAdapter.prototype);
    return { page, download, adapter };
  }
  it("allows a slow direct download when an optional confirmation never appears", async () => {
    vi.useFakeTimers();
    const { page, download, adapter } = setup();
    const button = { click: vi.fn().mockResolvedValue(undefined) };
    const pending = adapter.captureDownload(page, button, ".confirm");
    await vi.advanceTimersByTimeAsync(15000);
    expect(await pending).toBe(download);
    expect(button.click).toHaveBeenCalledOnce();
    expect(page.off).toHaveBeenCalledOnce();
  });
  it("handles a late rejected download after the click already failed", async () => {
    vi.useFakeTimers();
    const { page, adapter } = setup();
    page.waitForEvent.mockImplementation(() => new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 30000)));
    const button = { click: vi.fn().mockRejectedValue(new Error("closed")) };
    await expect(adapter.captureDownload(page, button)).rejects.toThrow("closed");
    await vi.advanceTimersByTimeAsync(30000);
    expect(button.click).toHaveBeenCalledOnce();
    expect(page.off).toHaveBeenCalledOnce();
  });
});

describe("pagination result boundary", () => {
  const page = { locator: () => ({ first: () => ({ waitFor: async () => {} }) }) } as unknown as Page;
  it("waits beyond the former fixed delay and reads a stable new page", async () => {
    vi.useFakeTimers();
    const start = Date.now();
    const rows = { allTextContents: async () => Date.now() - start < 1200 ? ["PO-1"] : ["PO-2"] } as unknown as Locator;
    const pending = waitForChangedRows(page, rows, '["PO-1"]');
    let finished = false;
    void pending.then(() => { finished = true; });
    await vi.advanceTimersByTimeAsync(800);
    expect(finished).toBe(false);
    await vi.advanceTimersByTimeAsync(600);
    await pending;
    expect(finished).toBe(true);
  });
  it("fails instead of repeatedly collecting the same page", async () => {
    vi.useFakeTimers();
    const rows = { allTextContents: async () => ["PO-1"] } as unknown as Locator;
    const pending = expect(waitForChangedRows(page, rows, '["PO-1"]')).rejects.toThrow("목록 갱신");
    await vi.advanceTimersByTimeAsync(15000);
    await pending;
  });
});
