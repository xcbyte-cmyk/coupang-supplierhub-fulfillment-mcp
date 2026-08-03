import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { OrderConfirmationWorkbookAdapter } from "../src/order-confirmation-workbook-adapter.js";

const roots: string[] = [];

afterEach(async () => {
  while (roots.length > 0) await rm(roots.pop()!, { recursive: true, force: true });
});

describe("OrderConfirmationWorkbookAdapter", () => {
  it("changes only selected confirmation quantities and preserves other cells and styles", async () => {
    const root = await mkdtemp(join(tmpdir(), "order-confirmation-"));
    roots.push(root);
    const source = join(root, "source.xlsx");
    createFixture(source);
    const adapter = new OrderConfirmationWorkbookAdapter({ outputRoot: join(root, "out") });

    const result = await adapter.prepare({
      runId: "run-1",
      sourceFileName: "source.xlsx",
      sourceFilePath: source,
      orderNos: ["PO-1"],
    });
    const workbook = inspectWorkbook(result.filePath);

    expect(result.changedRows).toBe(1);
    expect(workbook.rows).toEqual([
      ["PO-1", 12, 12, "2026-08-10", "유지"],
      ["PO-2", 7, 99, "2026-08-11", "그대로"],
    ]);
    expect(workbook.confirmationStyleIds[0]).toBe(workbook.confirmationStyleIds[1]);
  });

  it("fails when a selected purchase order is absent from the template", async () => {
    const root = await mkdtemp(join(tmpdir(), "order-confirmation-missing-"));
    roots.push(root);
    const source = join(root, "source.xlsx");
    createFixture(source);
    const adapter = new OrderConfirmationWorkbookAdapter({ outputRoot: join(root, "out") });

    await expect(
      adapter.prepare({
        runId: "run-missing",
        sourceFileName: "source.xlsx",
        sourceFilePath: source,
        orderNos: ["PO-NOT-FOUND"],
      }),
    ).rejects.toThrow("선택한 발주를 찾을 수 없습니다");
  });
});

function createFixture(path: string): void {
  runPython(
    `
from openpyxl import Workbook
from openpyxl.styles import PatternFill
import sys
wb = Workbook()
ws = wb.active
ws.append(["발주번호", "발주수량", "확정수량", "입고예정일", "메모"])
ws.append(["PO-1", 12, 0, "2026-08-10", "유지"])
ws.append(["PO-2", 7, 99, "2026-08-11", "그대로"])
fill = PatternFill(fill_type="solid", fgColor="FFF2CC")
ws["C2"].fill = fill
ws["C3"].fill = fill
wb.save(sys.argv[1])
`,
    [path],
  );
}

function inspectWorkbook(path: string): {
  rows: unknown[][];
  confirmationStyleIds: number[];
} {
  const output = runPython(
    `
from openpyxl import load_workbook
import json, sys
wb = load_workbook(sys.argv[1], data_only=False)
ws = wb.active
print(json.dumps({
  "rows": [[ws.cell(r, c).value for c in range(1, 6)] for r in range(2, 4)],
  "confirmationStyleIds": [ws["C2"].style_id, ws["C3"].style_id],
}, ensure_ascii=False))
wb.close()
`,
    [path],
  );
  return JSON.parse(output) as {
    rows: unknown[][];
    confirmationStyleIds: number[];
  };
}

function runPython(script: string, args: string[]): string {
  const result = spawnSync("python", ["-c", script, ...args], {
    encoding: "utf8",
    windowsHide: true,
    env: { ...process.env, PYTHONUTF8: "1" },
  });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout.trim();
}
