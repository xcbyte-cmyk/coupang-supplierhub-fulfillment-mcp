import { afterEach, describe, expect, it } from "vitest";
import { FulfillmentStore } from "../src/fulfillment-store.js";
import type {
  CenterMaster,
  DownloadedOrderFile,
  FulfillmentConnectionResult,
  FulfillmentOrder,
  FulfillmentOrderQuery,
  FulfillmentOrderListResult,
  FulfillmentPrinterPort,
  LogenBatch,
  LogenBatchPort,
  LogenBatchRegistrationResult,
  LogenBatchWaybillInspectionResult,
  LogenBatchWaybillResult,
  LogenExecutionContext,
  LogenPort,
  LogenRegistrationResult,
  LogenWaybillResult,
  PrintSubmission,
  SenderProfile,
  ShipmentDocumentResult,
  ShipmentTrackingResult,
  ShipmentWorkbookPort,
  ShippingJob,
  SupplierHubFulfillmentPort,
  SupplierHubShipmentPort,
} from "../src/fulfillment-types.js";
import { FulfillmentWorkflow } from "../src/fulfillment-workflow.js";
import { DemoOrderConfirmationWorkbookAdapter } from "../src/order-confirmation-workbook-adapter.js";

const NOW = new Date("2026-08-07T02:00:00.000Z"); // 2026-08-07 11:00 KST
const SINDOH = "SINDOH N600";
const ALLLIVE = "AllLive OLIVE-308B";

const ORDERS: FulfillmentOrder[] = [
  order("PO-001", "FC-A", "2026-08-08", "SKU-A", 20, 10),
  order("PO-002", "FC-A", "2026-08-08", "SKU-B", 15, 5),
  order("PO-003", "FC-B", "2026-08-09", "SKU-A", 20, 10),
  order("PO-004", "FC-C", "2026-08-09", "SKU-B", 15, 5),
  order("PO-005", "FC-D", "2026-08-10", "SKU-A", 20, 10),
  order("PO-006", "FC-E", "2026-08-10", "SKU-B", 10, 5),
];

const openStores: FulfillmentStore[] = [];

afterEach(() => {
  while (openStores.length > 0) openStores.pop()!.close();
});

describe("FulfillmentWorkflow v2", () => {
  it("splits Logen login, single-order screen navigation, and order save into stages 11-13", async () => {
    const harness = makeHarness();
    const runId = createRun(harness.store);

    const login = await harness.workflow.openLogenLogin({
      runId,
      logenMethod: "website_mcp",
    });
    const screen = await harness.workflow.openLogenSingleOrderRegistration({
      runId,
      logenMethod: "website_mcp",
    });
    const saved = await harness.workflow.registerLogenDeliveryOrder({
      runId,
      dataSource: "order_file",
      logenMethod: "website_mcp",
    });

    expect([login.stage, screen.stage, saved.stage]).toEqual([11, 12, 13]);
    expect([login.status, screen.status, saved.status]).toEqual([
      "completed",
      "completed",
      "completed",
    ]);
    expect(harness.logen.loginCalls).toBe(1);
    expect(harness.logen.singleOrderScreenCalls).toBe(1);
    expect(harness.logen.registerCalls).toHaveLength(1);
  });

  it("forwards and persists a custom expected inbound date range in stage 2", async () => {
    const harness = makeHarness();
    const result = await harness.workflow.listPrivateLabelOrders({
      lookAheadDays: 30,
      dateSearchType: "order_date",
      dateFrom: "2026-08-08",
      dateTo: "2026-08-10",
    });

    expect(result.status).toBe("completed");
    expect(harness.supplierHub.lastOrderQuery).toMatchObject({
      lookAheadDays: 30,
      dateSearchType: "order_date",
      dateFrom: "2026-08-08",
      dateTo: "2026-08-10",
    });
    expect(harness.store.getScan(result.scanId!)).toMatchObject({
      dateSearchType: "order_date",
      dateFrom: "2026-08-08",
      dateTo: "2026-08-10",
    });
  });

  it("runs stages 11-14 through batch Logen and per-order shipment ports", async () => {
    const harness = makeHarness();
    const runId = createRun(harness.store);

    const stage8 = await harness.workflow.registerLogenDeliveryOrder({
      runId,
      dataSource: "order_file",
    });
    const stage9 = await harness.workflow.printLogenWaybill({ runId });
    const stage10 = await harness.workflow.registerSupplierHubShipmentTracking({ runId });
    const stage11 = await harness.workflow.printSupplierHubShipmentDocuments({ runId });

    expect([stage8.status, stage9.status, stage10.status, stage11.status]).toEqual([
      "completed",
      "completed",
      "completed",
      "completed",
    ]);

    const run = harness.store.getRun(runId);
    expect(run.logenBatches).toHaveLength(6);
    expect(run.cartons).toHaveLength(14);
    expect(run.shipmentGroups).toHaveLength(6);
    expect(run.coupangUploadJobs).toHaveLength(1);
    expect(run.coupangUploadJobs?.[0]).toMatchObject({ status: "confirmed" });

    const slipNos = run.cartons?.map((carton) => carton.slipNo).filter(Boolean) ?? [];
    expect(slipNos).toHaveLength(14);
    expect(new Set(slipNos).size).toBe(14);
    expect(run.shipmentGroups?.every((group) => group.status === "completed")).toBe(true);

    expect(harness.logen.registerCalls).toHaveLength(1);
    expect(harness.logen.registerCalls[0]).toHaveLength(6);
    expect(new Set(harness.logen.registerCalls[0].map((batch) => batch.fixTakeNo)).size).toBe(6);
    expect(harness.logen.waybillCalls).toHaveLength(1);
    expect(harness.logen.waybillCalls[0]).toMatchObject({ printerName: ALLLIVE });
    expect(
      harness.logen.waybillCalls[0].batches.reduce(
        (sum, batch) => sum + batch.cartonCount,
        0,
      ),
    ).toBe(14);

    expect(harness.workbook.calls).toHaveLength(1);
    expect(harness.workbook.calls[0].batches).toHaveLength(6);
    expect(harness.workbook.calls[0].cartons).toHaveLength(14);
    expect(harness.shipmentHub.uploadCalls).toHaveLength(1);
    expect(harness.shipmentHub.uploadCalls[0].expectedGroupCount).toBe(6);
    expect(harness.shipmentHub.documentCalls).toHaveLength(6);
    expect(harness.printer.calls).toHaveLength(6);
    expect(
      harness.printer.calls.every(
        (call) =>
          call.kind === "shipment" &&
          call.printerName === SINDOH &&
          call.files.length === 2,
      ),
    ).toBe(true);

    expect(harness.supplierHub.legacyTrackingCalls).toBe(0);
    expect(harness.supplierHub.legacyDocumentCalls).toBe(0);
  });

  it("does not repeat registration, upload, waybill, or document side effects", async () => {
    const harness = makeHarness();
    const runId = createRun(harness.store);

    await harness.workflow.registerLogenDeliveryOrder({ runId, dataSource: "order_file" });
    await harness.workflow.printLogenWaybill({ runId });
    await harness.workflow.registerSupplierHubShipmentTracking({ runId });
    await harness.workflow.printSupplierHubShipmentDocuments({ runId });
    const firstCounts = sideEffectCounts(harness);

    const stage8 = await harness.workflow.registerLogenDeliveryOrder({
      runId,
      dataSource: "order_file",
    });
    const stage9 = await harness.workflow.printLogenWaybill({ runId });
    const stage10 = await harness.workflow.registerSupplierHubShipmentTracking({ runId });
    const stage11 = await harness.workflow.printSupplierHubShipmentDocuments({ runId });

    expect([stage8.status, stage9.status, stage10.status, stage11.status]).toEqual([
      "completed",
      "completed",
      "completed",
      "completed",
    ]);
    expect(sideEffectCounts(harness)).toEqual(firstCounts);
  });

  it("hands the shared Supplier Hub profile from order stages to shipment stages", async () => {
    const harness = makeHarness();
    const runId = createRunWithOrders(harness.store, [ORDERS[0]]);
    await harness.workflow.registerLogenDeliveryOrder({ runId, dataSource: "order_file" });
    await harness.workflow.printLogenWaybill({ runId });

    await harness.workflow.registerSupplierHubShipmentTracking({ runId });
    expect(harness.supplierHub.closeCalls).toBeGreaterThan(0);
    await harness.workflow.printSupplierHubShipmentDocuments({ runId });
    expect(harness.shipmentHub.closeCalls).toBeGreaterThan(0);
  });

  it("uploads eligible per-order shipments while leaving future orders blocked", async () => {
    const harness = makeHarness();
    const runId = createRunWithOrders(harness.store, [
      ORDERS[0],
      order("PO-FUTURE", "FC-B", "2026-08-20", "SKU-A", 20, 10),
    ]);

    await harness.workflow.registerLogenDeliveryOrder({ runId, dataSource: "order_file" });
    await harness.workflow.printLogenWaybill({ runId });
    const stage10 = await harness.workflow.registerSupplierHubShipmentTracking({ runId });

    expect(stage10.status).toBe("partial");
    expect(harness.shipmentHub.uploadCalls).toHaveLength(1);
    expect(harness.shipmentHub.uploadCalls[0].shipmentGroups).toEqual([
      { orderNo: "PO-001", centerCode: "FC-A", expectedInboundDate: "2026-08-08" },
    ]);
    expect(harness.workbook.calls[0].batches.map((batch) => batch.orderNo)).toEqual([
      "PO-001",
    ]);
    expect(
      harness.store
        .getShipmentGroups(runId)
        .find((group) => group.expectedInboundDate === "2026-08-20"),
    ).toMatchObject({ status: "blocked" });
  });

  it("resumes a previously blocked future shipment group without rediscovering the PO", async () => {
    const harness = makeHarness();
    const resumeOrders = [
      ORDERS[0],
      order("PO-FUTURE", "FC-B", "2026-08-20", "SKU-A", 20, 10),
    ];
    harness.supplierHub.orders = resumeOrders;
    let current = NOW;
    const workflow = new FulfillmentWorkflow(
      harness.store,
      {
        supplierHub: harness.supplierHub,
        confirmationWorkbook: new DemoOrderConfirmationWorkbookAdapter(),
        logen: harness.logen,
        printer: harness.printer,
        shipmentHub: harness.shipmentHub,
        shipmentWorkbook: harness.workbook,
      },
      {
        orderPrinterName: SINDOH,
        waybillPrinterName: ALLLIVE,
        shipmentPrinterName: SINDOH,
        copies: 1,
        shipTime: "09:30",
        shipmentDocumentsDir: "test://shipment-documents",
      },
      () => current,
    );
    const runId = createRunWithOrders(harness.store, resumeOrders);
    await workflow.registerLogenDeliveryOrder({ runId, dataSource: "order_file" });
    await workflow.printLogenWaybill({ runId });
    expect((await workflow.registerSupplierHubShipmentTracking({ runId })).status).toBe(
      "partial",
    );
    expect((await workflow.printSupplierHubShipmentDocuments({ runId })).status).toBe(
      "partial",
    );

    current = new Date("2026-08-17T02:00:00.000Z");
    const resumed = await workflow.runFulfillmentWorkflow({
      lookAheadDays: 30,
      dataSource: "order_file",
    });

    expect(resumed).toMatchObject({ id: runId, status: "completed", currentStage: 14 });
    expect(harness.shipmentHub.uploadCalls).toHaveLength(2);
    expect(harness.workbook.calls).toHaveLength(2);
    expect(
      harness.store.getShipmentGroups(runId).every((group) => group.status === "completed"),
    ).toBe(true);
  });

  it("reuses a confirmed upload on a later day when shipment mapping was delayed", async () => {
    const harness = makeHarness();
    let current = NOW;
    const workflow = new FulfillmentWorkflow(
      harness.store,
      {
        supplierHub: harness.supplierHub,
        confirmationWorkbook: new DemoOrderConfirmationWorkbookAdapter(),
        logen: harness.logen,
        printer: harness.printer,
        shipmentHub: harness.shipmentHub,
        shipmentWorkbook: harness.workbook,
      },
      {
        orderPrinterName: SINDOH,
        waybillPrinterName: ALLLIVE,
        shipmentPrinterName: SINDOH,
        copies: 1,
        shipTime: "09:30",
      },
      () => current,
    );
    const runId = createRunWithOrders(harness.store, [ORDERS[4]]);
    await workflow.registerLogenDeliveryOrder({ runId, dataSource: "order_file" });
    await workflow.printLogenWaybill({ runId });
    harness.shipmentHub.hideSummaries = true;

    const delayed = await workflow.registerSupplierHubShipmentTracking({ runId });
    expect(delayed.status).toBe("unknown");
    expect(harness.store.getShipmentGroups(runId)[0]).toMatchObject({ status: "created" });
    expect(harness.shipmentHub.uploadCalls).toHaveLength(1);

    current = new Date("2026-08-08T02:00:00.000Z");
    harness.shipmentHub.hideSummaries = false;
    const mapped = await workflow.registerSupplierHubShipmentTracking({ runId });

    expect(mapped.status).toBe("completed");
    expect(harness.shipmentHub.uploadCalls).toHaveLength(1);
    expect(harness.workbook.calls).toHaveLength(1);
  });

  it("does not reupload the remaining group from a partially mapped confirmed workbook", async () => {
    const harness = makeHarness();
    const runId = createRunWithOrders(harness.store, [ORDERS[0], ORDERS[2]]);
    await harness.workflow.registerLogenDeliveryOrder({ runId, dataSource: "order_file" });
    await harness.workflow.printLogenWaybill({ runId });
    harness.shipmentHub.hiddenSummaryKeys.add("FC-B|2026-08-09");

    const partial = await harness.workflow.registerSupplierHubShipmentTracking({ runId });
    expect(partial.status).toBe("partial");
    expect(harness.shipmentHub.uploadCalls).toHaveLength(1);
    expect(harness.store.getCoupangUploadJobs(runId)[0].shipmentGroupIds).toHaveLength(2);

    harness.shipmentHub.hiddenSummaryKeys.clear();
    const completed = await harness.workflow.registerSupplierHubShipmentTracking({ runId });

    expect(completed.status).toBe("completed");
    expect(harness.shipmentHub.uploadCalls).toHaveLength(1);
    expect(harness.workbook.calls).toHaveLength(1);
  });

  it("keeps an in-flight shipment upload unknown and never auto-resubmits it", async () => {
    const harness = makeHarness();
    const runId = createRunWithOrders(harness.store, [ORDERS[0]]);
    await harness.workflow.registerLogenDeliveryOrder({ runId, dataSource: "order_file" });
    await harness.workflow.printLogenWaybill({ runId });
    harness.shipmentHub.throwAfterUpload = true;

    const first = await harness.workflow.registerSupplierHubShipmentTracking({ runId });
    const repeated = await harness.workflow.registerSupplierHubShipmentTracking({ runId });

    expect(first.status).toBe("unknown");
    expect(repeated.status).toBe("unknown");
    expect(harness.shipmentHub.uploadCalls).toHaveLength(1);
    expect(harness.shipmentHub.closeCalls).toBeGreaterThan(0);
    expect(harness.store.getCoupangUploadJobs(runId)[0]).toMatchObject({ status: "unknown" });
  });

  it("keeps an in-flight shipment document print unknown and never auto-reprints it", async () => {
    const harness = makeHarness();
    const runId = createRunWithOrders(harness.store, [ORDERS[0]]);
    await harness.workflow.registerLogenDeliveryOrder({ runId, dataSource: "order_file" });
    await harness.workflow.printLogenWaybill({ runId });
    await harness.workflow.registerSupplierHubShipmentTracking({ runId });
    harness.printer.throwAfterSubmission = true;

    const first = await harness.workflow.printSupplierHubShipmentDocuments({ runId });
    const repeated = await harness.workflow.printSupplierHubShipmentDocuments({ runId });

    expect(first.status).toBe("unknown");
    expect(repeated.status).toBe("unknown");
    expect(harness.printer.calls).toHaveLength(1);
    expect(harness.store.getShipmentGroups(runId)[0]).toMatchObject({ status: "unknown" });
  });

  it("keeps an indivisible SKU blocked after the good SKU shipment documents print", async () => {
    const harness = makeHarness();
    const mixedOrder: FulfillmentOrder = {
      ...order("PO-MIXED", "FC-A", "2026-08-08", "SKU-A", 20, 10),
      items: [
        {
          skuCode: "SKU-A",
          skuName: "정상 상품",
          orderedQuantity: 20,
          unitsPerCarton: 10,
          source: "order_file",
        },
        {
          skuCode: "SKU-B",
          skuName: "나머지 발생 상품",
          orderedQuantity: 25,
          unitsPerCarton: 10,
          source: "order_file",
        },
      ],
    };
    const runId = createRunWithOrders(harness.store, [mixedOrder]);

    expect(
      (await harness.workflow.registerLogenDeliveryOrder({ runId, dataSource: "order_file" }))
        .status,
    ).toBe("partial");
    await harness.workflow.printLogenWaybill({ runId });
    await harness.workflow.registerSupplierHubShipmentTracking({ runId });
    const stage11 = await harness.workflow.printSupplierHubShipmentDocuments({ runId });

    expect(stage11.status).toBe("partial");
    expect(
      harness.store.getLogenBatches(runId).find((batch) => batch.skuCode === "SKU-B"),
    ).toMatchObject({ status: "blocked", cartonCount: 0 });
    expect(
      harness.store.getLogenBatches(runId).find((batch) => batch.skuCode === "SKU-A"),
    ).toMatchObject({ status: "completed" });
  });

  it("blocks aggregate live execution until calibration is explicitly completed", async () => {
    const harness = makeHarness();
    const liveCalibration = new FulfillmentWorkflow(
      harness.store,
      {
        supplierHub: harness.supplierHub,
        confirmationWorkbook: new DemoOrderConfirmationWorkbookAdapter(),
        logen: harness.logen,
        printer: harness.printer,
        shipmentHub: harness.shipmentHub,
        shipmentWorkbook: harness.workbook,
      },
      {
        orderPrinterName: SINDOH,
        waybillPrinterName: ALLLIVE,
        shipmentPrinterName: SINDOH,
        copies: 1,
        modeReader: () => "live",
        operationModeReader: () => "calibration",
      },
      () => NOW,
    );

    const result = await liveCalibration.runFulfillmentWorkflow({
      lookAheadDays: 30,
      dataSource: "order_file",
    });

    expect(result).toMatchObject({ stage: 1, status: "blocked" });
    expect(result.message).toContain("calibration");
    expect(harness.logen.registerCalls).toHaveLength(0);
  });

  it("serializes destructive stages so concurrent upload calls cannot duplicate", async () => {
    const harness = makeHarness();
    const runId = createRun(harness.store);
    await harness.workflow.registerLogenDeliveryOrder({ runId, dataSource: "order_file" });
    await harness.workflow.printLogenWaybill({ runId });

    let releaseUpload!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseUpload = resolve;
    });
    let signalStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    harness.shipmentHub.uploadGate = gate;
    harness.shipmentHub.uploadStarted = signalStarted;

    const first = harness.workflow.registerSupplierHubShipmentTracking({ runId });
    await started;
    const concurrent = await harness.workflow.registerSupplierHubShipmentTracking({ runId });
    releaseUpload();
    const completed = await first;

    expect(completed.status).toBe("completed");
    expect(concurrent.status).toBe("blocked");
    expect(concurrent.message).toContain("중복 제출 방지");
    expect(harness.shipmentHub.uploadCalls).toHaveLength(1);
  });

  it("preserves unknown Logen registration as an unknown stage result", async () => {
    const harness = makeHarness();
    harness.logen.registrationOutcome = "unknown";
    const runId = createRunWithOrders(harness.store, [ORDERS[0]]);

    const result = await harness.workflow.registerLogenDeliveryOrder({
      runId,
      dataSource: "order_file",
    });

    expect(result.status, result.message).toBe("unknown");
    expect(harness.store.getLogenBatches(runId)[0]).toMatchObject({ status: "unknown" });
  });

  it("keeps an in-flight Logen registration unknown and never auto-registers it again", async () => {
    const harness = makeHarness();
    harness.logen.throwAfterRegistration = true;
    const runId = createRunWithOrders(harness.store, [ORDERS[0]]);

    const first = await harness.workflow.registerLogenDeliveryOrder({
      runId,
      dataSource: "order_file",
    });
    const second = await harness.workflow.registerLogenDeliveryOrder({
      runId,
      dataSource: "order_file",
    });

    expect(first.status).toBe("failed");
    expect(second.status).toBe("unknown");
    expect(harness.logen.registerCalls).toHaveLength(1);
    expect(harness.store.getLogenBatches(runId)[0]).toMatchObject({ status: "unknown" });
  });

  it("keeps an in-flight Logen waybill print unknown and never auto-prints it again", async () => {
    const harness = makeHarness();
    const runId = createRunWithOrders(harness.store, [ORDERS[0]]);
    await harness.workflow.registerLogenDeliveryOrder({
      runId,
      dataSource: "order_file",
    });
    harness.logen.throwAfterWaybill = true;

    const first = await harness.workflow.printLogenWaybill({ runId });
    const second = await harness.workflow.printLogenWaybill({ runId });

    expect(first.status).toBe("failed");
    expect(second.status).toBe("unknown");
    expect(harness.logen.waybillCalls).toHaveLength(1);
    expect(harness.store.getLogenBatches(runId)[0]).toMatchObject({
      status: "registered",
      waybillStatus: "in_flight",
    });
  });

  it("keeps stage-13 registration identity when stage 14 fails before printing", async () => {
    const harness = makeHarness();
    const runId = createRunWithOrders(harness.store, [ORDERS[0]]);
    await harness.workflow.registerLogenDeliveryOrder({
      runId,
      dataSource: "order_file",
    });
    const registered = harness.store.getLogenBatches(runId)[0];
    expect(registered).toMatchObject({
      status: "registered",
      registrationKeys: [
        `LOGEN-${registered.orderNo}-${registered.skuCode}-1`,
        `LOGEN-${registered.orderNo}-${registered.skuCode}-2`,
      ],
    });
    harness.logen.waybillPreflightFailure = true;

    const result = await harness.workflow.printLogenWaybill({ runId });

    expect(result.status).toBe("blocked");
    expect(harness.logen.inspectionCalls[0][0].registrationKeys).toEqual(
      registered.registrationKeys,
    );
    expect(harness.logen.waybillCalls[0].batches[0].registrationKeys).toEqual(
      registered.registrationKeys,
    );
    expect(harness.store.getLogenBatches(runId)[0]).toMatchObject({
      status: "registered",
      waybillStatus: "failed",
      registrationKeys: registered.registrationKeys,
      waybillMessage: "registration screen unavailable before print",
    });
    expect(
      harness.store
        .getShippingJobs(runId)
        .every((job) => job.status === "registered" && job.error === undefined),
    ).toBe(true);
  });

  it("checks saved reservation rows and does not reprint rows already printed", async () => {
    const harness = makeHarness();
    const runId = createRunWithOrders(harness.store, [ORDERS[0]]);
    await harness.workflow.registerLogenDeliveryOrder({
      runId,
      dataSource: "order_file",
    });
    const registered = harness.store.getLogenBatches(runId)[0];
    harness.logen.inspectionState = "printed";

    const result = await harness.workflow.printLogenWaybill({ runId });

    expect(result.status).toBe("unknown");
    expect(harness.logen.waybillCalls).toHaveLength(0);
    expect(harness.store.getLogenBatches(runId)[0]).toMatchObject({
      status: "registered",
      registrationKeys: registered.registrationKeys,
      waybillStatus: "unknown",
    });
  });

  it("reconciles a legacy saved registration before printing without rerunning stage 13", async () => {
    const harness = makeHarness();
    harness.logen.registrationOutcome = "unknown";
    const runId = createRunWithOrders(harness.store, [ORDERS[0]]);
    await harness.workflow.registerLogenDeliveryOrder({
      runId,
      dataSource: "order_file",
    });
    const batch = harness.store.getLogenBatches(runId)[0];
    const jobs = harness.store.getShippingJobs(runId);
    harness.store.saveStageResult({
      runId,
      stage: 15,
      status: "unknown",
      message: "legacy evidence",
      items: jobs.map((job) => ({
        ...job,
        error:
          "저장은 완료됐지만 새 예약행을 하나로 확정하지 못했습니다. 키 후보 6개, 수량 6/2.",
      })),
      updatedAt: NOW.toISOString(),
    });
    harness.store.updateLogenBatch(batch.id, {
      status: "failed",
      message: "로젠 주문등록 메뉴를 하나로 식별하지 못했습니다. 표시된 후보: 0개",
      waybillStatus: "not_started",
      updatedAt: NOW.toISOString(),
    });
    for (const job of jobs) {
      harness.store.updateShippingJob(job.id, { status: "ready", error: undefined });
    }
    const registrationCalls = harness.logen.registerCalls.length;

    const result = await harness.workflow.printLogenWaybill({ runId });

    expect(result.status, result.message).toBe("unknown");
    expect(harness.logen.registerCalls).toHaveLength(registrationCalls);
    expect(harness.logen.waybillCalls).toHaveLength(1);
    expect(harness.logen.waybillCalls[0].batches[0]).toMatchObject({
      status: "registered",
      registrationKeys: [
        `RECOVERED-${batch.id}-1`,
        `RECOVERED-${batch.id}-2`,
      ],
      waybillStatus: "not_started",
    });
  });

  it("does not silently replace PO+SKU registration with legacy carton orders", async () => {
    const harness = makeHarness();
    let legacyRegistrationCalls = 0;
    const legacyOnlyLogen: LogenPort = {
      async registerOrders(jobs) {
        legacyRegistrationCalls += 1;
        return jobs.map((job) => ({
          shippingJobId: job.id,
          fixTakeNo: job.fixTakeNo,
          success: true,
          message: "legacy",
        }));
      },
      async printWaybills() {
        return [];
      },
    };
    const workflow = new FulfillmentWorkflow(
      harness.store,
      {
        supplierHub: harness.supplierHub,
        confirmationWorkbook: new DemoOrderConfirmationWorkbookAdapter(),
        logen: legacyOnlyLogen,
        printer: harness.printer,
      },
      {
        orderPrinterName: SINDOH,
        waybillPrinterName: ALLLIVE,
        shipmentPrinterName: SINDOH,
        copies: 1,
      },
      () => NOW,
    );
    const runId = createRunWithOrders(harness.store, [ORDERS[0]]);

    const result = await workflow.registerLogenDeliveryOrder({
      runId,
      dataSource: "order_file",
    });

    expect(result.status).toBe("blocked");
    expect(harness.store.getLogenBatches(runId)[0].message).toContain(
      "카톤별 주문으로 대체하지 않았습니다",
    );
    expect(legacyRegistrationCalls).toBe(0);
  });

  it("blocks live waybill printing when the exact shared printer was not discovered", async () => {
    const harness = makeHarness();
    const runId = createRunWithOrders(harness.store, [ORDERS[0]]);
    await harness.workflow.registerLogenDeliveryOrder({ runId, dataSource: "order_file" });
    const liveWithPrinterFailure = new FulfillmentWorkflow(
      harness.store,
      {
        supplierHub: harness.supplierHub,
        confirmationWorkbook: new DemoOrderConfirmationWorkbookAdapter(),
        logen: harness.logen,
        printer: harness.printer,
        shipmentHub: harness.shipmentHub,
        shipmentWorkbook: harness.workbook,
      },
      {
        orderPrinterName: SINDOH,
        waybillPrinterName: ALLLIVE,
        shipmentPrinterName: SINDOH,
        copies: 1,
        modeReader: () => "live",
        waybillPrinterDiscoveryError: "정확한 공유 프린터를 확인하지 못했습니다.",
      },
      () => NOW,
    );

    const result = await liveWithPrinterFailure.printLogenWaybill({ runId });

    expect(result.status).toBe("blocked");
    expect(result.message).toContain("정확한 공유 프린터");
    expect(harness.logen.waybillCalls).toHaveLength(0);
  });

  it("blocks demo sender master data from a live Logen registration", async () => {
    const harness = makeHarness();
    harness.store.setSenderProfile({
      name: "DEMO SENDER",
      address: "demo",
      telephone: "000",
      customerCode: "DEMO0000",
      fareType: "demo",
      deliveryFare: 0,
      updatedAt: NOW.toISOString(),
    });
    const liveWorkflow = new FulfillmentWorkflow(
      harness.store,
      {
        supplierHub: harness.supplierHub,
        confirmationWorkbook: new DemoOrderConfirmationWorkbookAdapter(),
        logen: harness.logen,
        printer: harness.printer,
      },
      {
        orderPrinterName: SINDOH,
        waybillPrinterName: ALLLIVE,
        shipmentPrinterName: SINDOH,
        copies: 1,
        modeReader: () => "live",
      },
      () => NOW,
    );
    const runId = createRunWithOrders(harness.store, [ORDERS[0]]);

    const result = await liveWorkflow.registerLogenDeliveryOrder({
      runId,
      dataSource: "order_file",
    });

    expect(result.status).toBe("blocked");
    expect(result.message).toContain("데모 송하인");
    expect(harness.logen.registerCalls).toHaveLength(0);
  });

  it("binds one Logen integration method to the run", async () => {
    const harness = makeHarness();
    const runId = createRunWithOrders(harness.store, [ORDERS[0]]);

    const registered = await harness.workflow.registerLogenDeliveryOrder({
      runId,
      dataSource: "order_file",
      logenMethod: "website_mcp",
    });
    const mixed = await harness.workflow.printLogenWaybill({
      runId,
      logenMethod: "api",
    });

    expect(registered.status).toBe("completed");
    expect(registered.agent).toBe("logen_agent");
    expect(harness.store.getRun(runId).logenIntegrationMethod).toBe("website_mcp");
    expect(mixed.status).toBe("failed");
    expect(mixed.message).toContain("웹사이트 MCP");
    expect(harness.logen.waybillCalls).toHaveLength(0);
  });

  it("uses a saved center before the order-file center snapshot", async () => {
    const harness = makeHarness();
    const runId = createRunWithOrders(harness.store, [ORDERS[0]]);
    harness.store.saveOrderFileCenter(ORDERS[0].orderNo, {
      centerCode: ORDERS[0].centerCode,
      centerName: "발주서 센터",
      recipientName: "발주서 담당",
      address: "발주서 주소",
      telephone: "02-999-9999",
      source: "order_file",
      updatedAt: NOW.toISOString(),
    });

    const result = await harness.workflow.registerLogenDeliveryOrder({
      runId,
      dataSource: "order_file",
    });

    expect(result.status).toBe("completed");
    expect(harness.logen.centerCalls[0][ORDERS[0].orderNo].address).toBe(
      "경기도 FC-A 테스트로 1",
    );
  });

  it("promotes the order-file center only when no saved center exists", async () => {
    const harness = makeHarness();
    const fallbackOrder = {
      ...ORDERS[0],
      orderNo: "PO-CENTER-FALLBACK",
      centerCode: "FC-NEW",
      centerName: "신규 센터",
    };
    const runId = createRunWithOrders(harness.store, [fallbackOrder]);
    harness.store.saveOrderFileCenter(fallbackOrder.orderNo, {
      centerCode: fallbackOrder.centerCode,
      centerName: fallbackOrder.centerName,
      recipientName: "신규 센터 담당",
      address: "경기도 신규센터로 10",
      telephone: "031-222-2222",
      source: "order_file",
      updatedAt: NOW.toISOString(),
    });

    const result = await harness.workflow.registerLogenDeliveryOrder({
      runId,
      dataSource: "order_file",
    });

    expect(result.status).toBe("completed");
    expect(harness.store.getCenterMaster("FC-NEW")).toMatchObject({
      address: "경기도 신규센터로 10",
      source: "order_file",
    });
    expect(harness.logen.centerCalls[0][fallbackOrder.orderNo].address).toBe(
      "경기도 신규센터로 10",
    );
  });

  it("blocks only the order whose center is absent from storage and the order file", async () => {
    const harness = makeHarness();
    const missingOrder = {
      ...ORDERS[0],
      orderNo: "PO-CENTER-MISSING",
      centerCode: "FC-MISSING",
      centerName: "미등록 센터",
    };
    const runId = createRunWithOrders(harness.store, [ORDERS[0], missingOrder]);

    const result = await harness.workflow.registerLogenDeliveryOrder({
      runId,
      dataSource: "order_file",
    });

    expect(result.status).toBe("partial");
    expect(result.message).toContain("1건은 중단");
    expect(harness.logen.registerCalls).toHaveLength(1);
    expect(harness.logen.registerCalls[0]).toHaveLength(1);
    expect(
      harness.store
        .getLogenBatches(runId)
        .find((batch) => batch.orderNo === missingOrder.orderNo)?.message,
    ).toContain(
      "발주서에서도 확인되지 않았습니다",
    );
  });
});

interface Harness {
  store: FulfillmentStore;
  workflow: FulfillmentWorkflow;
  supplierHub: UnusedLegacySupplierHub;
  logen: RecordingBatchLogen;
  workbook: RecordingShipmentWorkbook;
  shipmentHub: RecordingShipmentHub;
  printer: RecordingPrinter;
}

class UnusedLegacySupplierHub implements SupplierHubFulfillmentPort {
  legacyTrackingCalls = 0;
  legacyDocumentCalls = 0;
  orders: FulfillmentOrder[] = ORDERS;
  closeCalls = 0;
  lastOrderQuery?: FulfillmentOrderQuery;

  async open(): Promise<FulfillmentConnectionResult> {
    return { status: "ready", message: "ready" };
  }

  async listOrders(query: FulfillmentOrderQuery): Promise<FulfillmentOrderListResult> {
    this.lastOrderQuery = query;
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
    _runId: string,
    _orders: FulfillmentOrder[],
  ): Promise<DownloadedOrderFile[]> {
    throw new Error("v2 stages 11-14 must not download legacy order files");
  }

  async registerShipmentTracking(
    orderNo: string,
    slipNos: string[],
  ): Promise<ShipmentTrackingResult> {
    this.legacyTrackingCalls += 1;
    return { orderNo, slipNos, success: true, message: "legacy" };
  }

  async getShipmentDocuments(
    orderNo: string,
    shipmentId?: string,
  ): Promise<ShipmentDocumentResult> {
    this.legacyDocumentCalls += 1;
    return {
      orderNo,
      shipmentId: shipmentId ?? `LEGACY-${orderNo}`,
      documents: [],
    };
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
  }
}

class RecordingBatchLogen implements LogenPort, LogenBatchPort {
  loginCalls = 0;
  singleOrderScreenCalls = 0;
  registerCalls: LogenBatch[][] = [];
  centerCalls: Array<Record<string, CenterMaster>> = [];
  contexts: Array<LogenExecutionContext | undefined> = [];
  waybillCalls: Array<{ batches: LogenBatch[]; printerName: string }> = [];
  inspectionCalls: LogenBatch[][] = [];
  inspectionState: LogenBatchWaybillInspectionResult["printState"] = "unprinted";
  registrationOutcome: "registered" | "failed" | "unknown" = "registered";
  throwAfterRegistration = false;
  throwAfterWaybill = false;
  waybillPreflightFailure = false;

  async openRegistration(): Promise<FulfillmentConnectionResult> {
    this.loginCalls += 1;
    return { status: "ready", message: "logged in", url: "https://logis.ilogen.com/common/html/main.html" };
  }

  async openSingleOrderRegistration(): Promise<FulfillmentConnectionResult> {
    this.singleOrderScreenCalls += 1;
    return { status: "ready", message: "single order ready", url: "https://logis.ilogen.com/common/html/main.html" };
  }

  async registerBatches(
    batches: LogenBatch[],
    _sender: SenderProfile,
    centersByOrder: Record<string, CenterMaster>,
    context?: LogenExecutionContext,
  ): Promise<LogenBatchRegistrationResult[]> {
    this.registerCalls.push(structuredClone(batches));
    this.centerCalls.push(structuredClone(centersByOrder));
    this.contexts.push(context);
    if (this.throwAfterRegistration) {
      throw new Error("connection lost after Logen registration submit");
    }
    return batches.map((batch) => ({
      batchId: batch.id,
      fixTakeNo: batch.fixTakeNo,
      success: this.registrationOutcome === "registered",
      status: this.registrationOutcome,
      logenOrderNo:
        this.registrationOutcome === "registered"
          ? `LOGEN-${batch.orderNo}-${batch.skuCode}`
          : undefined,
      registrationKeys:
        this.registrationOutcome === "registered"
          ? Array.from(
              { length: batch.cartonCount },
              (_, index) =>
                `LOGEN-${batch.orderNo}-${batch.skuCode}-${index + 1}`,
            )
          : undefined,
      message: this.registrationOutcome,
    }));
  }

  async printBatchWaybills(
    batches: LogenBatch[],
    printerName: string,
  ): Promise<LogenBatchWaybillResult[]> {
    this.waybillCalls.push({ batches: structuredClone(batches), printerName });
    if (this.waybillPreflightFailure) {
      return batches.map((batch) => ({
        batchId: batch.id,
        fixTakeNo: batch.fixTakeNo,
        slipNos: [],
        registrationKeys: batch.registrationKeys,
        success: false,
        status: "failed",
        message: "registration screen unavailable before print",
      }));
    }
    if (this.throwAfterWaybill) {
      throw new Error("connection lost after waybill print submit");
    }
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

  async inspectBatchWaybills(
    batches: LogenBatch[],
  ): Promise<LogenBatchWaybillInspectionResult[]> {
    this.inspectionCalls.push(structuredClone(batches));
    return batches.map((batch) => ({
      batchId: batch.id,
      registrationKeys:
        batch.registrationKeys ??
        Array.from(
          { length: batch.cartonCount },
          (_, index) => `RECOVERED-${batch.id}-${index + 1}`,
        ),
      printState: this.inspectionState,
      success: this.inspectionState !== "unknown",
      message: `inspected:${this.inspectionState}`,
    }));
  }

  async registerOrders(
    _jobs: ShippingJob[],
    _sender: SenderProfile,
    _centers: CenterMaster[],
  ): Promise<LogenRegistrationResult[]> {
    throw new Error("legacy carton registration must not run");
  }

  async printWaybills(
    _jobs: ShippingJob[],
    _printerName: string,
  ): Promise<LogenWaybillResult[]> {
    throw new Error("legacy carton waybill printing must not run");
  }
}

class RecordingShipmentWorkbook implements ShipmentWorkbookPort {
  calls: Array<Parameters<ShipmentWorkbookPort["build"]>[0]> = [];

  async build(
    input: Parameters<ShipmentWorkbookPort["build"]>[0],
  ): Promise<{ fileName: string; filePath: string }> {
    this.calls.push(structuredClone(input));
    return {
      fileName: `${input.runId}-tracking.xlsx`,
      filePath: `test://${input.runId}/tracking.xlsx`,
    };
  }
}

class RecordingShipmentHub implements SupplierHubShipmentPort {
  uploadCalls: Array<Parameters<SupplierHubShipmentPort["uploadTrackingWorkbook"]>[0]> = [];
  summaryCalls: string[] = [];
  documentCalls: Array<Parameters<SupplierHubShipmentPort["getShipmentDocuments"]>[0]> = [];
  uploadGate?: Promise<void>;
  uploadStarted?: () => void;
  hideSummaries = false;
  hiddenSummaryKeys = new Set<string>();
  throwAfterUpload = false;
  closeCalls = 0;

  async uploadTrackingWorkbook(
    input: Parameters<SupplierHubShipmentPort["uploadTrackingWorkbook"]>[0],
  ) {
    this.uploadCalls.push(structuredClone(input));
    this.uploadStarted?.();
    await this.uploadGate;
    if (this.throwAfterUpload) throw new Error("connection lost after upload click");
    return {
      status: "confirmed" as const,
      uploadNumber: "UPLOAD-001",
      message: "confirmed",
    };
  }

  async listShipmentSummaries(expectedInboundDate: string, orderNos?: string[]) {
    this.summaryCalls.push(expectedInboundDate);
    if (this.hideSummaries) return [];
    const wanted = orderNos ? new Set(orderNos) : undefined;
    const seen = new Set<string>();
    const candidates = [
      ...ORDERS.map((item) => ({
        orderNo: item.orderNo,
        centerCode: item.centerCode,
        expectedInboundDate: item.expectedInboundDate,
      })),
      ...this.uploadCalls.flatMap((call) => call.shipmentGroups),
    ];
    return candidates
      .filter((item) => item.expectedInboundDate === expectedInboundDate)
      .filter((item) => !wanted || wanted.has(item.orderNo))
      .filter(
        (item) =>
          !this.hiddenSummaryKeys.has(`${item.centerCode}|${item.expectedInboundDate}`) &&
          !this.hiddenSummaryKeys.has(
            `${item.orderNo}|${item.centerCode}|${item.expectedInboundDate}`,
          ),
      )
      .filter((item) => {
        const key = `${item.orderNo}|${item.centerCode}|${item.expectedInboundDate}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .map((item) => ({
        shipmentId: `SHIP-${item.orderNo}-${item.centerCode}-${item.expectedInboundDate}`,
        orderNo: item.orderNo,
        centerCode: item.centerCode,
        expectedInboundDate: item.expectedInboundDate,
      }));
  }

  async getShipmentDocuments(
    input: Parameters<SupplierHubShipmentPort["getShipmentDocuments"]>[0],
  ): Promise<ShipmentDocumentResult["documents"]> {
    this.documentCalls.push(structuredClone(input));
    return [
      {
        type: "shipment_label",
        fileName: `${input.shipmentId}-label.pdf`,
        filePath: `test://${input.shipmentId}/label.pdf`,
      },
      {
        type: "shipment_statement",
        fileName: `${input.shipmentId}-statement.pdf`,
        filePath: `test://${input.shipmentId}/statement.pdf`,
      },
    ];
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
  }
}

class RecordingPrinter implements FulfillmentPrinterPort {
  calls: Array<Parameters<FulfillmentPrinterPort["print"]>[0]> = [];
  throwAfterSubmission = false;

  async print(
    input: Parameters<FulfillmentPrinterPort["print"]>[0],
  ): Promise<PrintSubmission> {
    this.calls.push(structuredClone(input));
    if (this.throwAfterSubmission) throw new Error("process stopped after print submit");
    return {
      success: true,
      status: "submitted",
      submittedFiles: input.files.map((file) => file.fileName),
      message: "submitted",
    };
  }
}

function makeHarness(): Harness {
  const store = new FulfillmentStore(":memory:");
  openStores.push(store);
  seedRouting(store);
  const supplierHub = new UnusedLegacySupplierHub();
  const logen = new RecordingBatchLogen();
  const workbook = new RecordingShipmentWorkbook();
  const shipmentHub = new RecordingShipmentHub();
  const printer = new RecordingPrinter();
  const workflow = new FulfillmentWorkflow(
    store,
    {
      supplierHub,
      logen,
      printer,
      shipmentHub,
      shipmentWorkbook: workbook,
      confirmationWorkbook: new DemoOrderConfirmationWorkbookAdapter(),
    },
    {
      orderPrinterName: SINDOH,
      waybillPrinterName: ALLLIVE,
      shipmentPrinterName: SINDOH,
      copies: 1,
      shipTime: "09:30",
      shipmentDocumentsDir: "test://shipment-documents",
    },
    () => NOW,
  );
  return { store, workflow, supplierHub, logen, workbook, shipmentHub, printer };
}

function createRun(store: FulfillmentStore): string {
  return createRunWithOrders(store, ORDERS);
}

function createRunWithOrders(store: FulfillmentStore, orders: FulfillmentOrder[]): string {
  const scan = store.saveScan(orders, 30, NOW.toISOString());
  store.compareAndRecordNewOrders(scan.id, NOW.toISOString());
  return store.createRun(scan.id, undefined, NOW.toISOString()).id;
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
    createdAt: "2026-08-07T09:00:00+09:00",
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

function sideEffectCounts(harness: Harness) {
  return {
    logenRegistrations: harness.logen.registerCalls.length,
    waybillPrints: harness.logen.waybillCalls.length,
    workbookBuilds: harness.workbook.calls.length,
    shipmentUploads: harness.shipmentHub.uploadCalls.length,
    documentDownloads: harness.shipmentHub.documentCalls.length,
    documentPrints: harness.printer.calls.length,
  };
}
