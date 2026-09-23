import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import type { Page } from "playwright-core";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", async importOriginal => ({
  ...await importOriginal<typeof import("node:child_process")>(),
  spawn: mocks.spawn,
}));
import { PersistentChromeSession } from "../src/persistent-chrome-session.js";

afterEach(() => vi.resetAllMocks());

describe.runIf(process.platform === "win32")("Supplier Hub window arrangement", () => {
  function setup(split = false, headless = false) {
    const child = Object.assign(new EventEmitter(), { kill: vi.fn() });
    mocks.spawn.mockImplementation(() => {
      queueMicrotask(() => child.emit("exit", 0));
      return child as unknown as ChildProcess;
    });
    const session = new PersistentChromeSession("test-profile", headless, "cdp", undefined, split);
    Object.assign(session, { cdpProcess: { pid: 12345 } });
    const page = { bringToFront: vi.fn().mockResolvedValue(undefined) } as unknown as Page;
    return { session, page };
  }

  it("asks the existing helper to split only the opted-in Supplier Hub window", async () => {
    const { session, page } = setup(true);
    await session.bringToFront(page);
    expect(page.bringToFront).toHaveBeenCalledOnce();
    expect(mocks.spawn).toHaveBeenCalledOnce();
    const [executable, args, options] = mocks.spawn.mock.calls[0];
    expect(executable).toBe("powershell.exe");
    expect(args.slice(-3)).toEqual(["-ProcessId", "12345", "-SplitWithDashboard"]);
    expect(options.windowsHide).toBe(true);
  });

  it("retains focus-only behavior for other browser sessions", async () => {
    const { session, page } = setup();
    await session.bringToFront(page);
    expect(mocks.spawn.mock.calls[0][1]).not.toContain("-SplitWithDashboard");
  });

  it("does not rearrange windows in headless mode", async () => {
    const { session, page } = setup(true, true);
    await session.bringToFront(page);
    expect(mocks.spawn).not.toHaveBeenCalled();
  });
});
