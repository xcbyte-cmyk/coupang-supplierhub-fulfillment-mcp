import { afterEach, describe, expect, it } from "vitest";
import { FulfillmentStore } from "../src/fulfillment-store.js";
import type {
  CoupangUploadJob,
  FulfillmentCarton,
  FulfillmentOrder,
  LogenBatch,
} from "../src/fulfillment-types.js";

const AT = "2026-07-30T00:00:00.000Z";
const stores: FulfillmentStore[] = [];

afterEach(() => {
  while (stores.length > 0) stores.pop()!.close();
});

describe("FulfillmentStore plan replacement", () => {
  it("explicitly reopens a pre-submission Logen failure without weakening replay protection", () => {
    const { store, runId } = createStoreWithRun();
    const failed: LogenBatch = {
      ...logenBatch(runId, { cartonCount: 2, unitsPerCarton: 50 }),
      status: "failed",
      message: "로젠 로그인 완료 화면을 확인하지 못했습니다.",
    };
    store.saveLogenBatches([failed]);

    const reopened = store.resetLogenBatchBeforeSubmission(
      failed.id,
      "사용자가 13단계를 다시 실행했습니다.",
      later(),
    );

    expect(reopened).toMatchObject({
      status: "ready",
      logenOrderNo: undefined,
      message: "사용자가 13단계를 다시 실행했습니다.",
    });
  });

  it("replaces cartons for mutable batches and removes a blocked batch's old plan", () => {
    const { store, runId } = createStoreWithRun();
    const batch = logenBatch(runId, { cartonCount: 2, unitsPerCarton: 50 });
    store.saveLogenBatches([batch]);
    store.replacePlannedFulfillmentCartons(batchList(batch), cartonPlan(batch, 2, 50));

    const replanned = { ...batch, cartonCount: 1, unitsPerCarton: 100, updatedAt: later() };
    store.saveLogenBatches([replanned]);
    store.replacePlannedFulfillmentCartons(
      batchList(replanned),
      cartonPlan(replanned, 1, 100),
    );

    expect(store.getFulfillmentCartons(batch.id)).toMatchObject([
      { cartonIndex: 1, quantity: 100, status: "ready" },
    ]);

    const blocked: LogenBatch = {
      ...replanned,
      unitsPerCarton: 0,
      cartonCount: 0,
      status: "blocked",
      message: "입수수량 없음",
      updatedAt: later(),
    };
    store.saveLogenBatches([blocked]);
    store.replacePlannedFulfillmentCartons(batchList(blocked), []);

    expect(store.getFulfillmentCartons(batch.id)).toEqual([]);
  });

  it("preserves progressed batch and carton snapshots when planning is replayed", () => {
    const { store, runId } = createStoreWithRun();
    const batch = logenBatch(runId, { cartonCount: 2, unitsPerCarton: 50 });
    store.saveLogenBatches([batch]);
    store.replacePlannedFulfillmentCartons(batchList(batch), cartonPlan(batch, 2, 50));
    store.updateLogenBatch(batch.id, { status: "completed", updatedAt: later() });
    for (const carton of store.getFulfillmentCartons(batch.id)) {
      store.updateFulfillmentCarton(batch.id, carton.cartonIndex, {
        status: "completed",
        slipNo: `SLIP-${carton.cartonIndex}`,
        updatedAt: later(),
      });
    }

    const recalculated: LogenBatch = {
      ...batch,
      unitsPerCarton: 100,
      cartonCount: 1,
      status: "ready",
      updatedAt: later(),
    };
    store.saveLogenBatches([recalculated]);
    store.replacePlannedFulfillmentCartons(
      batchList(recalculated),
      cartonPlan(recalculated, 1, 100),
    );

    expect(store.getLogenBatch(batch.id)).toMatchObject({
      status: "completed",
      unitsPerCarton: 50,
      cartonCount: 2,
    });
    expect(store.getFulfillmentCartons(batch.id)).toMatchObject([
      { cartonIndex: 1, quantity: 50, slipNo: "SLIP-1", status: "completed" },
      { cartonIndex: 2, quantity: 50, slipNo: "SLIP-2", status: "completed" },
    ]);
  });
});

describe("FulfillmentStore upload job state", () => {
  it("updates the ship date of an unsubmitted deterministic upload job", () => {
    const { store, runId } = createStoreWithRun();
    const prepared: CoupangUploadJob = {
      id: "upload-retry",
      runId,
      fileName: "upload.xlsx",
      filePath: "C:/out/upload.xlsx",
      shipDate: "2026-07-30",
      shipTime: "16:00",
      status: "prepared",
      createdAt: AT,
      updatedAt: AT,
    };
    store.saveCoupangUploadJobs([prepared]);

    store.updateCoupangUploadJob(prepared.id, {
      shipDate: "2026-07-31",
      shipTime: "09:30",
      updatedAt: later(),
    });

    expect(store.getCoupangUploadJob(prepared.id)).toMatchObject({
      shipDate: "2026-07-31",
      shipTime: "09:30",
      status: "prepared",
    });
  });

  it("does not downgrade a confirmed job when a prepared plan is replayed", () => {
    const { store, runId } = createStoreWithRun();
    const confirmed: CoupangUploadJob = {
      id: "upload-1",
      runId,
      fileName: "upload.xlsx",
      filePath: "C:/out/upload.xlsx",
      shipDate: "2026-07-30",
      shipTime: "16:00",
      uploadNumber: "UPLOAD-1",
      status: "confirmed",
      message: "업로드 확정",
      createdAt: AT,
      updatedAt: AT,
    };
    store.saveCoupangUploadJobs([confirmed]);
    store.saveCoupangUploadJobs([
      {
        ...confirmed,
        uploadNumber: undefined,
        status: "prepared",
        message: "재생성됨",
        updatedAt: later(),
      },
    ]);

    expect(store.getCoupangUploadJob(confirmed.id)).toMatchObject({
      status: "confirmed",
      uploadNumber: "UPLOAD-1",
      message: "업로드 확정",
    });
  });
});

describe("FulfillmentStore run ownership", () => {
  it("claims one PO for only one run even when two scans were compared first", () => {
    const store = new FulfillmentStore(":memory:");
    stores.push(store);
    const order = fulfillmentOrder();
    const firstScan = store.saveScan([order], 7, AT);
    const secondScan = store.saveScan([order], 7, later());
    store.compareAndRecordNewOrders(firstScan.id, AT);
    store.compareAndRecordNewOrders(secondScan.id, later());

    const firstRun = store.createRun(firstScan.id, undefined, AT);
    const secondRun = store.createRun(secondScan.id, undefined, later());

    expect(secondRun.id).toBe(firstRun.id);
    expect(secondRun.orders.map((item) => item.orderNo)).toEqual(["PO-1"]);
  });

  it("returns the existing run when a later scan classifies every PO as already assigned", () => {
    const store = new FulfillmentStore(":memory:");
    stores.push(store);
    const order = fulfillmentOrder();
    const firstScan = store.saveScan([order], 7, AT);
    store.compareAndRecordNewOrders(firstScan.id, AT);
    const firstRun = store.createRun(firstScan.id, undefined, AT);

    const laterScan = store.saveScan([order], 7, later());
    expect(store.classifyAndRecordOrders(laterScan.id, later())).toMatchObject([
      { disposition: "already_assigned", unprocessed: false },
    ]);

    expect(store.createRun(laterScan.id, undefined, later()).id).toBe(firstRun.id);
  });

  it("exposes the latest scan and v2 run for UI context recovery", () => {
    const store = new FulfillmentStore(":memory:");
    stores.push(store);
    const firstScan = store.saveScan([fulfillmentOrder()], 7, AT);
    store.compareAndRecordNewOrders(firstScan.id, AT);
    const run = store.createRun(firstScan.id, undefined, AT);
    const latestScan = store.saveScan([fulfillmentOrder()], 30, later());

    expect(store.getLatestScanId()).toBe(latestScan.id);
    expect(store.getLatestRunId()).toBe(run.id);
  });

  it("does not rewind a completed run when an earlier stage is read or replayed", () => {
    const { store, runId } = createStoreWithRun();
    store.saveStageResult({
      runId,
      stage: 14,
      status: "completed",
      message: "완료",
      updatedAt: later(),
    });
    store.saveStageResult({
      runId,
      stage: 4,
      status: "completed",
      message: "이전 단계 재호출",
      updatedAt: "2026-07-30T02:00:00.000Z",
    });

    expect(store.getRun(runId)).toMatchObject({
      currentStage: 14,
      status: "completed",
    });
  });

  it("resets only a blocked stage-14 record while preserving Logen registration keys", () => {
    const { store, runId } = createStoreWithRun();
    const batch: LogenBatch = {
      ...logenBatch(runId, { cartonCount: 2, unitsPerCarton: 50 }),
      status: "registered",
      logenOrderNo: "reservation:1",
      registrationKeys: ["reservation:1", "reservation:2"],
      registrationRecordedAt: AT,
      waybillStatus: "failed",
      waybillMessage: "출력 필터 선택 실패",
    };
    store.saveLogenBatches([batch]);
    store.replacePlannedFulfillmentCartons(batchList(batch), cartonPlan(batch, 2, 50));
    store.saveStageResult({
      runId,
      stage: 14,
      status: "blocked",
      message: "출력 필터 선택 실패",
      updatedAt: later(),
    });

    const reset = store.resetStageRecord(runId, 14, "2026-07-30T02:00:00.000Z");

    expect(reset).toMatchObject({
      runId,
      stage: 14,
      previousStatus: "blocked",
      resetWaybillBatchIds: [batch.id],
    });
    expect(store.getLogenBatch(batch.id)).toMatchObject({
      status: "registered",
      registrationKeys: ["reservation:1", "reservation:2"],
      waybillStatus: "not_started",
      waybillMessage: undefined,
    });
    expect(store.getRun(runId).stages.some((stage) => stage.stage === 14)).toBe(false);
  });

  it("protects an unknown stage record from manual history reset", () => {
    const { store, runId } = createStoreWithRun();
    store.saveStageResult({
      runId,
      stage: 14,
      status: "unknown",
      message: "출력 결과 확인 필요",
      updatedAt: later(),
    });

    expect(() => store.resetStageRecord(runId, 14, later())).toThrow(
      "실제 미출력을 확인한 강제 초기화",
    );
    expect(store.getRun(runId).stages).toMatchObject([
      { stage: 14, status: "unknown" },
    ]);
  });

  it("allows a confirmed no-print recovery for stage-14 unknown while keeping audit artifacts", () => {
    const { store, runId } = createStoreWithRun();
    const batch: LogenBatch = {
      ...logenBatch(runId, { cartonCount: 2, unitsPerCarton: 50 }),
      status: "unknown",
      logenOrderNo: "reservation:1",
      registrationKeys: ["reservation:1", "reservation:2"],
      registrationRecordedAt: AT,
      waybillStatus: "unknown",
      waybillMessage: "Windows 인쇄창 확인 실패",
    };
    store.saveLogenBatches([batch]);
    store.replacePlannedFulfillmentCartons(batchList(batch), cartonPlan(batch, 2, 50));
    store.recordArtifact({
      runId,
      type: "waybill_print",
      status: "unknown",
      message: "출력 결과 불명확",
    });
    store.saveStageResult({
      runId,
      stage: 14,
      status: "unknown",
      message: "Windows 인쇄창 확인 실패",
      updatedAt: later(),
    });

    store.resetStageRecord(runId, 14, "2026-07-30T02:00:00.000Z", true);

    expect(store.getLogenBatch(batch.id)).toMatchObject({
      status: "registered",
      registrationKeys: ["reservation:1", "reservation:2"],
      waybillStatus: "not_started",
    });
    expect(store.getRun(runId).stages.some((stage) => stage.stage === 14)).toBe(false);
    expect(store.getRun(runId).artifacts).toMatchObject([
      { type: "waybill_print", status: "unknown" },
    ]);
  });

  it("quick-resets stage 14 in calibration with print submission and number candidates", () => {
    const { store, runId } = createStoreWithRun();
    const batch = logenBatch(runId, { cartonCount: 2, unitsPerCarton: 50 });
    store.saveLogenBatches([batch]);
    store.replacePlannedFulfillmentCartons(batchList(batch), cartonPlan(batch, 2, 50));
    store.updateLogenBatch(batch.id, {
      status: "unknown",
      logenOrderNo: "reservation:1",
      registrationKeys: ["reservation:1", "reservation:2"],
      registrationRecordedAt: AT,
      waybillStatus: "submitted",
      waybillMessage: "송장번호 후보 확인 필요",
    });
    for (const carton of store.getFulfillmentCartons(batch.id)) {
      store.updateFulfillmentCarton(batch.id, carton.cartonIndex, {
        status: "unknown",
        originalSlipNo: `ORIGINAL-${carton.cartonIndex}`,
        waybillNo: `WAYBILL-${carton.cartonIndex}`,
        message: "번호 후보",
        updatedAt: later(),
      });
    }
    store.recordArtifact({
      runId,
      type: "waybill_print",
      status: "unknown",
      submittedAt: later(),
      message: "출력 제출 후 번호 후보 확인 필요",
    });
    store.saveStageResult({
      runId,
      stage: 14,
      status: "unknown",
      message: "송장번호 후보 선택 필요",
      updatedAt: later(),
    });

    store.resetStageRecord(runId, 14, later(), true, true);

    expect(store.getRun(runId).stages.some((stage) => stage.stage === 14)).toBe(false);
    expect(store.getRun(runId).artifacts.filter((item) => item.type === "waybill_print")).toEqual([]);
    expect(store.getLogenBatch(batch.id)).toMatchObject({
      status: "registered",
      registrationKeys: ["reservation:1", "reservation:2"],
      waybillStatus: "not_started",
    });
    expect(store.getFulfillmentCartons(batch.id)).toMatchObject([
      { status: "ready", originalSlipNo: undefined, waybillNo: undefined },
      { status: "ready", originalSlipNo: undefined, waybillNo: undefined },
    ]);
  });

  it("clears local Logen reservation keys after the external reservation was deleted", () => {
    const { store, runId } = createStoreWithRun();
    const batch: LogenBatch = {
      ...logenBatch(runId, { cartonCount: 2, unitsPerCarton: 50 }),
      status: "registered",
      logenOrderNo: "reservation:1785682800000|15|99999999",
      registrationKeys: [
        "reservation:1785682800000|15|99999999",
        "reservation:1785682800000|16|99999999",
      ],
      registrationRecordedAt: AT,
    };
    store.saveLogenBatches([batch]);
    store.saveStageResult({
      runId,
      stage: 13,
      status: "completed",
      message: "로젠 예약 2건 등록 완료",
      updatedAt: later(),
    });

    const reset = store.resetStageRecord(
      runId,
      13,
      "2026-07-30T02:00:00.000Z",
      false,
      true,
      true,
    );

    expect(reset).toMatchObject({
      runId,
      stage: 13,
      previousStatus: "completed",
      clearedLogenBatchIds: [batch.id],
    });
    expect(store.getRun(runId).stages.some((stage) => stage.stage === 13)).toBe(false);
    expect(store.getLogenBatch(batch.id)).toMatchObject({
      status: "ready",
      logenOrderNo: undefined,
      registrationKeys: undefined,
      registrationRecordedAt: undefined,
      waybillStatus: "not_started",
    });
  });
});

function createStoreWithRun(): { store: FulfillmentStore; runId: string } {
  const store = new FulfillmentStore(":memory:");
  stores.push(store);
  const order = fulfillmentOrder();
  const scan = store.saveScan([order], 7, AT);
  store.compareAndRecordNewOrders(scan.id, AT);
  return { store, runId: store.createRun(scan.id, undefined, AT).id };
}

function fulfillmentOrder(): FulfillmentOrder {
  return {
    orderNo: "PO-1",
    centerCode: "FC-1",
    centerName: "센터",
    status: "발주확정",
    transportType: "쉽먼트",
    createdAt: AT,
    expectedInboundDate: "2026-08-02",
    items: [
      {
        skuCode: "SKU-1",
        skuName: "상품",
        orderedQuantity: 100,
        unitsPerCarton: 50,
      },
    ],
  };
}

function logenBatch(
  runId: string,
  values: Pick<LogenBatch, "cartonCount" | "unitsPerCarton">,
): LogenBatch {
  return {
    id: "batch-1",
    runId,
    orderNo: "PO-1",
    skuCode: "SKU-1",
    skuName: "상품",
    orderedQuantity: 100,
    unitsPerCarton: values.unitsPerCarton,
    cartonCount: values.cartonCount,
    fixTakeNo: "PO-1-SKU-1",
    status: "ready",
    createdAt: AT,
    updatedAt: AT,
  };
}

function cartonPlan(
  batch: LogenBatch,
  count: number,
  quantity: number,
): FulfillmentCarton[] {
  return Array.from({ length: count }, (_, index) => ({
    batchId: batch.id,
    cartonIndex: index + 1,
    quantity,
    status: "ready",
    createdAt: AT,
    updatedAt: batch.updatedAt,
  }));
}

function batchList(batch: LogenBatch): LogenBatch[] {
  return [batch];
}

function later(): string {
  return "2026-07-30T01:00:00.000Z";
}
