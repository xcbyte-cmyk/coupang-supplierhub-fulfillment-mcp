import { afterEach, describe, expect, it } from "vitest";
import AdmZip from "adm-zip";
import { mkdtempSync, unlinkSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readShipmentWorkbookData } from "../src/xlsx-order-reader.js";
import { FulfillmentStore } from "../src/fulfillment-store.js";
import type {
  CenterMaster,
  DownloadedOrderFile,
  FulfillmentConnectionResult,
  FulfillmentOrder,
  FulfillmentOrderListResult,
  FulfillmentPrinterPort,
  LogenBatch,
  LogenBatchPort,
  LogenBatchRegistrationResult,
  LogenBatchWaybillResult,
  LogenPort,
  LogenRegistrationResult,
  LogenWaybillResult,
  PrintSubmission,
  SenderProfile,
  ShipmentDocumentResult,
  ShipmentTrackingResult,
  ShippingJob,
  SupplierHubFulfillmentPort,
} from "../src/fulfillment-types.js";
import { FulfillmentWorkflow } from "../src/fulfillment-workflow.js";
import { attachOrderEvidence, writeOrderEvidenceWorkbook } from "./helpers/order-evidence.js";
import { DemoOrderConfirmationWorkbookAdapter } from "../src/order-confirmation-workbook-adapter.js";

const NOW = new Date("2026-07-30T06:00:00.000Z");
const SINDOH = "SINDOH N600";
const ALLLIVE = "AllLive OLIVE-308B";

class FakeSupplierHub implements SupplierHubFulfillmentPort {
  trackingCalls: Array<{ orderNo: string; slipNos: string[] }> = [];
  documentCalls: Array<{ orderNo: string; shipmentId?: string }> = [];
  downloadCalls: string[][] = [];
  downloadLimit?: number;
  confirmationUploadCalls = 0;
  confirmationUploadOutcome: "confirmed" | "unknown" = "confirmed";

  constructor(public orders: FulfillmentOrder[]) {}

  async open(): Promise<FulfillmentConnectionResult> {
    return { status: "ready", message: "ready" };
  }

  async listOrders(_lookAheadDays: 7 | 30): Promise<FulfillmentOrderListResult> {
    return {
      connection: { status: "ready", message: "ready" },
      orders: structuredClone(this.orders),
    };
  }

  async downloadOrderConfirmationTemplate(runId: string, orders: FulfillmentOrder[]) {
    return {
      fileName: `${runId}-confirmation.xlsx`,
      filePath: `test://${runId}/confirmation.xlsx`,
      orderNos: orders.map((order) => order.orderNo),
    };
  }

  async uploadOrderConfirmationWorkbook(input: { orderNos: string[] }) {
    this.confirmationUploadCalls += 1;
    if (this.confirmationUploadOutcome === "unknown") {
      return {
        status: "unknown" as const,
        confirmedOrderNos: [],
        unresolvedOrderNos: [...input.orderNos],
        message: "upload result unknown",
      };
    }
    return {
      status: "confirmed" as const,
      confirmedOrderNos: [...input.orderNos],
      unresolvedOrderNos: [],
      message: "confirmed",
    };
  }

  async getOrderStatuses(orderNos: string[]): Promise<Record<string, string>> {
    return Object.fromEntries(
      orderNos.map((orderNo) => [
        orderNo,
        this.orders.find((order) => order.orderNo === orderNo)?.status ?? "not_found",
      ]),
    );
  }

  async downloadOrderFiles(
    runId: string,
    orders: FulfillmentOrder[],
  ): Promise<DownloadedOrderFile[]> {
    this.downloadCalls.push(orders.map((order) => order.orderNo));
    const selected =
      this.downloadLimit === undefined ? orders : orders.slice(0, this.downloadLimit);
    return selected.map((order) => ({
      orderNo: order.orderNo,
      ...writeOrderEvidenceWorkbook(order),
      items: structuredClone(order.items),
    }));
  }

  async registerShipmentTracking(
    orderNo: string,
    slipNos: string[],
  ): Promise<ShipmentTrackingResult> {
    this.trackingCalls.push({ orderNo, slipNos: [...slipNos] });
    return {
      orderNo,
      shipmentId: `SHIP-${orderNo}`,
      slipNos: [...slipNos],
      success: true,
      message: "registered",
    };
  }

  async getShipmentDocuments(
    orderNo: string,
    shipmentId?: string,
  ): Promise<ShipmentDocumentResult> {
    this.documentCalls.push({ orderNo, shipmentId });
    return {
      orderNo,
      shipmentId: shipmentId ?? `SHIP-${orderNo}`,
      documents: [
        {
          type: "shipment_label",
          fileName: `${orderNo}-label.pdf`,
          filePath: `test://${orderNo}/label.pdf`,
        },
        {
          type: "shipment_statement",
          fileName: `${orderNo}-statement.pdf`,
          filePath: `test://${orderNo}/statement.pdf`,
        },
      ],
    };
  }
}

class FakeLogen implements LogenPort, LogenBatchPort {
  registerCalls: LogenBatch[][] = [];
  waybillCalls: Array<{ batches: LogenBatch[]; printerName: string }> = [];
  legacyWaybillCalls = 0;
  throwLegacyWaybillAfterSubmit = false;
  failOrderNos = new Set<string>();

  async openRegistration() {
    return { status: "ready" as const, message: "login ready" };
  }

  async openSingleOrderRegistration() {
    return { status: "ready" as const, message: "single order ready" };
  }

  async registerBatches(
    batches: LogenBatch[],
    _sender: SenderProfile,
    _centersByOrder: Record<string, CenterMaster>,
  ): Promise<LogenBatchRegistrationResult[]> {
    this.registerCalls.push(structuredClone(batches));
    return batches.map((batch) => this.failOrderNos.has(batch.orderNo)
      ? { batchId: batch.id, fixTakeNo: batch.fixTakeNo, success: false, status: "failed" as const, message: "rejected" }
      : {
          batchId: batch.id,
          fixTakeNo: batch.fixTakeNo,
          success: true,
          status: "registered" as const,
          logenOrderNo: batch.fixTakeNo,
          message: "registered",
        });
  }

  async printBatchWaybills(
    batches: LogenBatch[],
    printerName: string,
  ): Promise<LogenBatchWaybillResult[]> {
    this.waybillCalls.push({ batches: structuredClone(batches), printerName });
    return batches.map((batch, batchIndex) => ({
      batchId: batch.id,
      fixTakeNo: batch.fixTakeNo,
      slipNos: Array.from(
        { length: batch.cartonCount },
        (_, index) => String(44_800_000_000 + batchIndex * 100 + index + 1),
      ),
      success: true,
      status: "submitted",
      message: "printed",
    }));
  }

  async registerOrders(
    jobs: ShippingJob[],
    _sender: SenderProfile,
    _centers: CenterMaster[],
  ): Promise<LogenRegistrationResult[]> {
    this.registerCalls.push(structuredClone(jobs));
    return jobs.map((job) => ({
      shippingJobId: job.id,
      fixTakeNo: job.fixTakeNo,
      success: true,
      message: "registered",
    }));
  }

  async printWaybills(
    jobs: ShippingJob[],
    _printerName: string,
  ): Promise<LogenWaybillResult[]> {
    this.legacyWaybillCalls += 1;
    if (this.throwLegacyWaybillAfterSubmit) {
      throw new Error("connection lost after legacy waybill print submit");
    }
    return jobs.map((job, index) => ({
      shippingJobId: job.id,
      fixTakeNo: job.fixTakeNo,
      slipNo: String(44_900_000_000 + index + 1),
      success: true,
      status: "submitted",
      message: "printed",
    }));
  }
}

class FakePrinter implements FulfillmentPrinterPort {
  calls: Array<{
    files: Array<{ fileName: string; filePath: string }>;
    printerName: string;
    copies: number;
    kind: "order" | "shipment";
  }> = [];
  throwAfterSubmission = false;

  async print(input: {
    files: Array<{ fileName: string; filePath: string }>;
    printerName: string;
    copies: number;
    kind: "order" | "shipment";
  }): Promise<PrintSubmission> {
    this.calls.push(structuredClone(input));
    if (this.throwAfterSubmission) {
      throw new Error("process stopped after print submit");
    }
    return {
      success: true,
      status: "submitted",
      submittedFiles: input.files.map((file) => file.fileName),
      message: "submitted",
    };
  }
}

interface Harness {
  store: FulfillmentStore;
  supplierHub: FakeSupplierHub;
  logen: FakeLogen;
  printer: FakePrinter;
  workflow: FulfillmentWorkflow;
}

const openStores: FulfillmentStore[] = [];

afterEach(() => {
  while (openStores.length > 0) openStores.pop()!.close();
});

function makeOrder(
  orderNo: string,
  items: FulfillmentOrder["items"] = [
    {
      skuCode: "SKU-1",
      skuName: "테스트 상품",
      orderedQuantity: 100,
      unitsPerCarton: 50,
      source: "order_file",
    },
  ],
): FulfillmentOrder {
  return {
    orderNo,
    centerCode: "FC-01",
    centerName: "테스트 센터",
    status: "발주확정",
    transportType: "쉽먼트",
    createdAt: "2026-07-30T09:00:00+09:00",
    expectedInboundDate: "2026-08-01",
    items,
  };
}

function makeHarness(orders: FulfillmentOrder[]): Harness {
  const store = new FulfillmentStore(":memory:");
  openStores.push(store);
  const supplierHub = new FakeSupplierHub(orders);
  const logen = new FakeLogen();
  const printer = new FakePrinter();
  const workflow = new FulfillmentWorkflow(
    store,
    {
      supplierHub,
      logen,
      printer,
      confirmationWorkbook: new DemoOrderConfirmationWorkbookAdapter(),
    },
    {
      orderPrinterName: SINDOH,
      waybillPrinterName: ALLLIVE,
      shipmentPrinterName: SINDOH,
      copies: 1,
    },
    () => NOW,
  );
  return { store, supplierHub, logen, printer, workflow };
}

function seedRouting(store: FulfillmentStore): void {
  store.setSenderProfile({
    name: "테스트 공급사",
    address: "경기도 광주시 테스트로 1",
    telephone: "031-000-0000",
    customerCode: "99999999",
    fareType: "신용",
    deliveryFare: 0,
    updatedAt: NOW.toISOString(),
  });
  store.upsertCenterMaster({
    centerCode: "FC-01",
    centerName: "테스트 센터",
    recipientName: "입고 담당",
    address: "경기도 이천시 테스트로 2",
    telephone: "031-111-1111",
    source: "backend",
    updatedAt: NOW.toISOString(),
  });
}

function legacyShippingJob(
  runId: string,
  orderNo: string,
  status: ShippingJob["status"],
): ShippingJob {
  return {
    id: `legacy-${orderNo}`,
    runId,
    orderNo,
    skuCode: "SKU-1",
    skuName: "테스트 상품",
    cartonIndex: 1,
    shippedQuantity: 50,
    unitsPerCarton: 50,
    fixTakeNo: `${orderNo}-SKU-1-LEGACY`,
    status,
  };
}

async function createRun(harness: Harness): Promise<string> {
  const listed = await harness.workflow.listPrivateLabelOrders({ lookAheadDays: 7 });
  const compared = await harness.workflow.compareNewOrders({ scanId: listed.scanId! });
  expect(compared.items.length).toBeGreaterThan(0);
  const selected = await harness.workflow.selectOrdersForPrint({ scanId: listed.scanId! });
  return selected.runId!;
}

async function createRunWithEvidence(harness: Harness): Promise<string> {
  const runId = await createRun(harness);
  attachOrderEvidence(harness.store, runId);
  return runId;
}

/** Records the operator's manual carton review for every row that still needs one. */
async function confirmCartonReviews(
  harness: Harness,
  runId: string,
  dataSource: "auto" | "backend" | "order_file",
  unitsPerCarton: number,
) {
  const plan = await harness.workflow.previewLogenRegistration({ runId, dataSource });
  return harness.workflow.confirmCartonOrderReview({
    runId,
    dataSource,
    confirmed: true,
    reviews: plan.rows.filter((row) => row.editable && !row.cartonReviewConfirmed).map((row) => ({
      orderNo: row.orderNo,
      skuCode: row.skuCode,
      evidenceToken: row.evidenceToken,
      unitsPerCarton,
      note: "실물 박스 라벨에서 입수수량 확인",
    })),
  });
}

describe("FulfillmentWorkflow", () => {
  const missingItem = { skuCode: "70924435", skuName: "코멧 홈 BPA FREE TPU 걸이형 양면 도마_L_차콜", orderedQuantity: 200, source: "order_file" as const };
  const unitsUpdate = { skuCode: "70924435", unitsPerCarton: 50, expectedUnitsPerCarton: null, expectedUpdatedAt: null };

  it("recovers recipient data from a downloaded workbook using the current print-layout labels", async () => {
    const directory = mkdtempSync(join(tmpdir(), "supplierhub-order-fixture-"));
    const filePath = join(directory, "order.xlsx");
    const rows = [
      ["거래처명", "검증 공급사"], ["전화번호", "031-123-4567"], ["회송주소", "경기도 테스트로 1"],
      ["발주번호", "PO-FILE-RECOVERY"],
      ["입고예정일시", "물류센터", "주소", "택배담당자"],
      ["2026/09/15", "테스트 센터", "경상북도 테스트로 2(택배수령담당자 :+827000000001)", "+827000000001"],
      ["No", "상품코드", "상품명", "발주수량"], ["1", "70924435", missingItem.skuName, "200"],
    ];
    const zip = new AdmZip();
    zip.addFile("xl/worksheets/sheet1.xml", Buffer.from(`<worksheet><sheetData>${rows.map((row, i) => `<row r="${i + 1}">${row.map((value, j) => `<c r="${String.fromCharCode(65 + j)}${i + 1}" t="inlineStr"><is><t>${value}</t></is></c>`).join("")}</row>`).join("")}</sheetData></worksheet>`));
    zip.writeZip(filePath);
    try {
      const parsed = readShipmentWorkbookData(filePath);
      expect(parsed.sender?.address).toBe("경기도 테스트로 1");
      expect(parsed.orders[0].centerMaster).toMatchObject({ address: "경상북도 테스트로 2", telephone: "+827000000001" });
      expect(parsed.orders[0].items[0].unitsPerCarton).toBeUndefined();
      const h = makeHarness([makeOrder("PO-FILE-RECOVERY", [missingItem])]);
      const runId = await createRun(h);
      h.store.recordArtifact({ runId, type: "order_file", status: "downloaded", orderNo: "PO-FILE-RECOVERY", filePath, fileName: "order.xlsx" });
      h.store.setSenderProfile({ name: "검증 공급사", address: "경기도 테스트로 1", telephone: "031-123-4567", customerCode: "12345678", fareType: "신용", deliveryFare: 0, updatedAt: NOW.toISOString() });
      await h.workflow.saveProductCartonUnits({ runId, confirmed: true, updates: [unitsUpdate] });
      const reviewed = await confirmCartonReviews(h, runId, "auto", 50);
      expect(reviewed).toMatchObject({ ready: true, pendingCartonCount: 4 });
      expect(h.store.getCenterMaster("FC-01")).toBeUndefined();
      expect(h.store.getOrderFileCenter("PO-FILE-RECOVERY")).toBeUndefined();
      expect((await h.workflow.registerLogenDeliveryOrder({ runId, dataSource: "auto", reviewToken: reviewed.reviewToken })).status).toBe("completed");
      expect(h.store.getCenterMaster("FC-01")?.telephone).toBe("+827000000001");
      expect(h.supplierHub.downloadCalls).toHaveLength(0);
    } finally {
      unlinkSync(filePath);
      rmdirSync(directory);
    }
  });

  it("previews missing units and a 50-unit suggestion without saving or registering", async () => {
    const h = makeHarness([makeOrder("PO-PREVIEW", [missingItem])]);
    seedRouting(h.store);
    h.store.upsertProductMaster({ skuCode: "44133530", skuName: "코멧 홈 칼집이 잘 나지 않는 TPU 걸이형 양면 도마_차콜", unitsPerCarton: 50, source: "backend", updatedAt: NOW.toISOString() });
    const runId = await createRunWithEvidence(h);
    const before = h.store.getRun(runId);
    const preview = await h.workflow.previewLogenRegistration({ runId, dataSource: "auto" });
    expect(preview.ready).toBe(false);
    expect(preview.rows[0]).toMatchObject({ unitsPerCarton: null, source: "missing", suggestion: { unitsPerCarton: 50, referenceSkuCode: "44133530" } });
    const draft = await h.workflow.previewLogenRegistration({ runId, dataSource: "auto", draftUnits: [{ skuCode: missingItem.skuCode, unitsPerCarton: 50 }] });
    expect(draft).toMatchObject({ ready: false, pendingCartonCount: 4 });
    expect(draft.issues.join(" ")).toContain("아직 확인되지 않았습니다");
    expect(h.store.getProductMaster(missingItem.skuCode)).toBeUndefined();
    expect(h.store.getRun(runId)).toEqual(before);
    expect(h.logen.registerCalls).toHaveLength(0);
  });

  it("saves confirmed units and resumes the same blocked run with four cartons exactly once", async () => {
    const h = makeHarness([makeOrder("PO-RESUME", [missingItem])]);
    seedRouting(h.store);
    const runId = await createRun(h);
    await h.workflow.downloadOrderFiles({ runId });
    await h.workflow.printOrderFiles({ runId });
    const previousStages = h.store.getRun(runId).stages;
    expect((await h.workflow.registerLogenDeliveryOrder({ runId, dataSource: "auto" })).status).toBe("blocked");
    expect(h.store.getRun(runId).shippingJobs.filter(job => job.cartonIndex > 0)).toEqual([]);
    await h.workflow.saveProductCartonUnits({ runId, confirmed: true, updates: [unitsUpdate] });
    const saved = await confirmCartonReviews(h, runId, "auto", 50);
    expect(saved).toMatchObject({ runId, ready: true, pendingCartonCount: 4 });
    const registered = await h.workflow.registerLogenDeliveryOrder({ runId, dataSource: "auto", reviewToken: saved.reviewToken });
    expect(registered.status).toBe("completed");
    expect(registered.items.map(job => job.cartonIndex)).toEqual([1, 2, 3, 4]);
    expect(h.store.getRun(runId).stages.filter(stage => stage.stage !== 13)).toEqual(previousStages);
    expect(h.supplierHub.downloadCalls).toHaveLength(1);
    expect(h.printer.calls).toHaveLength(1);
    await h.workflow.registerLogenDeliveryOrder({ runId, dataSource: "auto" });
    expect(h.logen.registerCalls).toHaveLength(1);
    expect(h.logen.registerCalls[0][0].cartonCount).toBe(4);
    expect((await h.workflow.previewLogenRegistration({ runId, dataSource: "auto" })).rows[0]).toMatchObject({ editable: false, source: "registered", cartonCount: 4 });
    await expect(h.workflow.saveProductCartonUnits({ runId, confirmed: true, updates: [{ ...unitsUpdate, unitsPerCarton: 25, expectedUnitsPerCarton: 50, expectedUpdatedAt: NOW.toISOString() }] })).rejects.toThrow("등록 또는 결과 불명확");
  });

  it("rejects unconfirmed, indivisible and stale changes without partially saving", async () => {
    const h = makeHarness([makeOrder("PO-VALIDATE", [missingItem, { ...missingItem, skuCode: "OTHER" }])]);
    seedRouting(h.store);
    const runId = await createRun(h);
    await expect(h.workflow.saveProductCartonUnits({ runId, confirmed: false, updates: [unitsUpdate] })).rejects.toThrow("확인");
    await expect(h.workflow.saveProductCartonUnits({ runId, confirmed: true, updates: [unitsUpdate, { ...unitsUpdate, skuCode: "OTHER", unitsPerCarton: 30 }] })).rejects.toThrow("나머지 없이");
    expect(h.store.getProductMaster(missingItem.skuCode)).toBeUndefined();
    await h.workflow.saveProductCartonUnits({ runId, confirmed: true, updates: [unitsUpdate] });
    await expect(h.workflow.saveProductCartonUnits({ runId, confirmed: true, updates: [unitsUpdate] })).rejects.toThrow("다른 작업에서 변경");
    expect(h.store.getProductMaster(missingItem.skuCode)?.unitsPerCarton).toBe(50);
  });

  it("blocks a stale registration preview and preserves unknown external registration evidence", async () => {
    const h = makeHarness([makeOrder("PO-STALE", [missingItem])]);
    seedRouting(h.store);
    const runId = await createRunWithEvidence(h);
    const preview = await h.workflow.saveProductCartonUnits({ runId, confirmed: true, updates: [unitsUpdate] });
    await h.workflow.saveProductCartonUnits({ runId, confirmed: true, updates: [{ ...unitsUpdate, unitsPerCarton: 25, expectedUnitsPerCarton: 50, expectedUpdatedAt: NOW.toISOString() }] });
    expect((await h.workflow.registerLogenDeliveryOrder({ runId, dataSource: "auto", reviewToken: preview.reviewToken })).status).toBe("blocked");
    expect(h.logen.registerCalls).toHaveLength(0);
    await confirmCartonReviews(h, runId, "auto", 25);
    await h.workflow.registerLogenDeliveryOrder({ runId, dataSource: "auto" });
    const batch = h.store.getLogenBatches(runId)[0];
    h.store.updateLogenBatch(batch.id, { status: "unknown", message: "등록 결과 불명확" });
    const before = h.store.getLogenBatches(runId);
    await expect(h.workflow.saveProductCartonUnits({ runId, confirmed: true, updates: [{ ...unitsUpdate, expectedUnitsPerCarton: 25, expectedUpdatedAt: NOW.toISOString() }] })).rejects.toThrow("결과 불명확");
    expect((await h.workflow.previewLogenRegistration({ runId, dataSource: "auto" })).ready).toBe(false);
    await h.workflow.registerLogenDeliveryOrder({ runId, dataSource: "auto" });
    expect(h.store.getLogenBatches(runId)).toEqual(before);
    expect(h.logen.registerCalls).toHaveLength(1);
    h.store.updateLogenBatch(batch.id, { status: "failed", message: "주문등록 제출 전 중단: 이전 오류 문구와 등록키가 함께 남은 건" });
    const withRegistrationKey = h.store.getLogenBatches(runId);
    await h.workflow.registerLogenDeliveryOrder({ runId, dataSource: "auto" });
    expect(h.store.getLogenBatches(runId)).toEqual(withRegistrationKey);
    expect(h.logen.registerCalls).toHaveLength(1);
  });

  it("classifies confirmation-required orders and prepares the workbook before upload", async () => {
    const order = { ...makeOrder("PO-CONFIRM"), status: "거래처확인요청" };
    const harness = makeHarness([order]);
    const listed = await harness.workflow.listPrivateLabelOrders({ lookAheadDays: 30 });
    const compared = await harness.workflow.compareNewOrders({ scanId: listed.scanId! });
    expect(compared.items).toMatchObject([
      {
        disposition: "needs_confirmation",
        firstSeen: true,
        unprocessed: true,
        order: { orderNo: "PO-CONFIRM" },
      },
    ]);
    const selected = await harness.workflow.selectOrdersForFulfillment({
      scanId: listed.scanId!,
      orderNos: ["PO-CONFIRM"],
    });

    expect((await harness.workflow.downloadOrderConfirmationTemplate({ runId: selected.runId! })).status).toBe("completed");
    const prepared = await harness.workflow.prepareOrderConfirmationWorkbook({
      runId: selected.runId!,
    });

    expect(prepared.status).toBe("completed");
    expect(harness.store.getRun(selected.runId!).orderConfirmationJobs).toMatchObject([
      {
        orderNo: "PO-CONFIRM",
        sourceStatus: "거래처확인요청",
        status: "prepared",
      },
    ]);
    expect(harness.supplierHub.confirmationUploadCalls).toBe(0);
  });

  it("does not retry an unknown order-confirmation upload unless explicitly forced", async () => {
    const order = { ...makeOrder("PO-UNKNOWN"), status: "거래처확인요청" };
    const harness = makeHarness([order]);
    harness.supplierHub.confirmationUploadOutcome = "unknown";
    const runId = await createRun(harness);
    await harness.workflow.downloadOrderConfirmationTemplate({ runId });
    await harness.workflow.prepareOrderConfirmationWorkbook({ runId });

    expect((await harness.workflow.uploadAndConfirmPrivateLabelOrders({ runId })).status).toBe("unknown");
    expect((await harness.workflow.uploadAndConfirmPrivateLabelOrders({ runId })).status).toBe("unknown");
    expect(harness.supplierHub.confirmationUploadCalls).toBe(1);

    harness.supplierHub.confirmationUploadOutcome = "confirmed";
    expect(
      (await harness.workflow.uploadAndConfirmPrivateLabelOrders({ runId, forceRetry: true })).status,
    ).toBe("completed");
    expect(harness.supplierHub.confirmationUploadCalls).toBe(2);
  });

  it("compares a scan idempotently and does not rediscover the same order in a later scan", async () => {
    const harness = makeHarness([makeOrder("PO-001")]);

    const firstScan = await harness.workflow.listPrivateLabelOrders({ lookAheadDays: 7 });
    const firstCompare = await harness.workflow.compareNewOrders({ scanId: firstScan.scanId! });
    const repeatedCompare = await harness.workflow.compareNewOrders({ scanId: firstScan.scanId! });

    expect(firstCompare.items.map((item) => item.order.orderNo)).toEqual(["PO-001"]);
    expect(repeatedCompare.items.map((item) => item.order.orderNo)).toEqual(["PO-001"]);
    await harness.workflow.selectOrdersForPrint({ scanId: firstScan.scanId! });

    const laterScan = await harness.workflow.listPrivateLabelOrders({ lookAheadDays: 7 });
    const laterCompare = await harness.workflow.compareNewOrders({ scanId: laterScan.scanId! });
    expect(laterCompare.items).toMatchObject([
      {
        disposition: "already_assigned",
        unprocessed: false,
        order: { orderNo: "PO-001" },
      },
    ]);
  });

  it("rediscovers an order when comparison completed but no run owns it", async () => {
    const harness = makeHarness([makeOrder("PO-UNASSIGNED")]);
    const firstScan = await harness.workflow.listPrivateLabelOrders({ lookAheadDays: 7 });
    await harness.workflow.compareNewOrders({ scanId: firstScan.scanId! });

    const laterScan = await harness.workflow.listPrivateLabelOrders({ lookAheadDays: 7 });
    const laterCompare = await harness.workflow.compareNewOrders({ scanId: laterScan.scanId! });

    expect(laterCompare.items.map((item) => item.order.orderNo)).toEqual(["PO-UNASSIGNED"]);
  });

  it("automatically selects every new order and reuses the same run for the same selection", async () => {
    const harness = makeHarness([makeOrder("PO-001"), makeOrder("PO-002")]);
    const listed = await harness.workflow.listPrivateLabelOrders({ lookAheadDays: 30 });
    await harness.workflow.compareNewOrders({ scanId: listed.scanId! });

    const selected = await harness.workflow.selectOrdersForPrint({ scanId: listed.scanId! });
    const repeated = await harness.workflow.selectOrdersForPrint({ scanId: listed.scanId! });

    expect(selected.items.map((order) => order.orderNo)).toEqual(["PO-001", "PO-002"]);
    expect(repeated.runId).toBe(selected.runId);
  });

  it("uses backend carton units in backend mode and order-file units in order_file mode", async () => {
    const item = {
      skuCode: "SKU-1",
      skuName: "우선순위 상품",
      orderedQuantity: 100,
      unitsPerCarton: 25,
      source: "order_file" as const,
    };

    const backendHarness = makeHarness([makeOrder("PO-BACKEND", [item])]);
    seedRouting(backendHarness.store);
    backendHarness.store.upsertProductMaster({
      skuCode: "SKU-1",
      skuName: "우선순위 상품",
      unitsPerCarton: 50,
      source: "backend",
      updatedAt: NOW.toISOString(),
    });
    const backendRunId = await createRunWithEvidence(backendHarness);
    await confirmCartonReviews(backendHarness, backendRunId, "backend", 50);
    const backend = await backendHarness.workflow.registerLogenDeliveryOrder({
      runId: backendRunId,
      dataSource: "backend",
    });

    expect(backend.items).toHaveLength(2);
    expect(backend.items.every((job) => job.unitsPerCarton === 50)).toBe(true);
    expect(backendHarness.store.getProductMaster("SKU-1")?.source).toBe("backend");

    const fileHarness = makeHarness([makeOrder("PO-FILE", [item])]);
    seedRouting(fileHarness.store);
    fileHarness.store.upsertProductMaster({
      skuCode: "SKU-1",
      skuName: "우선순위 상품",
      unitsPerCarton: 50,
      source: "backend",
      updatedAt: NOW.toISOString(),
    });
    const fileRunId = await createRunWithEvidence(fileHarness);
    await confirmCartonReviews(fileHarness, fileRunId, "order_file", 25);
    const orderFile = await fileHarness.workflow.registerLogenDeliveryOrder({
      runId: fileRunId,
      dataSource: "order_file",
    });

    expect(orderFile.items).toHaveLength(4);
    expect(orderFile.items.every((job) => job.unitsPerCarton === 25)).toBe(true);
    // The reviewed, successfully registered pack size becomes the saved master.
    expect(fileHarness.store.getProductMaster("SKU-1")).toMatchObject({
      unitsPerCarton: 25,
      source: "order_file",
    });
  });

  it("expands quantity 100 with 50 units per carton into exactly two carton jobs", async () => {
    const harness = makeHarness([makeOrder("PO-CARTONS")]);
    seedRouting(harness.store);
    const runId = await createRunWithEvidence(harness);

    const result = await harness.workflow.registerLogenDeliveryOrder({
      runId,
      dataSource: "order_file",
    });

    expect(result.status).toBe("completed");
    expect(result.items).toHaveLength(2);
    expect(result.items.map((job) => job.cartonIndex)).toEqual([1, 2]);
    expect(result.items.map((job) => job.shippedQuantity)).toEqual([50, 50]);
    expect(new Set(result.items.map((job) => job.fixTakeNo)).size).toBe(2);
  });

  it("blocks only an indivisible SKU while continuing the other SKU", async () => {
    const harness = makeHarness([
      makeOrder("PO-PARTIAL", [
        {
          skuCode: "SKU-BLOCKED",
          skuName: "나머지 발생 상품",
          orderedQuantity: 25,
          unitsPerCarton: 10,
          source: "order_file",
        },
        {
          skuCode: "SKU-GOOD",
          skuName: "정상 상품",
          orderedQuantity: 20,
          unitsPerCarton: 10,
          source: "order_file",
        },
      ]),
    ]);
    seedRouting(harness.store);
    const runId = await createRunWithEvidence(harness);

    const result = await harness.workflow.registerLogenDeliveryOrder({
      runId,
      dataSource: "order_file",
    });

    expect(result.status).toBe("partial");
    expect(result.items.filter((job) => job.status === "registered")).toHaveLength(2);
    expect(result.items.find((job) => job.skuCode === "SKU-BLOCKED")).toMatchObject({
      cartonIndex: 0,
      status: "blocked",
    });
    expect(harness.logen.registerCalls.flat().map((batch) => batch.skuCode)).toEqual([
      "SKU-GOOD",
    ]);
  });

  it("holds back only the SKU whose order file lacks a pack size and registers the verified SKU", async () => {
    const harness = makeHarness([
      makeOrder("PO-REVIEW-SPLIT", [
        { skuCode: "SKU-UNSTATED", skuName: "입수수량 미기재 상품", orderedQuantity: 100, source: "order_file" },
        { skuCode: "SKU-STATED", skuName: "입수수량 기재 상품", orderedQuantity: 20, unitsPerCarton: 10, source: "order_file" },
      ]),
    ]);
    seedRouting(harness.store);
    harness.store.upsertProductMaster({ skuCode: "SKU-UNSTATED", skuName: "입수수량 미기재 상품", unitsPerCarton: 50, source: "backend", updatedAt: NOW.toISOString() });
    const runId = await createRunWithEvidence(harness);

    const result = await harness.workflow.registerLogenDeliveryOrder({ runId, dataSource: "auto" });

    expect(result.status).toBe("partial");
    expect(harness.logen.registerCalls.flat().map((batch) => batch.skuCode)).toEqual(["SKU-STATED"]);
    expect(result.items.find((job) => job.skuCode === "SKU-UNSTATED")).toMatchObject({
      cartonIndex: 0,
      status: "blocked",
      error: expect.stringContaining("발주서 포장 기준 확인이 필요합니다"),
    });
    expect(harness.store.getLogenBatches(runId).find((batch) => batch.skuCode === "SKU-UNSTATED")).toMatchObject({
      status: "blocked",
      message: expect.stringContaining("발주서 포장 기준 확인이 필요합니다"),
    });
  });

  it("keeps the saved master unchanged when the reviewed registration does not succeed", async () => {
    const harness = makeHarness([makeOrder("PO-MASTER-FAIL", [
      { skuCode: "SKU-1", skuName: "우선순위 상품", orderedQuantity: 100, unitsPerCarton: 25, source: "order_file" },
    ])]);
    seedRouting(harness.store);
    harness.store.upsertProductMaster({ skuCode: "SKU-1", skuName: "우선순위 상품", unitsPerCarton: 50, source: "backend", updatedAt: NOW.toISOString() });
    harness.logen.failOrderNos.add("PO-MASTER-FAIL");
    const runId = await createRunWithEvidence(harness);
    await confirmCartonReviews(harness, runId, "order_file", 25);

    await harness.workflow.registerLogenDeliveryOrder({ runId, dataSource: "order_file" });

    expect(harness.store.getProductMaster("SKU-1")).toMatchObject({ unitsPerCarton: 50, source: "backend" });
  });

  it("does not register the same Logen carton orders again on a retry", async () => {
    const harness = makeHarness([makeOrder("PO-RETRY")]);
    seedRouting(harness.store);
    const runId = await createRunWithEvidence(harness);

    const first = await harness.workflow.registerLogenDeliveryOrder({
      runId,
      dataSource: "order_file",
    });
    const second = await harness.workflow.registerLogenDeliveryOrder({
      runId,
      dataSource: "order_file",
    });

    expect(first.items.filter((job) => job.status === "registered")).toHaveLength(2);
    expect(second.items.filter((job) => job.status === "registered")).toHaveLength(2);
    expect(harness.logen.registerCalls).toHaveLength(1);
    expect(harness.logen.registerCalls[0]).toHaveLength(1);
  });

  it("routes prints to the fixed printers and groups carton tracking numbers into one shipment", async () => {
    const harness = makeHarness([makeOrder("PO-ROUTING")]);
    seedRouting(harness.store);
    const runId = await createRun(harness);

    await harness.workflow.downloadOrderFiles({ runId });
    await harness.workflow.printOrderFiles({ runId });
    await harness.workflow.registerLogenDeliveryOrder({ runId, dataSource: "order_file" });
    await harness.workflow.printLogenWaybill({ runId });
    await harness.workflow.registerSupplierHubShipmentTracking({ runId });
    await harness.workflow.printSupplierHubShipmentDocuments({ runId });

    expect(harness.printer.calls.map((call) => [call.kind, call.printerName])).toEqual([
      ["order", SINDOH],
      ["shipment", SINDOH],
    ]);
    expect(harness.logen.waybillCalls).toHaveLength(1);
    expect(harness.logen.waybillCalls[0].printerName).toBe(ALLLIVE);
    expect(harness.supplierHub.trackingCalls).toEqual([
      { orderNo: "PO-ROUTING", slipNos: ["44800000001", "44800000002"] },
    ]);

    const run = await harness.workflow.getFulfillmentRun({ runId });
    expect(run.shippingJobs).toHaveLength(2);
    expect(run.shippingJobs.every((job) => job.shipmentId === "SHIP-PO-ROUTING")).toBe(true);
  });

  it("resumes order downloads per PO when only part of a run was recorded", async () => {
    const harness = makeHarness([makeOrder("PO-DOWNLOAD-1"), makeOrder("PO-DOWNLOAD-2")]);
    const runId = await createRun(harness);
    harness.supplierHub.downloadLimit = 1;

    const partial = await harness.workflow.downloadOrderFiles({ runId });
    const afterPartial = harness.store.getRun(runId);
    harness.supplierHub.downloadLimit = undefined;
    const completed = await harness.workflow.downloadOrderFiles({ runId });

    expect(partial.status).toBe("blocked");
    expect(afterPartial).toMatchObject({ currentStage: 8, status: "blocked" });
    expect(afterPartial.stages.some((stage) => stage.stage === 9)).toBe(false);
    expect(completed.status).toBe("completed");
    expect(harness.supplierHub.downloadCalls).toEqual([
      ["PO-DOWNLOAD-1", "PO-DOWNLOAD-2"],
      ["PO-DOWNLOAD-2"],
    ]);
    expect(
      harness.store
        .getRun(runId)
        .artifacts.filter((artifact) => artifact.type === "order_file"),
    ).toHaveLength(2);
  });

  it("downloads more than 100 selected POs in bounded chunks", async () => {
    const orders = Array.from({ length: 101 }, (_, index) =>
      makeOrder(`PO-BULK-${String(index + 1).padStart(3, "0")}`),
    );
    const harness = makeHarness(orders);
    const runId = await createRun(harness);

    const result = await harness.workflow.downloadOrderFiles({ runId });

    expect(result.status).toBe("completed");
    expect(harness.supplierHub.downloadCalls.map((call) => call.length)).toEqual([100, 1]);
    expect(
      harness.store
        .getArtifacts(runId)
        .filter((artifact) => artifact.type === "order_file"),
    ).toHaveLength(101);
  });

  it("does not automatically reprint order, waybill, or shipment documents without force", async () => {
    const harness = makeHarness([makeOrder("PO-REPRINT")]);
    seedRouting(harness.store);
    const runId = await createRun(harness);

    await harness.workflow.downloadOrderFiles({ runId });
    await harness.workflow.printOrderFiles({ runId });
    const skippedOrder = await harness.workflow.printOrderFiles({ runId });
    expect(skippedOrder.message).toContain("자동으로 다시 실행하지 않았습니다");
    expect(harness.printer.calls.filter((call) => call.kind === "order")).toHaveLength(1);
    await harness.workflow.printOrderFiles({ runId, forceReprint: true });
    expect(harness.printer.calls.filter((call) => call.kind === "order")).toHaveLength(2);

    await harness.workflow.registerLogenDeliveryOrder({ runId, dataSource: "order_file" });
    await harness.workflow.printLogenWaybill({ runId });
    const skippedWaybill = await harness.workflow.printLogenWaybill({ runId });
    expect(skippedWaybill.message).toContain("자동으로 재출력하지 않았습니다");
    expect(harness.logen.waybillCalls).toHaveLength(1);
    await harness.workflow.printLogenWaybill({ runId, forceReprint: true });
    expect(harness.logen.waybillCalls).toHaveLength(2);

    await harness.workflow.registerSupplierHubShipmentTracking({ runId });
    await harness.workflow.printSupplierHubShipmentDocuments({ runId });
    await harness.workflow.printSupplierHubShipmentDocuments({ runId });
    expect(harness.printer.calls.filter((call) => call.kind === "shipment")).toHaveLength(1);
    expect(harness.supplierHub.documentCalls).toHaveLength(1);
    await harness.workflow.printSupplierHubShipmentDocuments({ runId, forceReprint: true });
    expect(harness.printer.calls.filter((call) => call.kind === "shipment")).toHaveLength(2);
    expect(harness.supplierHub.documentCalls).toHaveLength(2);
  });

  it("keeps legacy in-flight waybill output unknown and never auto-reprints it", async () => {
    const harness = makeHarness([makeOrder("PO-LEGACY-WAYBILL")]);
    const runId = await createRun(harness);
    harness.store.saveShippingJobs([
      legacyShippingJob(runId, "PO-LEGACY-WAYBILL", "registered"),
    ]);
    harness.logen.throwLegacyWaybillAfterSubmit = true;

    const first = await harness.workflow.printLogenWaybill({ runId });
    const repeated = await harness.workflow.printLogenWaybill({ runId });

    expect(first.status).toBe("failed");
    expect(repeated.status).toBe("unknown");
    expect(harness.logen.legacyWaybillCalls).toBe(1);
    expect(harness.store.getShippingJobs(runId)[0]).toMatchObject({ status: "unknown" });
  });

  it("keeps legacy in-flight shipment documents unknown and never auto-reprints them", async () => {
    const harness = makeHarness([makeOrder("PO-LEGACY-DOCS")]);
    const runId = await createRun(harness);
    harness.store.saveShippingJobs([
      {
        ...legacyShippingJob(runId, "PO-LEGACY-DOCS", "tracking_registered"),
        slipNo: "SLIP-LEGACY",
        shipmentId: "SHIP-PO-LEGACY-DOCS",
      },
    ]);
    harness.printer.throwAfterSubmission = true;

    const first = await harness.workflow.printSupplierHubShipmentDocuments({ runId });
    const repeated = await harness.workflow.printSupplierHubShipmentDocuments({ runId });

    expect(first.status).toBe("unknown");
    expect(repeated.status).toBe("unknown");
    expect(harness.printer.calls).toHaveLength(1);
    expect(
      harness.store
        .getArtifacts(runId)
        .filter((artifact) => artifact.status === "unknown"),
    ).toHaveLength(2);
  });

  it("resumes an existing stage-4 run before scanning for new orders", async () => {
    const harness = makeHarness([makeOrder("PO-RESUME-EARLY")]);
    seedRouting(harness.store);
    const runId = await createRun(harness);

    const result = await harness.workflow.runFulfillmentWorkflow({
      lookAheadDays: 7,
      dataSource: "order_file",
    });

    expect(result).toMatchObject({ id: runId, currentStage: 16, status: "completed" });
    expect(harness.logen.registerCalls).toHaveLength(1);
    expect(harness.logen.waybillCalls).toHaveLength(1);
  });
});
