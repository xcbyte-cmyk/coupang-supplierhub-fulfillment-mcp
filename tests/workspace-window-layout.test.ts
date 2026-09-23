import type { FulfillmentRun } from "../src/fulfillment-types.js";
import { afterEach, describe, expect, it, vi } from "vitest";
const native = vi.hoisted(() => ({ execFile: vi.fn() }));
vi.mock("node:child_process", async original => ({
  ...await original<typeof import("node:child_process")>(), execFile: native.execFile,
}));
import { createWorkspaceWindowPreparer, prepareWorkspaceWindows, trackWorkspaceBrowser } from "../src/workspace-window-layout.js";
afterEach(() => vi.resetAllMocks());

describe("workspace preparation button", () => {
  it("prepares an empty right side without loading or executing a run", async () => {
    const getRun = vi.fn();
    const prepare = vi.fn().mockResolvedValue({ code: "ready", moved: 0, matched: 0 });
    const result = await createWorkspaceWindowPreparer({ getRun, prepare })({});
    expect(getRun).not.toHaveBeenCalled();
    expect(prepare).toHaveBeenCalledExactlyOnceWith([]);
    expect(result).toMatchObject({ ready: true, movedWindows: 0, status: "completed" });
  });
  it("uses only documents stored for the selected run, ignoring client-supplied paths", async () => {
    const getRun = vi.fn().mockReturnValue({
      artifacts: [{ filePath: "C:/work/발주서.xlsx" }],
      orderConfirmationJobs: [{ preparedFilePath: "C:/work/확정.xlsx" }],
    } as unknown as FulfillmentRun);
    const prepare = vi.fn().mockResolvedValue({ code: "ready", moved: 2, matched: 2 });
    await createWorkspaceWindowPreparer({ getRun, prepare })({ runId: " run-1 ", documentPaths: ["C:/unrelated.xlsx"] });
    expect(getRun).toHaveBeenCalledExactlyOnceWith("run-1");
    expect(prepare).toHaveBeenCalledExactlyOnceWith(["C:/work/발주서.xlsx", "C:/work/확정.xlsx"]);
  });
  it("does not claim completion when the dashboard window is absent", async () => {
    const result = await createWorkspaceWindowPreparer({
      getRun: vi.fn(), prepare: vi.fn().mockResolvedValue({ code: "dashboard_missing", moved: 0, matched: 1 }),
    })({});
    expect(result).toMatchObject({ ready: false, status: "attention" });
    expect((result as { message: string }).message).toContain("일반 브라우저");
  });
  it("does not arrange windows if a selected run cannot be read", async () => {
    const prepare = vi.fn();
    const action = createWorkspaceWindowPreparer({ getRun: () => { throw new Error("missing run"); }, prepare });
    await expect(action({ runId: "missing" })).rejects.toThrow("missing run");
    expect(prepare).not.toHaveBeenCalled();
  });
  it.runIf(process.platform === "win32")("passes process IDs and document names as data to a fixed helper", async () => {
    native.execFile.mockImplementation((_exe, _args, _options, callback) => {
      callback(null, '{"code":"ready","moved":1,"matched":1}', "");
    });
    const untrack = trackWorkspaceBrowser(12345);
    try {
      await prepareWorkspaceWindows(["C:/work/발주서.xlsx", "C:/work/run.exe"]);
      const [exe, args, options] = native.execFile.mock.calls[0];
      expect(exe).toBe("powershell.exe");
      expect(args).toContain("-PrepareWorkspace");
      expect(args).not.toContain("-Command");
      expect(options.windowsHide).toBe(true);
      expect(JSON.parse(Buffer.from(options.env.SUPPLIERHUB_LAYOUT_TARGETS, "base64").toString("utf8"))).toEqual({
        processes: [12345], documents: ["발주서.xlsx"],
      });
    } finally { untrack(); }
  });
});
