import { afterEach, describe, expect, it } from "vitest";
import {
  assertStage11Ready,
  chooseAutomaticShipDate,
  eligibleShipDates,
  planFulfillment,
} from "../src/fulfillment-planning.js";
import { DemoSupplierHubShipmentAdapter } from "../src/fulfillment-v2-adapters.js";
import { FulfillmentStore } from "../src/fulfillment-store.js";
import type {
  CenterMaster,
  CoupangUploadJob,
  DownloadedOrderFile,
  FulfillmentCarton,
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
  ShipmentGroup,
  ShipmentTrackingResult,
  ShippingJob,
  SupplierHubFulfillmentPort,
} from "../src/fulfillment-types.js";
import { FulfillmentWorkflow } from "../src/fulfillment-workflow.js";
import { writeOrderEvidenceWorkbook } from "./helpers/order-evidence.js";

const NOW = new Date("2026-08-01T00:00:00.000Z");
const SINDOH = "SINDOH N600";
const ALLLIVE = "AllLive OLIVE-308B";

const ORDERS: FulfillmentOrder[] = [
  order("PO-001", "FC-A", "2026-08-10", "SKU-A", 20, 10),
  order("PO-002", "FC-A", "2026-08-10", "SKU-B", 15, 5),
  order("PO-003", "FC-B", "2026-08-11", "SKU-A", 20, 10),
  order("PO-004", "FC-C", "2026-08-12", "SKU-B", 15, 5),
  order("PO-005", "FC-D", "2026-08-13", "SKU-A", 20, 10),
  order("PO-006", "FC-E", "2026-08-14", "SKU-B", 10, 5),
];

const openStores: FulfillmentStore[] = [];

afterEach(() => {
  while (openStores.length > 0) openStores.pop()!.close();
});

describe("integrated fulfillment v2 planning", () => {
  it("plans 6 POs and 2 SKUs into 6 batches, 14 cartons, and 6 per-PO shipments", () => {
    const planned = planFulfillment({ runId: "RUN-001", orders: ORDERS });
    const batches: LogenBatch[] = planned.batches;
    const cartons: FulfillmentCarton[] = planned.cartons;
    const shipmentGroups: ShipmentGroup[] = planned.shipmentGroups;

    expect(new Set(batches.map((batch) => batch.skuCode))).toEqual(
      new Set(["SKU-A", "SKU-B"]),
    );
    expect(batches).toHaveLength(6);
    expect(batches.reduce((sum, batch) => sum + batch.cartonCount, 0)).toBe(14);
    expect(cartons).toHaveLength(14);
    expect(shipmentGroups).toHaveLength(6);

    expect(shipmentGroups.every((group) => group.orderNos.length === 1)).toBe(true);
    expect(shipmentGroups.find((group) => group.orderNos[0] === "PO-001")?.id).toContain(
      "PO-001",
    );
    expect(shipmentGroups.find((group) => group.orderNos[0] === "PO-002")?.id).toContain(
      "PO-002",
    );
    expect(
      shipmentGroups.flatMap((group) => group.orderNos).sort(),
    ).toEqual(["PO-001", "PO-002", "PO-003", "PO-004", "PO-005", "PO-006"]);
  });

  it("keeps each PO+SKU fixTakeNo stable across run IDs and input ordering", () => {
    const first = planFulfillment({ runId: "RUN-FIRST", orders: ORDERS });
    const repeated = planFulfillment({
      runId: "RUN-REPEATED",
      orders: [...ORDERS].reverse(),
    });

    const firstByOrderSku = new Map(
      first.batches.map((batch) => [`${batch.orderNo}|${batch.skuCode}`, batch.fixTakeNo]),
    );
    const repeatedByOrderSku = new Map(
      repeated.batches.map((batch) => [`${batch.orderNo}|${batch.skuCode}`, batch.fixTakeNo]),
    );

    expect(repeatedByOrderSku).toEqual(firstByOrderSku);
    expect(new Set(firstByOrderSku.values()).size).toBe(6);
  });

  it("keeps demo shipments separate by PO even when FC and EDD are identical", async () => {
    const adapter = new DemoSupplierHubShipmentAdapter();
    await adapter.uploadTrackingWorkbook({
      fileName: "shipment.xlsx",
      filePath: "test://shipment.xlsx",
      expectedInboundDate: "2026-08-10",
      shipDate: "2026-08-08",
      shipTime: "09:00",
      expectedGroupCount: 2,
      shipmentGroups: [
        {
          orderNo: "PO-001",
          centerCode: "FC-A",
          expectedInboundDate: "2026-08-10",
        },
        {
          orderNo: "PO-002",
          centerCode: "FC-A",
          expectedInboundDate: "2026-08-10",
        },
      ],
    });

    const all = await adapter.listShipmentSummaries("2026-08-10");
    expect(all).toHaveLength(2);
    expect(new Set(all.map((shipment) => shipment.orderNo))).toEqual(
      new Set(["PO-001", "PO-002"]),
    );
    expect(new Set(all.map((shipment) => shipment.shipmentId)).size).toBe(2);

    const filtered = await adapter.listShipmentSummaries("2026-08-10", ["PO-002"]);
    expect(filtered).toEqual([expect.objectContaining({ orderNo: "PO-002" })]);
  });

  it("persists the planned batches, cartons, shipment groups, and stage-10 upload jobs", () => {
    const store = memoryStore();
    const scan = store.saveScan(ORDERS, 30, NOW.toISOString());
    store.compareAndRecordNewOrders(scan.id, NOW.toISOString());
    const run = store.createRun(scan.id, undefined, NOW.toISOString());
    const planned = planFulfillment({ runId: run.id, orders: run.orders });

    store.saveLogenBatches(planned.batches);
    store.saveFulfillmentCartons(planned.cartons);
    store.saveShipmentGroups(planned.shipmentGroups);

    const uploadJobs: CoupangUploadJob[] = planned.shipmentGroups.map((group, index) => ({
      id: `UPLOAD-${index + 1}`,
      runId: run.id,
      shipmentGroupId: group.id,
      fileName: `${group.id}.xlsx`,
      filePath: `test://${run.id}/${group.id}.xlsx`,
      shipDate: chooseAutomaticShipDate(
        group.expectedInboundDate,
        eligibleShipDates(group.expectedInboundDate)[0],
      )!,
      shipTime: "09:00",
      status: "prepared",
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    }));
    store.saveCoupangUploadJobs(uploadJobs);

    const loaded = store.getRun(run.id);
    expect(loaded.logenBatches).toHaveLength(6);
    expect(
      loaded.logenBatches?.flatMap((batch) => store.getFulfillmentCartons(batch.id)),
    ).toHaveLength(14);
    expect(loaded.shipmentGroups).toHaveLength(6);
    expect(loaded.coupangUploadJobs).toHaveLength(6);
  });

  it("offers only EDD D-3 through D-1 and selects today only inside that window", () => {
    expect(eligibleShipDates("2026-08-10")).toEqual([
      "2026-08-07",
      "2026-08-08",
      "2026-08-09",
    ]);
    expect(chooseAutomaticShipDate("2026-08-10", "2026-08-01")).toBeUndefined();
    expect(chooseAutomaticShipDate("2026-08-10", "2026-08-08")).toBe("2026-08-08");
    expect(chooseAutomaticShipDate("2026-08-10", "2026-08-09")).toBe("2026-08-09");
    expect(chooseAutomaticShipDate("2026-08-10", "2026-08-10")).toBeUndefined();
  });
});

describe("integrated fulfillment v2 execution", () => {
  it("blocks stage 11 until stage 10 completes", async () => {
    expect(() => assertStage11Ready("confirmed")).not.toThrow();
    expect(() => assertStage11Ready("prepared")).toThrow();
    expect(() => assertStage11Ready("uploaded")).toThrow();

    const harness = makeHarness();
    const runId = await prepareThroughWaybills(harness);

    const premature = await harness.workflow.printSupplierHubShipmentDocuments({ runId });
    expect(premature.status).toBe("blocked");
    expect(harness.supplierHub.documentCalls).toHaveLength(0);
    expect(harness.printer.calls.filter((call) => call.kind === "shipment")).toHaveLength(0);

    const stage10 = await harness.workflow.registerSupplierHubShipmentTracking({ runId });
    expect(stage10.status, stage10.message).toBe("completed");
    const stage11 = await harness.workflow.printSupplierHubShipmentDocuments({ runId });
    expect(stage11.status).toBe("completed");
  });

  it("does not duplicate Logen, upload, or print side effects in the same run", async () => {
    const harness = makeHarness();
    const runId = await prepareThroughWaybills(harness);
    await harness.workflow.registerSupplierHubShipmentTracking({ runId });
    await harness.workflow.printSupplierHubShipmentDocuments({ runId });

    const callsAfterFirstRun = externalCallCounts(harness);

    await harness.workflow.printOrderFiles({ runId });
    await harness.workflow.registerLogenDeliveryOrder({ runId, dataSource: "order_file" });
    await harness.workflow.printLogenWaybill({ runId });
    await harness.workflow.registerSupplierHubShipmentTracking({ runId });
    await harness.workflow.printSupplierHubShipmentDocuments({ runId });

    expect(externalCallCounts(harness)).toEqual(callsAfterFirstRun);
  });

  it("routes order and shipment documents to SINDOH and waybills to shared AllLive", async () => {
    const harness = makeHarness();
    const runId = await prepareThroughWaybills(harness);
    await harness.workflow.registerSupplierHubShipmentTracking({ runId });
    await harness.workflow.printSupplierHubShipmentDocuments({ runId });

    expect(harness.logen.waybillCalls).toHaveLength(1);
    expect(harness.logen.waybillCalls[0].printerName).toBe(ALLLIVE);
    expect(harness.printer.calls.length).toBeGreaterThan(0);
    expect(harness.printer.calls.every((call) => call.printerName === SINDOH)).toBe(true);
    expect(new Set(harness.printer.calls.map((call) => call.kind))).toEqual(
      new Set(["order", "shipment"]),
    );
  });
});

interface Harness {
  store: FulfillmentStore;
  supplierHub: RecordingSupplierHub;
  logen: RecordingLogen;
  printer: RecordingPrinter;
  workflow: FulfillmentWorkflow;
}

class RecordingSupplierHub implements SupplierHubFulfillmentPort {
  trackingCalls: Array<{ orderNo: string; slipNos: string[] }> = [];
  documentCalls: Array<{ orderNo: string; shipmentId?: string }> = [];

  async open(): Promise<FulfillmentConnectionResult> {
    return { status: "ready", message: "ready" };
  }

  async listOrders(_lookAheadDays: 7 | 30): Promise<FulfillmentOrderListResult> {
    return {
      connection: { status: "ready", message: "ready" },
      orders: structuredClone(ORDERS),
    };
  }

  async downloadOrderFiles(
    runId: string,
    orders: FulfillmentOrder[],
  ): Promise<DownloadedOrderFile[]> {
    return orders.map((item) => ({
      orderNo: item.orderNo,
      ...writeOrderEvidenceWorkbook(item),
      items: structuredClone(item.items),
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
      message: "uploaded",
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

class RecordingLogen implements LogenPort, LogenBatchPort {
  registerCalls: LogenBatch[][] = [];
  waybillCalls: Array<{ batches: LogenBatch[]; printerName: string }> = [];

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

class RecordingPrinter implements FulfillmentPrinterPort {
  calls: Array<{
    files: Array<{ fileName: string; filePath: string }>;
    printerName: string;
    copies: number;
    kind: "order" | "shipment";
  }> = [];

  async print(input: {
    files: Array<{ fileName: string; filePath: string }>;
    printerName: string;
    copies: number;
    kind: "order" | "shipment";
  }): Promise<PrintSubmission> {
    this.calls.push(structuredClone(input));
    return {
      success: true,
      status: "submitted",
      submittedFiles: input.files.map((file) => file.fileName),
      message: "submitted",
    };
  }
}

function order(
  orderNo: string,
  centerCode: string,
  expectedInboundDate: string,
  skuCode: "SKU-A" | "SKU-B",
  orderedQuantity: number,
  unitsPerCarton: number,
): FulfillmentOrder {
  return {
    orderNo,
    centerCode,
    centerName: centerCode,
    status: "발주확정",
    transportType: "쉽먼트",
    createdAt: "2026-08-01T09:00:00+09:00",
    expectedInboundDate,
    items: [
      {
        skuCode,
        skuName: skuCode === "SKU-A" ? "상품 A" : "상품 B",
        orderedQuantity,
        unitsPerCarton,
        source: "order_file",
      },
    ],
  };
}

function memoryStore(): FulfillmentStore {
  const store = new FulfillmentStore(":memory:");
  openStores.push(store);
  return store;
}

function makeHarness(): Harness {
  const store = memoryStore();
  seedRouting(store);
  const supplierHub = new RecordingSupplierHub();
  const logen = new RecordingLogen();
  const printer = new RecordingPrinter();
  const workflow = new FulfillmentWorkflow(
    store,
    { supplierHub, logen, printer },
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
  for (const centerCode of ["FC-A", "FC-B", "FC-C", "FC-D", "FC-E"]) {
    store.upsertCenterMaster({
      centerCode,
      centerName: centerCode,
      recipientName: `${centerCode} 입고 담당`,
      address: `경기도 ${centerCode} 테스트로 1`,
      telephone: "031-111-1111",
      source: "backend",
      updatedAt: NOW.toISOString(),
    });
  }
}

async function prepareThroughWaybills(harness: Harness): Promise<string> {
  const listed = await harness.workflow.listPrivateLabelOrders({ lookAheadDays: 30 });
  await harness.workflow.compareNewOrders({ scanId: listed.scanId! });
  const selected = await harness.workflow.selectOrdersForPrint({ scanId: listed.scanId! });
  const runId = selected.runId!;
  await harness.workflow.downloadOrderFiles({ runId });
  await harness.workflow.printOrderFiles({ runId });
  await harness.workflow.recordPrintResult({ runId });
  const registered = await harness.workflow.registerLogenDeliveryOrder({
    runId,
    dataSource: "order_file",
  });
  expect(registered.status, registered.message).toBe("completed");
  const waybills = await harness.workflow.printLogenWaybill({ runId });
  expect(waybills.status, waybills.message).toBe("completed");
  return runId;
}

function externalCallCounts(harness: Harness) {
  return {
    logenRegistrations: harness.logen.registerCalls.length,
    logenPrints: harness.logen.waybillCalls.length,
    uploads: harness.supplierHub.trackingCalls.length,
    documentDownloads: harness.supplierHub.documentCalls.length,
    orderPrints: harness.printer.calls.filter((call) => call.kind === "order").length,
    shipmentPrints: harness.printer.calls.filter((call) => call.kind === "shipment").length,
  };
}
