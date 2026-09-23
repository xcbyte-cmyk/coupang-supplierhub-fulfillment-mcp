import { mkdtempSync, realpathSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createConfirmationFileOpener } from "../src/confirmation-file-opener.js";
import type { FulfillmentRun } from "../src/fulfillment-types.js";

let directory: string;
let filePath: string;
let run: Pick<FulfillmentRun, "id" | "orders" | "orderConfirmationJobs">;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "supplierhub-open-file-"));
  filePath = join(directory, "검토 'A' $() & [1].xlsx");
  writeFileSync(filePath, "synthetic fixture; the desktop launcher is mocked");
  run = {
    id: "run-file",
    orders: [{ orderNo: "PO-1", centerCode: "TEST", centerName: "검증 센터", status: "발주확정", transportType: "쉽먼트", createdAt: "", expectedInboundDate: "", items: [] }],
    orderConfirmationJobs: [{ runId: "run-file", orderNo: "PO-1", sourceStatus: "거래처확인요청", status: "prepared", preparedFilePath: filePath, preparedFileName: "검토.xlsx", createdAt: "", updatedAt: "" }],
  };
});
afterEach(() => { unlinkSync(filePath); rmdirSync(directory); });

describe("confirmation workbook desktop opening", () => {
  it("opens the workbook stored for the selected run without changing its workflow state", async () => {
    const openFile = vi.fn().mockResolvedValue(undefined);
    const opener = createConfirmationFileOpener({ getRun: () => run, openFile });
    const before = structuredClone(run);
    const result = await opener({ runId: "run-file", orderNo: "PO-1", expectedFilePath: filePath, filePath: "C:/unrelated.exe" });
    expect(openFile).toHaveBeenCalledExactlyOnceWith(realpathSync.native(filePath));
    expect(result).toMatchObject({ status: "requested", runId: "run-file", orderNo: "PO-1" });
    expect(run).toEqual(before);
  });

  it.each([
    { runId: "another-run", orderNo: "PO-1", stale: false },
    { runId: "run-file", orderNo: "another-order", stale: false },
    { runId: "run-file", orderNo: "PO-1", stale: true },
  ])("does not launch files for stale or unrelated review selections: $runId / $orderNo / $stale", async ({ runId, orderNo, stale }) => {
    const openFile = vi.fn();
    const opener = createConfirmationFileOpener({ getRun: () => run, openFile });
    await expect(opener({ runId, orderNo, expectedFilePath: stale ? "C:/old.xlsx" : filePath })).rejects.toThrow();
    expect(openFile).not.toHaveBeenCalled();
  });

  it("reports a missing workbook instead of issuing a desktop request", async () => {
    const missing = join(directory, "missing.xlsx");
    run.orderConfirmationJobs![0].preparedFilePath = missing;
    const openFile = vi.fn();
    const opener = createConfirmationFileOpener({ getRun: () => run, openFile });
    await expect(opener({ runId: run.id, orderNo: "PO-1", expectedFilePath: missing })).rejects.toThrow("찾을 수 없거나 접근할 수 없습니다");
    expect(openFile).not.toHaveBeenCalled();
  });

  it("does not launch executable or demo paths from stored records", async () => {
    const openFile = vi.fn();
    const opener = createConfirmationFileOpener({ getRun: () => run, openFile });
    for (const path of [join(directory, "program.exe"), "demo://run-file/confirmation.xlsx"]) {
      run.orderConfirmationJobs![0].preparedFilePath = path;
      await expect(opener({ runId: run.id, orderNo: "PO-1", expectedFilePath: path })).rejects.toThrow("실제 준비된 XLSX");
    }
    expect(openFile).not.toHaveBeenCalled();
  });
});
