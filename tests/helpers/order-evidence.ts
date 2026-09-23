import AdmZip from "adm-zip";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";
import type { FulfillmentStore } from "../../src/fulfillment-store.js";
import type { FulfillmentOrder } from "../../src/fulfillment-types.js";

const roots: string[] = [];
afterAll(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function escapeXml(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Writes a real purchase-order workbook that states the pack size of every item,
 * so stage 13's carton gate can verify it the same way it does for live files.
 */
export function writeOrderEvidenceWorkbook(order: FulfillmentOrder): { fileName: string; filePath: string } {
  const root = mkdtempSync(join(tmpdir(), "order-evidence-"));
  roots.push(root);
  const fileName = `${order.orderNo}.xlsx`;
  const filePath = join(root, fileName);
  const rows = [
    ["발주번호", "상품코드", "발주수량", "카톤당 입수수량"],
    ...order.items.map(item => [order.orderNo, item.skuCode, String(item.orderedQuantity), item.unitsPerCarton ? String(item.unitsPerCarton) : ""]),
  ];
  const zip = new AdmZip();
  zip.addFile("xl/workbook.xml", Buffer.from('<workbook><sheets><sheet name="발주서" r:id="rId1"/></sheets></workbook>'));
  zip.addFile("xl/_rels/workbook.xml.rels", Buffer.from('<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>'));
  zip.addFile("xl/worksheets/sheet1.xml", Buffer.from(`<worksheet><sheetData>${rows.map((row, i) =>
    `<row r="${i + 1}">${row.map((value, j) =>
      `<c r="${String.fromCharCode(65 + j)}${i + 1}" t="inlineStr"><is><t>${escapeXml(value)}</t></is></c>`).join("")}</row>`).join("")}</sheetData></worksheet>`));
  zip.writeZip(filePath);
  return { fileName, filePath };
}

/** Records a downloaded order-file artifact for every order in the run. */
export function attachOrderEvidence(store: FulfillmentStore, runId: string): void {
  for (const order of store.getRun(runId).orders) {
    store.recordArtifact({ runId, orderNo: order.orderNo, type: "order_file", status: "downloaded", ...writeOrderEvidenceWorkbook(order) });
  }
}
