import { afterEach, describe, expect, it } from "vitest";
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
      fileName: `${order.orderNo}.xlsx`,
      filePath: `test://${runId}/${order.orderNo}.xlsx`,
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

  async registerBatches(
    batches: LogenBatch[],
    _sender: SenderProfile,
    _centersByOrder: Record<string, CenterMaster>,
  ): Promise<LogenBatchRegistrationResult[]> {
    this.registerCalls.push(structuredClone(batches));
    return batches.map((batch) => ({
      batchId: batch.id,
      fixTakeNo: batch.fixTakeNo,
      success: true,
      status: "registered",
      logenOrderNo: batch.fixTakeNo,
      message: "registered",
    }));
  }

  async printBatchWaybills(
    batches: LogenBatch[],
    printerName: string,
  ): Promise<LogenBatchWaybillResult[]> {
    this.waybillCalls.push({ batches: structuredClone(batches), printerName });
    return batches.map((batch) => ({
      batchId: batch.id,
      fixTakeNo: batch.fixTakeNo,
      slipNos: Array.from({ length: batch.cartonCount }, (_, index) => `SLIP-${index + 1}`),
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
    return jobs.map((job) => ({
      shippingJobId: job.id,
      fixTakeNo: job.fixTakeNo,
      slipNo: `SLIP-${job.cartonIndex}`,
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
    name: "대령화학",
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

describe("FulfillmentWorkflow", () => {
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
    const backendRunId = await createRun(backendHarness);
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
    const fileRunId = await createRun(fileHarness);
    const orderFile = await fileHarness.workflow.registerLogenDeliveryOrder({
      runId: fileRunId,
      dataSource: "order_file",
    });

    expect(orderFile.items).toHaveLength(4);
    expect(orderFile.items.every((job) => job.unitsPerCarton === 25)).toBe(true);
    expect(fileHarness.store.getProductMaster("SKU-1")).toMatchObject({
      unitsPerCarton: 25,
      source: "order_file",
    });
  });

  it("expands quantity 100 with 50 units per carton into exactly two carton jobs", async () => {
    const harness = makeHarness([makeOrder("PO-CARTONS")]);
    seedRouting(harness.store);
    const runId = await createRun(harness);

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
    const runId = await createRun(harness);

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

  it("does not register the same Logen carton orders again on a retry", async () => {
    const harness = makeHarness([makeOrder("PO-RETRY")]);
    seedRouting(harness.store);
    const runId = await createRun(harness);

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
      { orderNo: "PO-ROUTING", slipNos: ["SLIP-1", "SLIP-2"] },
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

    expect(result).toMatchObject({ id: runId, currentStage: 14, status: "completed" });
    expect(harness.logen.registerCalls).toHaveLength(1);
    expect(harness.logen.waybillCalls).toHaveLength(1);
  });
});
