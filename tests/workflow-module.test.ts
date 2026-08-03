import { describe, expect, it } from "vitest";
import {
  DemoSupplierHubAdapter,
  DryRunPrinterAdapter,
} from "../src/adapters.js";
import { createInitialState, MemoryStateStore } from "../src/state-store.js";
import type {
  ConnectionStatus,
  PreparedFile,
  PrinterPort,
  PrintResult,
  ScanResult,
  SupplierHubPort,
  SupplierOrder,
  WorkflowSettings,
} from "../src/types.js";
import { SupplierHubWorkflow } from "../src/workflow-module.js";

class MutableSupplier implements SupplierHubPort {
  constructor(public orders: SupplierOrder[]) {}

  async openLogin(): Promise<ConnectionStatus> {
    return { status: "ready", message: "ready" };
  }

  async scan(): Promise<ScanResult> {
    return {
      connection: { status: "ready", message: "ready" },
      orders: structuredClone(this.orders),
    };
  }

  async prepare(orderNos: string[], batchId: string): Promise<PreparedFile[]> {
    return orderNos.map((orderNo) => ({
      orderNo,
      fileName: `${orderNo}.xlsx`,
      filePath: `test://${batchId}/${orderNo}.xlsx`,
      sha256: `${orderNo}-hash`,
      sizeBytes: 100,
    }));
  }
}

class CountingPrinter implements PrinterPort {
  calls = 0;

  constructor(private readonly fail = false) {}

  async print(files: PreparedFile[], settings: WorkflowSettings): Promise<PrintResult> {
    this.calls += 1;
    if (this.fail) throw new Error("printer offline");
    return {
      success: true,
      submittedFiles: files.map((file) => file.fileName),
      message: `${settings.printerName}: ${files.length} files`,
    };
  }
}

const liveOrder = (orderNo: string): SupplierOrder => ({
  orderNo,
  poType: "일반",
  orderType: "일반",
  status: "발주확정",
  createdAt: "2026-07-30T09:00:00+09:00",
  transportType: "쉽먼트",
  firstSkuName: `SKU ${orderNo}`,
  skuCount: 1,
  center: "이천2",
  quantity: 100,
  expectedInboundDate: "2026-08-01",
  source: "live",
});

function makeWorkflow(printer: PrinterPort = new DryRunPrinterAdapter()) {
  const live = new MutableSupplier([]);
  const workflow = new SupplierHubWorkflow(
    new MemoryStateStore(createInitialState("2026-07-30T00:00:00.000Z")),
    {
      suppliers: { demo: new DemoSupplierHubAdapter(), live },
      printers: { demo: printer, live: printer },
    },
    () => new Date("2026-07-30T03:00:00.000Z"),
  );
  return { workflow, live };
}

describe("SupplierHubWorkflow", () => {
  it("discovers only the demo order that is not already in the baseline", async () => {
    const { workflow } = makeWorkflow();

    const result = await workflow.scan();

    expect(result.dashboard.summary.newOrders).toBe(1);
    expect(result.dashboard.orders.find((order) => order.orderNo === "DEMO-PO-003")?.stage).toBe(
      "discovered",
    );
  });

  it("requires the exact confirmation phrase and records a completed print once", async () => {
    const printer = new CountingPrinter();
    const { workflow } = makeWorkflow(printer);
    await workflow.scan();
    const prepared = await workflow.preparePrintBatch(["DEMO-PO-003"]);
    const batchId = prepared.dashboard.batches[0].id;

    await expect(workflow.printBatch(batchId, "PRINT wrong")).rejects.toThrow(
      "인쇄 확인 문구가 일치하지 않습니다",
    );

    const printed = await workflow.printBatch(batchId, `PRINT ${batchId}`);

    expect(printer.calls).toBe(1);
    expect(printed.dashboard.batches[0].status).toBe("completed");
    expect(
      printed.dashboard.orders.find((order) => order.orderNo === "DEMO-PO-003")?.stage,
    ).toBe("printed");
  });

  it("does not mark an order printed when the printer fails", async () => {
    const printer = new CountingPrinter(true);
    const { workflow } = makeWorkflow(printer);
    await workflow.scan();
    const prepared = await workflow.preparePrintBatch(["DEMO-PO-003"]);
    const batchId = prepared.dashboard.batches[0].id;

    const result = await workflow.printBatch(batchId, `PRINT ${batchId}`);

    expect(result.dashboard.batches[0].status).toBe("failed");
    expect(result.dashboard.summary.completed).toBe(0);
    expect(result.dashboard.summary.failed).toBe(1);
  });

  it("uses the first live scan as a baseline and discovers only later orders", async () => {
    const { workflow, live } = makeWorkflow();
    live.orders = [liveOrder("900000001"), liveOrder("900000002")];
    await workflow.updateSettings({ mode: "live" });

    const baseline = await workflow.scan();
    expect(baseline.dashboard.summary.newOrders).toBe(0);
    expect(baseline.dashboard.orders.every((order) => order.stage === "baseline")).toBe(true);

    live.orders = [...live.orders, liveOrder("900000003")];
    const next = await workflow.scan();
    expect(next.dashboard.summary.newOrders).toBe(1);
    expect(next.dashboard.orders.find((order) => order.orderNo === "900000003")?.stage).toBe(
      "discovered",
    );
  });
});
