import AdmZip from "adm-zip";
import { mkdtempSync, readFileSync, unlinkSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FulfillmentStore } from "../../src/fulfillment-store.js";
import { FulfillmentWorkflow } from "../../src/fulfillment-workflow.js";
import { DemoSupplierHubFulfillmentAdapter, DemoLogenAdapter, DemoFulfillmentPrinterAdapter } from "../../src/fulfillment-adapters.js";
import { DemoOrderConfirmationWorkbookAdapter } from "../../src/order-confirmation-workbook-adapter.js";

export function cartonReviewFixture(units: number | null = 50) {
  const root = mkdtempSync(join(tmpdir(), "carton-review-"));
  const filePath = join(root, "예시_발주서.xlsx");
  const store = new FulfillmentStore(":memory:");
  const logen = new DemoLogenAdapter();
  const workflow = new FulfillmentWorkflow(store, {
    supplierHub: new DemoSupplierHubFulfillmentAdapter(), logen, printer: new DemoFulfillmentPrinterAdapter(),
    confirmationWorkbook: new DemoOrderConfirmationWorkbookAdapter(),
  }, { orderPrinterName: "TEST", waybillPrinterName: "TEST", shipmentPrinterName: "TEST", copies: 1 });
  const order = { orderNo: "EXAMPLE-PO", centerCode: "TEST", centerName: "예시 센터", status: "발주확정", transportType: "쉽먼트",
    createdAt: "", expectedInboundDate: "2026-09-20", items: [{ skuCode: "TEST-SKU", skuName: "예시 도마", orderedQuantity: 200, unitsPerCarton: 200 }] };
  const scan = store.saveScan([order], 7);
  store.classifyAndRecordOrders(scan.id);
  const run = store.createRun(scan.id);
  store.setSenderProfile({ name: "예시 공급사", address: "테스트 주소 1", telephone: "031-123-4567", customerCode: "12345678", fareType: "030", deliveryFare: 0, updatedAt: "2026-09-15" });
  store.upsertCenterMaster({ centerCode: "TEST", centerName: "예시 센터", recipientName: "예시 센터", address: "테스트 주소 2", telephone: "031-123-4568", source: "backend", updatedAt: "2026-09-15" });
  function writeWorkbook(value: number | null, label = "카톤당 입수수량") {
    const rows = [
      ["발주번호", "상품코드", "발주수량", label, "출고수량"],
      [order.orderNo, "TEST-SKU", "200", value === null ? "" : String(value), "200"],
      ["포장 안내: 입수수량이 없으면 실물 박스 라벨의 수량을 확인하세요."],
    ];
    const zip = new AdmZip();
    zip.addFile("xl/workbook.xml", Buffer.from('<workbook><sheets><sheet name="발주서" r:id="rId1"/></sheets></workbook>'));
    zip.addFile("xl/_rels/workbook.xml.rels", Buffer.from('<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>'));
    zip.addFile("xl/worksheets/sheet1.xml", Buffer.from(`<worksheet><sheetData>${rows.map((row, i) => `<row r="${i + 1}">${row.map((value, j) => `<c r="${String.fromCharCode(65 + j)}${i + 1}" t="inlineStr"><is><t>${value}</t></is></c>`).join("")}</row>`).join("")}</sheetData></worksheet>`));
    zip.writeZip(filePath);
  }
  writeWorkbook(units);
  store.recordArtifact({ runId: run.id, orderNo: order.orderNo, type: "order_file", status: "downloaded", filePath, fileName: "예시_발주서.xlsx" });
  const input = { runId: run.id, dataSource: "auto" as const };
  async function confirm(value = 50, note = "", token?: string) {
    const plan = await workflow.previewLogenRegistration(input);
    return workflow.confirmCartonOrderReview({ ...input, confirmed: true, reviews: [{ orderNo: order.orderNo, skuCode: "TEST-SKU",
      unitsPerCarton: value, note, evidenceToken: token ?? plan.rows[0].evidenceToken }] });
  }
  return { root, filePath, store, workflow, logen, run, order, input, confirm, writeWorkbook,
    bytes: () => readFileSync(filePath),
    close() { store.close(); try { unlinkSync(filePath); } catch {} rmdirSync(root); } };
}
