import type {
  CenterMaster,
  DownloadedOrderFile,
  DownloadedOrderConfirmationTemplate,
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
  LogenAction,
  LogenExecutionContext,
  LogenIntegrationMethod,
  LogenPort,
  LogenRegistrationResult,
  LogenReadiness,
  LogenWaybillResult,
  OrderConfirmationUploadResult,
  PrintSubmission,
  SenderProfile,
  ShipmentDocumentResult,
  ShipmentTrackingResult,
  ShippingJob,
  SupplierHubFulfillmentPort,
} from "./fulfillment-types.js";

export type FulfillmentMode = "demo" | "live";
export type ModeReader = () => Promise<FulfillmentMode>;

export class ModeRoutedSupplierHubAdapter implements SupplierHubFulfillmentPort {
  constructor(
    private readonly getMode: ModeReader,
    private readonly demo: SupplierHubFulfillmentPort,
    private readonly live: SupplierHubFulfillmentPort,
  ) {}

  async open(): Promise<FulfillmentConnectionResult> {
    return (await this.target()).open();
  }

  async listOrders(query: FulfillmentOrderQuery): Promise<FulfillmentOrderListResult> {
    return (await this.target()).listOrders(query);
  }

  async downloadOrderConfirmationTemplate(
    runId: string,
    orders: FulfillmentOrder[],
  ): Promise<DownloadedOrderConfirmationTemplate> {
    return (await this.target()).downloadOrderConfirmationTemplate(runId, orders);
  }

  async uploadOrderConfirmationWorkbook(input: {
    runId: string;
    fileName: string;
    filePath: string;
    orderNos: string[];
  }): Promise<OrderConfirmationUploadResult> {
    return (await this.target()).uploadOrderConfirmationWorkbook(input);
  }

  async getOrderStatuses(orderNos: string[]): Promise<Record<string, string>> {
    return (await this.target()).getOrderStatuses(orderNos);
  }

  async downloadOrderFiles(
    runId: string,
    orders: FulfillmentOrder[],
  ): Promise<DownloadedOrderFile[]> {
    return (await this.target()).downloadOrderFiles(runId, orders);
  }

  async registerShipmentTracking(
    orderNo: string,
    slipNos: string[],
  ): Promise<ShipmentTrackingResult> {
    return (await this.target()).registerShipmentTracking(orderNo, slipNos);
  }

  async getShipmentDocuments(
    orderNo: string,
    shipmentId?: string,
  ): Promise<ShipmentDocumentResult> {
    return (await this.target()).getShipmentDocuments(orderNo, shipmentId);
  }

  async close(): Promise<void> {
    await Promise.all([this.demo.close?.(), this.live.close?.()]);
  }

  private async target(): Promise<SupplierHubFulfillmentPort> {
    return (await this.getMode()) === "live" ? this.live : this.demo;
  }
}

export class ModeRoutedLogenAdapter implements LogenPort, LogenBatchPort {
  constructor(
    private readonly getMode: ModeReader,
    private readonly demo: LogenPort & LogenBatchPort,
    private readonly live: LogenPort & LogenBatchPort,
  ) {}

  async openRegistration(
    context?: LogenExecutionContext,
  ): Promise<FulfillmentConnectionResult> {
    const target = await this.target();
    return target.openRegistration?.(context) ?? {
      status: "blocked",
      message: "선택한 로젠 모드가 로그인 화면 열기를 지원하지 않습니다.",
    };
  }

  async openSingleOrderRegistration(
    context?: LogenExecutionContext,
  ): Promise<FulfillmentConnectionResult> {
    const target = await this.target();
    return target.openSingleOrderRegistration?.(context) ?? {
      status: "blocked",
      message: "선택한 로젠 모드가 주문등록/출력(단건) 화면 이동을 지원하지 않습니다.",
    };
  }

  async registerOrders(
    jobs: ShippingJob[],
    sender: SenderProfile,
    centers: CenterMaster[],
  ): Promise<LogenRegistrationResult[]> {
    return (await this.target()).registerOrders(jobs, sender, centers);
  }

  async printWaybills(
    jobs: ShippingJob[],
    printerName: string,
  ): Promise<LogenWaybillResult[]> {
    return (await this.target()).printWaybills(jobs, printerName);
  }

  async registerBatches(
    batches: LogenBatch[],
    sender: SenderProfile,
    centersByOrder: Record<string, CenterMaster>,
    context?: LogenExecutionContext,
  ): Promise<LogenBatchRegistrationResult[]> {
    return (await this.target()).registerBatches(
      batches,
      sender,
      centersByOrder,
      context,
    );
  }

  async printBatchWaybills(
    batches: LogenBatch[],
    printerName: string,
    context?: LogenExecutionContext,
  ): Promise<LogenBatchWaybillResult[]> {
    return (await this.target()).printBatchWaybills(
      batches,
      printerName,
      context,
    );
  }

  async inspectBatchWaybills(
    batches: LogenBatch[],
    context?: LogenExecutionContext,
  ): Promise<LogenBatchWaybillInspectionResult[]> {
    const target = await this.target();
    return target.inspectBatchWaybills?.(batches, context) ?? [];
  }

  async close(): Promise<void> {
    await Promise.all([this.demo.close?.(), this.live.close?.()]);
  }

  private async target(): Promise<LogenPort & LogenBatchPort> {
    return (await this.getMode()) === "live" ? this.live : this.demo;
  }
}

/**
 * Logen Agent: selects one integration seam for the entire run while preserving
 * demo/live routing. The workflow binds the method before crossing this seam.
 */
export class LogenAgent implements LogenPort, LogenBatchPort {
  constructor(
    private readonly getMode: ModeReader,
    private readonly demo: LogenPort & LogenBatchPort,
    private readonly channels: Record<
      LogenIntegrationMethod,
      LogenPort & LogenBatchPort
    >,
    private readonly defaultMethod: LogenIntegrationMethod = "website_mcp",
  ) {}

  async getReadiness(
    action: LogenAction,
    context: LogenExecutionContext,
  ): Promise<LogenReadiness> {
    const target = await this.target(context.integrationMethod);
    return (
      (await target.getReadiness?.(action, context)) ?? {
        ready: true,
        message: "선택한 로젠 Agent 채널이 준비되었습니다.",
      }
    );
  }

  async openRegistration(
    context: LogenExecutionContext = { integrationMethod: this.defaultMethod },
  ): Promise<FulfillmentConnectionResult> {
    const target = await this.target(context.integrationMethod);
    if (!target.openRegistration) {
      return {
        status: "blocked",
        message: "선택한 로젠 연동 방식은 주문등록 창 열기를 지원하지 않습니다.",
      };
    }
    return target.openRegistration(context);
  }

  async openWaybill(
    context: LogenExecutionContext = { integrationMethod: this.defaultMethod },
  ): Promise<FulfillmentConnectionResult> {
    const target = await this.target(context.integrationMethod);
    if (!target.openWaybill) {
      return {
        status: "blocked",
        message: "선택한 로젠 연동 방식은 송장 화면 열기를 지원하지 않습니다.",
      };
    }
    return target.openWaybill(context);
  }

  async openSingleOrderRegistration(
    context: LogenExecutionContext = { integrationMethod: this.defaultMethod },
  ): Promise<FulfillmentConnectionResult> {
    const target = await this.target(context.integrationMethod);
    if (!target.openSingleOrderRegistration) {
      return {
        status: "blocked",
        message: "선택한 로젠 연동 방식은 주문등록/출력(단건) 화면 이동을 지원하지 않습니다.",
      };
    }
    return target.openSingleOrderRegistration(context);
  }

  async registerOrders(
    jobs: ShippingJob[],
    sender: SenderProfile,
    centers: CenterMaster[],
  ): Promise<LogenRegistrationResult[]> {
    return (await this.target(this.defaultMethod)).registerOrders(jobs, sender, centers);
  }

  async printWaybills(
    jobs: ShippingJob[],
    printerName: string,
  ): Promise<LogenWaybillResult[]> {
    return (await this.target(this.defaultMethod)).printWaybills(jobs, printerName);
  }

  async registerBatches(
    batches: LogenBatch[],
    sender: SenderProfile,
    centersByOrder: Record<string, CenterMaster>,
    context: LogenExecutionContext = { integrationMethod: this.defaultMethod },
  ): Promise<LogenBatchRegistrationResult[]> {
    return (await this.target(context.integrationMethod)).registerBatches(
      batches,
      sender,
      centersByOrder,
      context,
    );
  }

  async printBatchWaybills(
    batches: LogenBatch[],
    printerName: string,
    context: LogenExecutionContext = { integrationMethod: this.defaultMethod },
  ): Promise<LogenBatchWaybillResult[]> {
    return (await this.target(context.integrationMethod)).printBatchWaybills(
      batches,
      printerName,
      context,
    );
  }

  async inspectBatchWaybills(
    batches: LogenBatch[],
    context: LogenExecutionContext = { integrationMethod: this.defaultMethod },
  ): Promise<LogenBatchWaybillInspectionResult[]> {
    const target = await this.target(context.integrationMethod);
    return target.inspectBatchWaybills?.(batches, context) ?? [];
  }

  async close(): Promise<void> {
    await Promise.all([
      this.demo.close?.(),
      this.channels.api.close?.(),
      this.channels.website_mcp.close?.(),
    ]);
  }

  private async target(
    integrationMethod: LogenIntegrationMethod,
  ): Promise<LogenPort & LogenBatchPort> {
    return (await this.getMode()) === "live"
      ? this.channels[integrationMethod]
      : this.demo;
  }
}

export class ModeRoutedFulfillmentPrinterAdapter implements FulfillmentPrinterPort {
  constructor(
    private readonly getMode: ModeReader,
    private readonly demo: FulfillmentPrinterPort,
    private readonly live: FulfillmentPrinterPort,
  ) {}

  async print(input: {
    files: Array<{ fileName: string; filePath: string }>;
    printerName: string;
    copies: number;
    kind: "order" | "shipment";
  }): Promise<PrintSubmission> {
    return (await this.getMode()) === "live" ? this.live.print(input) : this.demo.print(input);
  }
}
