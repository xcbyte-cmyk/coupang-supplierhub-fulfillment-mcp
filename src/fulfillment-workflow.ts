import { createHash } from "node:crypto";
import type { FulfillmentWorkflowMcpPort } from "./fulfillment-mcp.js";
import { chooseAutomaticShipDate, planFulfillment } from "./fulfillment-planning.js";
import { FulfillmentStore } from "./fulfillment-store.js";
import type {
  CenterMaster,
  ClassifiedFulfillmentOrder,
  CoupangUploadJob,
  FulfillmentArtifact,
  FulfillmentCarton,
  FulfillmentDataSource,
  FulfillmentOrder,
  FulfillmentOrderQuery,
  FulfillmentPrinterPort,
  FulfillmentStage,
  FulfillmentStageReply,
  FulfillmentStageStatus,
  LogenBatch,
  LogenBatchPort,
  LogenIntegrationMethod,
  LogenWaybillNumberConfirmation,
  LogenPort,
  OrderFileSenderProfile,
  OrderConfirmationJob,
  OrderConfirmationWorkbookPort,
  ProductMaster,
  SenderProfile,
  ShipmentGroup,
  ShipmentWorkbookPort,
  ShippingJob,
  StageRecord,
  SupplierHubShipmentPort,
  SupplierHubFulfillmentPort,
} from "./fulfillment-types.js";
import {
  fulfillmentOrderQueryLabel,
  normalizeFulfillmentOrderQuery,
} from "./fulfillment-order-query.js";
import { readShipmentWorkbookData } from "./xlsx-order-reader.js";

export interface FulfillmentWorkflowPorts {
  supplierHub: SupplierHubFulfillmentPort;
  logen: LogenPort & Partial<LogenBatchPort>;
  printer: FulfillmentPrinterPort;
  shipmentHub?: SupplierHubShipmentPort;
  shipmentWorkbook?: ShipmentWorkbookPort;
  confirmationWorkbook: OrderConfirmationWorkbookPort;
}

export interface FulfillmentWorkflowConfig {
  orderPrinterName: string;
  waybillPrinterName: string;
  shipmentPrinterName: string;
  copies: number;
  shipTime?: string;
  shipmentDocumentsDir?: string;
  modeReader?: () => "demo" | "live" | Promise<"demo" | "live">;
  operationModeReader?: () =>
    | "calibration"
    | "automatic"
    | Promise<"calibration" | "automatic">;
  waybillPrinterDiscoveryError?: string;
  defaultLogenIntegrationMethod?: LogenIntegrationMethod;
  senderDefaults?: {
    customerCode?: string;
    fareType?: string;
    boxTypeCode?: string;
    deliveryFare?: number;
  };
}

const NEXT_TOOL: Partial<Record<FulfillmentStage, string>> = {
  1: "list_private_label_orders",
  2: "compare_new_orders",
  3: "select_orders_for_fulfillment",
  4: "download_order_confirmation_template",
  5: "prepare_order_confirmation_workbook",
  6: "upload_and_confirm_private_label_orders",
  7: "download_order_files",
  8: "print_order_files",
  9: "record_print_result",
  10: "open_logen_login",
  11: "open_logen_single_order_registration",
  12: "register_logen_delivery_order",
  13: "print_logen_waybill",
  14: "register_supplierhub_shipment_tracking",
  15: "print_supplierhub_shipment_documents",
};

export class FulfillmentWorkflow implements FulfillmentWorkflowMcpPort {
  private busy = false;
  private mutationOwner?: symbol;

  constructor(
    private readonly store: FulfillmentStore,
    private readonly ports: FulfillmentWorkflowPorts,
    private readonly config: FulfillmentWorkflowConfig,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async openSupplierHub(executionToken?: symbol): Promise<FulfillmentStageReply> {
    return this.runUnscopedStage(1, executionToken, async () => {
      await this.ports.shipmentHub?.close?.();
      const connection = await this.ports.supplierHub.open();
      return reply(
        1,
        connection.status === "ready" ? "completed" : "blocked",
        [connection],
        connection.message,
      );
    });
  }

  async openLogenLogin(input: {
    runId: string;
    logenMethod?: LogenIntegrationMethod;
    executionToken?: symbol;
  }): Promise<FulfillmentStageReply> {
    return this.runStage(input.runId, 11, async () => {
      const run = this.store.getRun(input.runId);
      const logenMethod = this.store.bindLogenIntegrationMethod(
        run.id,
        input.logenMethod ??
          run.logenIntegrationMethod ??
          this.config.defaultLogenIntegrationMethod ??
          "website_mcp",
      );
      if (logenMethod === "api") {
        return {
          status: "completed" as const,
          items: [],
          message: "로젠 API 연동에서는 웹사이트 로그인을 생략했습니다.",
        };
      }
      if (!this.ports.logen.openRegistration) {
        return {
          status: "blocked" as const,
          items: [],
          message: "선택한 로젠 Agent가 로그인 창 열기를 지원하지 않습니다.",
        };
      }
      const connection = await this.ports.logen.openRegistration({
        integrationMethod: logenMethod,
      });
      return {
        status: connection.status === "ready" ? ("completed" as const) : ("blocked" as const),
        items: [connection],
        message: connection.message,
      };
    }, input.executionToken);
  }

  async openLogenSingleOrderRegistration(input: {
    runId: string;
    logenMethod?: LogenIntegrationMethod;
    executionToken?: symbol;
  }): Promise<FulfillmentStageReply> {
    return this.runStage(input.runId, 12, async () => {
      const run = this.store.getRun(input.runId);
      const logenMethod = this.store.bindLogenIntegrationMethod(
        run.id,
        input.logenMethod ??
          run.logenIntegrationMethod ??
          this.config.defaultLogenIntegrationMethod ??
          "website_mcp",
      );
      if (logenMethod === "api") {
        return {
          status: "completed" as const,
          items: [],
          message: "로젠 API 연동에서는 주문등록/출력(단건) 화면 이동을 생략했습니다.",
        };
      }
      if (!this.ports.logen.openSingleOrderRegistration) {
        return {
          status: "blocked" as const,
          items: [],
          message: "선택한 로젠 Agent가 주문등록/출력(단건) 화면 이동을 지원하지 않습니다.",
        };
      }
      const connection = await this.ports.logen.openSingleOrderRegistration({
        integrationMethod: logenMethod,
      });
      return {
        status: connection.status === "ready" ? ("completed" as const) : ("blocked" as const),
        items: [connection],
        message: connection.message,
      };
    }, input.executionToken);
  }

  async listPrivateLabelOrders(input: {
    lookAheadDays: 7 | 30;
    dateSearchType?: "expected_inbound_date" | "order_date";
    dateFrom?: string;
    dateTo?: string;
    executionToken?: symbol;
  }): Promise<FulfillmentStageReply<FulfillmentOrder>> {
    return this.runUnscopedStage(2, input.executionToken, async () => {
      const query = normalizeFulfillmentOrderQuery(input);
      await this.ports.shipmentHub?.close?.();
      const result = await this.ports.supplierHub.listOrders(query);
      if (result.connection.status !== "ready") {
        return reply(2, "blocked", [], result.connection.message);
      }
      const scan = this.store.saveScan(
        result.orders,
        query.lookAheadDays,
        this.isoNow(),
        query,
      );
      return reply(
        2,
        "completed",
        scan.orders,
        `Private Label 발주 ${scan.orders.length}건을 ${fulfillmentOrderQueryLabel(query)} 기준으로 조회했습니다.`,
        { scanId: scan.id },
      );
    });
  }

  async compareNewOrders(input: {
    scanId: string;
    executionToken?: symbol;
  }): Promise<FulfillmentStageReply<ClassifiedFulfillmentOrder>> {
    return this.runUnscopedStage(3, input.executionToken, async () => {
      const orders = this.store.classifyAndRecordOrders(input.scanId, this.isoNow());
      const counts = new Map<string, number>();
      for (const item of orders) {
        counts.set(item.disposition, (counts.get(item.disposition) ?? 0) + 1);
      }
      return reply(
        3,
        "completed",
        orders,
        orders.length > 0
          ? `발주 ${orders.length}건을 분류했습니다. 확정 필요 ${counts.get("needs_confirmation") ?? 0}건, 이미 확정 ${counts.get("already_confirmed") ?? 0}건, 실행 배정 ${counts.get("already_assigned") ?? 0}건, 처리 제외 ${counts.get("unsupported_status") ?? 0}건.`
          : "분류할 발주가 없습니다.",
        { scanId: input.scanId },
      );
    });
  }

  async selectOrdersForFulfillment(input: {
    scanId: string;
    orderNos?: string[];
    executionToken?: symbol;
  }): Promise<FulfillmentStageReply<FulfillmentOrder>> {
    return this.runUnscopedStage(4, input.executionToken, async () => {
      const availableOrders = this.store.newOrdersForScan(input.scanId);
      if (availableOrders.length === 0) {
        return reply(
          4,
          "blocked",
          [],
          "3단계 결과에 새로 배정할 발주가 없습니다. 이전 실행은 자동으로 선택하지 않습니다.",
          { scanId: input.scanId },
        );
      }
      const run = this.store.createRun(input.scanId, input.orderNos, this.isoNow());
      const confirmationJobs = this.store.ensureOrderConfirmationJobs(
        run.id,
        run.orders,
        this.isoNow(),
      );
      const message = `처리 가능한 발주 ${run.orders.length}건을 워크플로 v2 실행 ${run.id}에 연결했습니다.`;
      this.store.saveStageResult({
        runId: run.id,
        stage: 4,
        status: "completed",
        message,
        items: confirmationJobs,
        updatedAt: this.isoNow(),
      });
      return reply(4, "completed", run.orders, message, {
        scanId: input.scanId,
        runId: run.id,
      });
    });
  }

  async selectOrdersForPrint(input: {
    scanId: string;
    orderNos?: string[];
    executionToken?: symbol;
  }): Promise<FulfillmentStageReply<FulfillmentOrder>> {
    return this.selectOrdersForFulfillment(input);
  }

  async releaseFulfillmentRunAssignments(input: {
    runId: string;
    executionToken?: symbol;
  }): Promise<FulfillmentStageReply<FulfillmentOrder>> {
    return this.runUnscopedStage(4, input.executionToken, async () => {
      const run = this.store.getRun(input.runId);
      const released = this.store.releaseRunAssignments(input.runId, this.isoNow());
      return reply(
        4,
        "completed",
        run.orders,
        `이전 실행 ${input.runId}의 발주 ${released.releasedOrderNos.length}건 배정을 해제했습니다. 3단계부터 다시 실행하세요.`,
      );
    });
  }

  async downloadOrderConfirmationTemplate(input: {
    runId: string;
    executionToken?: symbol;
  }): Promise<FulfillmentStageReply<OrderConfirmationJob>> {
    return this.runStage(input.runId, 5, async () => {
      await this.ports.shipmentHub?.close?.();
      const run = this.store.getRun(input.runId);
      const jobs = this.store.ensureOrderConfirmationJobs(run.id, run.orders, this.isoNow());
      const pending = jobs.filter((job) => job.status !== "confirmed");
      if (pending.length === 0) {
        return {
          status: "completed" as const,
          items: jobs,
          message: "모든 발주가 이미 발주확정 상태라 양식 다운로드를 건너뛰었습니다.",
        };
      }
      const reusable = pending.every(
        (job) =>
          ["downloaded", "prepared", "uploaded"].includes(job.status) &&
          job.templateFileName &&
          job.templateFilePath,
      );
      if (reusable) {
        return {
          status: "completed" as const,
          items: jobs,
          message: "이미 받은 발주서 업로드 양식을 재사용합니다.",
        };
      }
      const pendingNos = new Set(pending.map((job) => job.orderNo));
      const template = await this.ports.supplierHub.downloadOrderConfirmationTemplate(
        run.id,
        run.orders.filter((order) => pendingNos.has(order.orderNo)),
      );
      for (const job of pending) {
        this.store.updateOrderConfirmationJob({
          runId: run.id,
          orderNo: job.orderNo,
          status: "downloaded",
          templateFileName: template.fileName,
          templateFilePath: template.filePath,
          message: "Supplier Hub에서 발주서 업로드 양식을 다운로드했습니다.",
          updatedAt: this.isoNow(),
        });
      }
      return {
        status: "completed" as const,
        items: this.store.getOrderConfirmationJobs(run.id),
        message: `확정 대상 발주 ${pending.length}건의 발주서 업로드 양식을 다운로드했습니다.`,
      };
    }, input.executionToken);
  }

  async prepareOrderConfirmationWorkbook(input: {
    runId: string;
    executionToken?: symbol;
  }): Promise<FulfillmentStageReply<OrderConfirmationJob>> {
    return this.runStage(input.runId, 6, async () => {
      const run = this.store.getRun(input.runId);
      const jobs = this.store.ensureOrderConfirmationJobs(run.id, run.orders, this.isoNow());
      const pending = jobs.filter((job) => job.status !== "confirmed");
      if (pending.length === 0) {
        return {
          status: "completed" as const,
          items: jobs,
          message: "모든 발주가 이미 확정되어 확정수량 작성을 건너뛰었습니다.",
        };
      }
      const reusable = pending.every(
        (job) => ["prepared", "uploaded"].includes(job.status) && job.preparedFilePath,
      );
      if (reusable) {
        return {
          status: "completed" as const,
          items: jobs,
          message: "이미 준비된 발주확정 엑셀을 재사용합니다.",
        };
      }
      const source = pending.find(
        (job) => job.templateFileName && job.templateFilePath,
      );
      if (!source?.templateFileName || !source.templateFilePath) {
        return {
          status: "blocked" as const,
          items: jobs,
          message: "먼저 5단계에서 발주서 업로드 양식을 다운로드해야 합니다.",
        };
      }
      const prepared = await this.ports.confirmationWorkbook.prepare({
        runId: run.id,
        sourceFileName: source.templateFileName,
        sourceFilePath: source.templateFilePath,
        orderNos: pending.map((job) => job.orderNo),
      });
      for (const job of pending) {
        this.store.updateOrderConfirmationJob({
          runId: run.id,
          orderNo: job.orderNo,
          status: "prepared",
          preparedFileName: prepared.fileName,
          preparedFilePath: prepared.filePath,
          message: "발주수량과 동일한 값으로 확정수량을 작성했습니다.",
          updatedAt: this.isoNow(),
        });
      }
      return {
        status: "completed" as const,
        items: this.store.getOrderConfirmationJobs(run.id),
        message: `발주 ${pending.length}건, ${prepared.changedRows}개 행의 확정수량을 준비했습니다. 업로드는 실행하지 않았습니다.`,
      };
    }, input.executionToken);
  }

  async uploadAndConfirmPrivateLabelOrders(input: {
    runId: string;
    forceRetry?: boolean;
    executionToken?: symbol;
  }): Promise<FulfillmentStageReply<OrderConfirmationJob>> {
    return this.runStage(input.runId, 7, async () => {
      await this.ports.shipmentHub?.close?.();
      const run = this.store.getRun(input.runId);
      const jobs = this.store.ensureOrderConfirmationJobs(run.id, run.orders, this.isoNow());
      const risky = jobs.filter((job) => job.status === "unknown");
      if (risky.length > 0 && !input.forceRetry) {
        return {
          status: "unknown" as const,
          items: jobs,
          message: "이전 업로드 결과가 불명확해 자동 재업로드하지 않았습니다.",
        };
      }
      // The live adapter performs the mandatory pre-upload status check itself.
      // Doing it here as well caused the same Supplier Hub order page to be
      // loaded and searched twice immediately before every upload.
      const refreshed = jobs;
      const pending = refreshed.filter((job) => job.status !== "confirmed");
      if (pending.length === 0) {
        return {
          status: "completed" as const,
          items: refreshed,
          message: "모든 발주의 발주확정 상태를 확인했습니다.",
        };
      }
      const workbook = pending.find(
        (job) => job.preparedFileName && job.preparedFilePath,
      );
      if (!workbook?.preparedFileName || !workbook.preparedFilePath) {
        return {
          status: "blocked" as const,
          items: refreshed,
          message: "먼저 6단계에서 발주확정 엑셀을 준비해야 합니다.",
        };
      }
      const result = await this.ports.supplierHub.uploadOrderConfirmationWorkbook({
        runId: run.id,
        fileName: workbook.preparedFileName,
        filePath: workbook.preparedFilePath,
        orderNos: pending.map((job) => job.orderNo),
      });
      const confirmed = new Set(result.confirmedOrderNos);
      for (const job of pending) {
        this.store.updateOrderConfirmationJob({
          runId: run.id,
          orderNo: job.orderNo,
          status: confirmed.has(job.orderNo)
            ? "confirmed"
            : result.status === "failed"
              ? "failed"
              : "unknown",
          message: result.message,
          updatedAt: this.isoNow(),
        });
      }
      const status =
        result.status === "confirmed"
          ? "completed"
          : result.status === "partial"
            ? "partial"
            : result.status;
      return {
        status,
        items: this.store.getOrderConfirmationJobs(run.id),
        message: result.message,
      };
    }, input.executionToken);
  }

  async downloadOrderFiles(input: {
    runId: string;
    executionToken?: symbol;
  }): Promise<FulfillmentStageReply> {
    return this.runStage<unknown>(input.runId, 8, async () => {
      await this.ports.shipmentHub?.close?.();
      const run = this.store.getRun(input.runId);
      const unconfirmed = (run.orderConfirmationJobs ?? []).filter(
        (job) => job.status !== "confirmed",
      );
      if (unconfirmed.length > 0) {
        return {
          status: "blocked" as const,
          items: unconfirmed,
          message: "발주확정이 끝나지 않은 발주가 있어 인쇄용 발주서를 다운로드하지 않았습니다.",
        };
      }
      const existing = run.artifacts.filter(
        (artifact) => artifact.type === "order_file" && artifact.status === "downloaded",
      );
      const downloadedOrderNos = new Set(
        existing.map((artifact) => artifact.orderNo).filter(Boolean),
      );
      const missingOrders = run.orders.filter(
        (order) => !downloadedOrderNos.has(order.orderNo),
      );
      if (missingOrders.length === 0) {
        for (const artifact of existing) {
          this.importOrderFileArtifact(artifact, run.orders);
        }
        return {
          status: "completed" as const,
          items: existing,
          message: `이미 받은 발주서 ${existing.length}개를 재사용합니다.`,
        };
      }

      let downloadError: string | undefined;
      for (let offset = 0; offset < missingOrders.length; offset += 100) {
        const chunk = missingOrders.slice(offset, offset + 100);
        try {
          const files = await this.ports.supplierHub.downloadOrderFiles(run.id, chunk);
          for (const file of files) {
            if (file.items && file.items.length > 0) {
              this.store.replaceOrderItems(file.orderNo, file.items);
            }
            if (file.center) {
              this.store.saveOrderFileCenter(file.orderNo, file.center);
            }
            if (file.sender) {
              this.promoteOrderFileSender(file.sender);
            }
            this.store.recordArtifact({
              runId: run.id,
              orderNo: file.orderNo,
              type: "order_file",
              status: "downloaded",
              fileName: file.fileName,
              filePath: file.filePath,
              message: "Supplier Hub에서 다운로드됨",
            });
          }
        } catch (error) {
          downloadError = errorMessage(error);
          break;
        }
      }
      const finalArtifacts = this.store
        .getRun(run.id)
        .artifacts.filter(
          (artifact) => artifact.type === "order_file" && artifact.status === "downloaded",
        );
      const finalOrderNos = new Set(
        finalArtifacts.map((artifact) => artifact.orderNo).filter(Boolean),
      );
      const missingCount = run.orders.filter(
        (order) => !finalOrderNos.has(order.orderNo),
      ).length;
      return {
        status:
          missingCount === 0
            ? ("completed" as const)
            : ("blocked" as const),
        items: finalArtifacts,
        message:
          missingCount === 0
            ? `발주서 ${finalArtifacts.length}개를 다운로드했습니다. ZIP·XLSX 내용 검수는 수행하지 않았습니다.`
            : finalArtifacts.length > 0
              ? `발주서 ${finalArtifacts.length}개를 받았고 ${missingCount}개는 아직 받지 못했습니다.${downloadError ? ` ${downloadError}` : ""}`
            : `다운로드된 발주서가 없습니다.${downloadError ? ` ${downloadError}` : ""}`,
      };
    }, input.executionToken);
  }

  async printOrderFiles(input: {
    runId: string;
    forceReprint?: boolean;
    executionToken?: symbol;
  }): Promise<FulfillmentStageReply> {
    return this.runStage(input.runId, 9, async () => {
      const run = this.store.getRun(input.runId);
      const submitted = run.artifacts.filter(
        (artifact) => artifact.type === "order_print" && artifact.status === "submitted",
      );
      if (submitted.length > 0 && !input.forceReprint) {
        return {
          status: "completed" as const,
          items: submitted,
          message: "이미 제출된 발주서 인쇄를 자동으로 다시 실행하지 않았습니다.",
        };
      }
      const unknown = run.artifacts.filter(
        (artifact) => artifact.type === "order_print" && artifact.status === "unknown",
      );
      if (unknown.length > 0 && !input.forceReprint) {
        return {
          status: "unknown" as const,
          items: unknown,
          message: "이전 발주서 출력 결과가 불명확해 자동 재출력하지 않았습니다.",
        };
      }

      const files = run.artifacts
        .filter((artifact) => artifact.type === "order_file" && artifact.filePath && artifact.fileName)
        .map((artifact) => ({ fileName: artifact.fileName!, filePath: artifact.filePath! }));
      if (files.length === 0) {
        return { status: "blocked" as const, items: [], message: "인쇄할 발주서 파일이 없습니다." };
      }
      const artifactId = deterministicArtifactId(
        run.id,
        "order_print",
        files.map((file) => file.filePath),
      );
      this.store.recordArtifact({
        id: artifactId,
        runId: run.id,
        type: "order_print",
        status: "unknown",
        printerName: this.config.orderPrinterName,
        message:
          "발주서 인쇄 요청을 시작했습니다. 완료 기록 전 중단되면 자동 재출력하지 않습니다.",
      });
      const result = await this.ports.printer.print({
        files,
        printerName: this.config.orderPrinterName,
        copies: this.config.copies,
        kind: "order",
      });
      const status = result.success ? "submitted" : result.status ?? "unknown";
      const artifact = this.store.recordArtifact({
        id: artifactId,
        runId: run.id,
        type: "order_print",
        status,
        printerName: this.config.orderPrinterName,
        submittedAt: result.success ? this.isoNow() : undefined,
        message: result.message,
      });
      return {
        status: result.success ? ("completed" as const) : ("unknown" as const),
        items: [artifact],
        message: result.message,
      };
    }, input.executionToken);
  }

  async recordPrintResult(input: {
    runId: string;
    executionToken?: symbol;
  }): Promise<FulfillmentStageReply> {
    return this.runStage(input.runId, 10, async () => {
      const run = this.store.getRun(input.runId);
      const results = run.artifacts.filter((artifact) => artifact.type === "order_print");
      const submitted = results.some((artifact) => artifact.status === "submitted");
      return {
        status: submitted ? ("completed" as const) : ("blocked" as const),
        items: results,
        message: submitted
          ? `발주 ${run.orders.length}건의 인쇄 제출 결과를 기록했습니다.`
          : "완료된 발주서 인쇄 제출 결과가 없어 택배 처리를 시작하지 않았습니다.",
      };
    }, input.executionToken);
  }

  async registerLogenDeliveryOrder(input: {
    runId: string;
    dataSource: FulfillmentDataSource;
    logenMethod?: LogenIntegrationMethod;
    refreshMaster?: boolean;
    executionToken?: symbol;
  }): Promise<FulfillmentStageReply<ShippingJob>> {
    return this.runStage(input.runId, 13, async () => {
      const run = this.store.getRun(input.runId);
      const logenMethod = this.store.bindLogenIntegrationMethod(
        run.id,
        input.logenMethod ??
          run.logenIntegrationMethod ??
          this.config.defaultLogenIntegrationMethod ??
          "website_mcp",
      );
      const workflowMode = (await this.config.modeReader?.()) ?? "demo";
      const sender = this.resolveSenderForRun(run);
      const jobs = this.createCartonJobs(
        run.id,
        run.orders,
        input.dataSource,
        Boolean(input.refreshMaster),
        workflowMode !== "live",
      );
      this.store.saveShippingJobs(jobs);

      const resolvedOrders = run.orders.map((order) => ({
        ...order,
        items: order.items.map((item) => ({
          ...item,
          unitsPerCarton:
            jobs.find(
              (job) => job.orderNo === order.orderNo && job.skuCode === item.skuCode,
            )?.unitsPerCarton || undefined,
        })),
      }));
      const plan = planFulfillment({
        runId: run.id,
        orders: resolvedOrders,
        now: this.isoNow(),
      });
      this.store.saveLogenBatches(plan.batches);
      for (const batch of this.store.getLogenBatches(run.id)) {
        if (!isSafePreSubmissionLogenFailure(batch.status, batch.message)) continue;
        this.store.resetLogenBatchBeforeSubmission(
          batch.id,
          "외부 주문 제출 전 실패 건을 사용자가 13단계에서 다시 실행했습니다.",
          this.isoNow(),
        );
        for (const job of jobs.filter(
          (item) => item.orderNo === batch.orderNo && item.skuCode === batch.skuCode,
        )) {
          this.store.updateShippingJob(job.id, { status: "ready", error: undefined });
        }
      }
      this.store.replacePlannedFulfillmentCartons(plan.batches, plan.cartons);
      this.store.saveShipmentGroups(plan.shipmentGroups);

      if (!sender || (workflowMode === "live" && isDemoSender(sender))) {
        const hasOrderWorkbook = run.artifacts.some(
          (artifact) =>
            artifact.type === "order_file" &&
            artifact.status === "downloaded" &&
            artifact.filePath?.toLowerCase().endsWith(".xlsx"),
        );
        const senderMessage = !hasOrderWorkbook
          ? "저장된 실제 송하인 기준정보가 없고 8단계 발주서 파일도 없습니다. 먼저 8단계 발주서 다운로드를 실행하세요."
          : "저장된 실제 송하인 기준정보가 없고 발주서에서도 송하인명·주소·전화번호와 로젠 거래처코드를 완성하지 못했습니다.";
        for (const batch of plan.batches.filter((item) => item.status === "ready")) {
          this.store.updateLogenBatch(batch.id, {
            status: "blocked",
            message: senderMessage,
            updatedAt: this.isoNow(),
          });
        }
        for (const job of jobs.filter((item) => item.status === "ready")) {
          this.store.updateShippingJob(job.id, {
            status: "blocked",
            error: senderMessage,
          });
        }
        const blocked = this.store.getShippingJobs(run.id);
        return {
          status: "blocked" as const,
          items: blocked,
          message: `${senderMessage} 주문등록을 중단했습니다.`,
        };
      }

      const centersByOrder: Record<string, CenterMaster> = {};
      for (const batch of plan.batches) {
        if (batch.status !== "ready") continue;
        const order = run.orders.find((item) => item.orderNo === batch.orderNo)!;
        const center = this.resolveCenterForOrder(order, workflowMode !== "live");
        const centerMessage = !center
          ? `센터 ${order.centerCode} 수취 정보가 저장되어 있지 않고 발주서에서도 확인되지 않았습니다.`
          : undefined;
        if (!center || centerMessage) {
          this.store.updateLogenBatch(batch.id, {
            status: "blocked",
            message: centerMessage,
            updatedAt: this.isoNow(),
          });
          for (const job of jobs.filter(
            (item) => item.orderNo === batch.orderNo && item.skuCode === batch.skuCode,
          )) {
            this.store.updateShippingJob(job.id, {
              status: "blocked",
              error: centerMessage,
            });
          }
          continue;
        }
        centersByOrder[order.orderNo] = center;
      }

      const pendingBatches = this.store.getLogenBatches(run.id).filter(
        (batch) => batch.status === "ready" && centersByOrder[batch.orderNo],
      );
      const readiness = await this.ports.logen.getReadiness?.("register", {
        integrationMethod: logenMethod,
      });
      if (pendingBatches.length > 0 && readiness && !readiness.ready) {
        for (const batch of pendingBatches) {
          this.store.updateLogenBatch(batch.id, {
            status: "blocked",
            message: readiness.message,
            updatedAt: this.isoNow(),
          });
          for (const job of this.store
            .getShippingJobs(run.id)
            .filter(
              (item) =>
                item.orderNo === batch.orderNo && item.skuCode === batch.skuCode,
            )) {
            this.store.updateShippingJob(job.id, {
              status: "blocked",
              error: readiness.message,
            });
          }
        }
        return {
          status: "blocked" as const,
          items: this.store.getShippingJobs(run.id),
          message: `${displayLogenMethod(logenMethod)} 준비가 완료되지 않았습니다. ${readiness.message}`,
        };
      }
      if (pendingBatches.length > 0 && this.ports.logen.registerBatches) {
        const inFlightMessage =
          "로젠 주문등록 요청을 시작했습니다. 완료 기록 전 중단되면 자동 재등록하지 않습니다.";
        for (const batch of pendingBatches) {
          this.store.updateLogenBatch(batch.id, {
            status: "unknown",
            message: inFlightMessage,
            updatedAt: this.isoNow(),
          });
          for (const job of this.store
            .getShippingJobs(run.id)
            .filter(
              (item) =>
                item.orderNo === batch.orderNo && item.skuCode === batch.skuCode,
            )) {
            this.store.updateShippingJob(job.id, {
              status: "unknown",
              error: inFlightMessage,
            });
          }
        }
        const results = await this.ports.logen.registerBatches(
          pendingBatches,
          sender,
          centersByOrder,
          { integrationMethod: logenMethod },
        );
        for (const result of results) {
          const recordedAt = this.isoNow();
          const status = result.success
            ? "registered"
            : result.status === "unknown"
              ? "unknown"
              : "failed";
          const batch = this.store.updateLogenBatch(result.batchId, {
            status,
            logenOrderNo: result.logenOrderNo ?? result.registrationKeys?.[0],
            registrationKeys: result.registrationKeys,
            registrationRecordedAt: result.success ? recordedAt : undefined,
            waybillStatus: result.success ? "not_started" : undefined,
            waybillMessage: undefined,
            message: result.message,
            updatedAt: recordedAt,
          });
          for (const job of this.store
            .getShippingJobs(run.id)
            .filter(
              (item) => item.orderNo === batch.orderNo && item.skuCode === batch.skuCode,
            )) {
            this.store.updateShippingJob(job.id, {
              status: result.success ? "registered" : status === "unknown" ? "unknown" : "failed",
              error: result.success ? undefined : result.message,
              logenRegisteredAt: result.success ? recordedAt : undefined,
            });
          }
        }
      } else if (pendingBatches.length > 0) {
        const message =
          "로젠 어댑터가 PO·SKU 배치 등록 계약을 지원하지 않아 카톤별 주문으로 대체하지 않았습니다.";
        for (const batch of pendingBatches) {
          this.store.updateLogenBatch(batch.id, {
            status: "blocked",
            message,
            updatedAt: this.isoNow(),
          });
          for (const job of this.store
            .getShippingJobs(run.id)
            .filter(
              (item) => item.orderNo === batch.orderNo && item.skuCode === batch.skuCode,
            )) {
            this.store.updateShippingJob(job.id, { status: "blocked", error: message });
          }
        }
      }

      const finalBatches = this.store.getLogenBatches(run.id);
      const finalJobs = this.store.getShippingJobs(run.id);
      const successCount = finalBatches.filter((batch) =>
        ["registered", "waybills_printed", "completed"].includes(batch.status),
      ).length;
      const blockedCount = finalBatches.filter((batch) =>
        ["blocked", "failed"].includes(batch.status),
      ).length;
      const unknownCount = finalBatches.filter((batch) => batch.status === "unknown").length;
      const firstIncompleteMessage = finalBatches.find((batch) =>
        ["blocked", "failed", "unknown"].includes(batch.status),
      )?.message;
      return {
        status: outcomeAggregateStatus(successCount, blockedCount, unknownCount),
        items: finalJobs,
        message:
          `${displayLogenMethod(logenMethod)}로 PO·SKU 로젠 배치 ${successCount}건을 등록했고 ${blockedCount}건은 중단, ${unknownCount}건은 결과 불명확입니다. 카톤 계획은 ${plan.cartons.length}건입니다.` +
          (firstIncompleteMessage ? ` 중단 사유: ${firstIncompleteMessage}` : ""),
      };
    }, input.executionToken);
  }

  async printLogenWaybill(input: {
    runId: string;
    logenMethod?: LogenIntegrationMethod;
    forceReprint?: boolean;
    executionToken?: symbol;
  }): Promise<FulfillmentStageReply<ShippingJob>> {
    return this.runStage(input.runId, 14, async () => {
      const run = this.store.getRun(input.runId);
      const logenMethod = this.store.bindLogenIntegrationMethod(
        input.runId,
        input.logenMethod ??
          run.logenIntegrationMethod ??
          this.config.defaultLogenIntegrationMethod ??
          "website_mcp",
      );
      // Website stage 14 reuses the exact registration surface opened by
      // stages 12-13. Navigating the main URL here would destroy that surface.
      const workflowMode = (await this.config.modeReader?.()) ?? "demo";
      if (workflowMode === "live" && this.config.waybillPrinterDiscoveryError) {
        return {
          status: "blocked" as const,
          items: this.store.getShippingJobs(input.runId),
          message: this.config.waybillPrinterDiscoveryError,
        };
      }
      const batches = this.store.getLogenBatches(input.runId);
      if (batches.length > 0 && this.ports.logen.printBatchWaybills) {
        const readiness = await this.ports.logen.getReadiness?.("print", {
          integrationMethod: logenMethod,
          forceReprint: Boolean(input.forceReprint),
        });
        if (readiness && !readiness.ready) {
          return {
            status: "blocked" as const,
            items: this.store.getShippingJobs(input.runId),
            message: `${displayLogenMethod(logenMethod)} 준비가 완료되지 않았습니다. ${readiness.message}`,
          };
        }
        return this.printLogenBatchWaybills(
          input.runId,
          batches,
          Boolean(input.forceReprint),
          logenMethod,
        );
      }

      // Compatibility path for the original carton-level Logen adapter.
      const jobs = this.store.getShippingJobs(input.runId);
      const pending = jobs.filter((job) => {
        if (job.status === "registered") return true;
        return Boolean(
          input.forceReprint &&
            (["unknown", "waybill_printed", "tracking_registered", "documents_printed"].includes(
              job.status,
            ) || job.slipNo),
        );
      });
      if (pending.length === 0) {
        const printed = jobs.filter((job) => job.slipNo);
        const hasUnknown = jobs.some((job) => job.status === "unknown");
        return {
          status: hasUnknown
            ? ("unknown" as const)
            : printed.length > 0
              ? ("completed" as const)
              : ("blocked" as const),
          items: jobs,
          message:
            hasUnknown
              ? "이전 로젠 송장 출력 결과가 불명확해 자동 재출력하지 않았습니다."
              : printed.length > 0
              ? "이미 송장번호가 있는 카톤은 자동으로 재출력하지 않았습니다."
              : "출력할 로젠 주문이 없습니다.",
        };
      }

      const inFlightMessage =
        "로젠 송장 출력 요청을 시작했습니다. 완료 기록 전 중단되면 자동 재출력하지 않습니다.";
      for (const job of pending) {
        this.store.updateShippingJob(job.id, {
          status: "unknown",
          error: inFlightMessage,
        });
        this.store.recordArtifact({
          id: deterministicArtifactId(input.runId, "waybill_print", [job.id]),
          runId: input.runId,
          shippingJobId: job.id,
          orderNo: job.orderNo,
          type: "waybill_print",
          status: "unknown",
          printerName: this.config.waybillPrinterName,
          message: inFlightMessage,
        });
      }
      const results = await this.ports.logen.printWaybills(pending, this.config.waybillPrinterName);
      for (const result of results) {
        const job = this.store.updateShippingJob(result.shippingJobId, {
          status: result.success && result.slipNo ? "waybill_printed" : result.status === "unknown" ? "unknown" : "failed",
          slipNo: result.slipNo,
          error: result.success ? undefined : result.message,
          waybillPrintedAt: result.success && result.slipNo ? this.isoNow() : undefined,
        });
        this.store.recordArtifact({
          id: deterministicArtifactId(input.runId, "waybill_print", [job.id]),
          runId: input.runId,
          shippingJobId: job.id,
          orderNo: job.orderNo,
          type: "waybill_print",
          status: result.success ? "submitted" : result.status ?? "unknown",
          printerName: this.config.waybillPrinterName,
          submittedAt: result.success ? this.isoNow() : undefined,
          message: result.message,
        });
      }
      const finalJobs = this.store.getShippingJobs(input.runId);
      const printedCount = finalJobs.filter((job) => job.status === "waybill_printed").length;
      const failedCount = finalJobs.filter((job) => ["failed", "unknown", "blocked"].includes(job.status)).length;
      return {
        status: aggregateStatus(printedCount, failedCount),
        items: finalJobs,
        message: `로젠 송장 ${printedCount}장을 ${this.config.waybillPrinterName}에 제출했습니다.`,
      };
    }, input.executionToken);
  }

  async confirmLogenWaybillNumbers(input: {
    runId: string;
    confirmations: LogenWaybillNumberConfirmation[];
    executionToken?: symbol;
  }): Promise<FulfillmentStageReply<ShippingJob>> {
    return this.runStage(input.runId, 14, async () => {
      const run = this.store.getRun(input.runId);
      if (run.workflowVersion < 2) {
        throw new Error("송장번호 사용자 확인은 워크플로 v2 이상 실행만 지원합니다.");
      }

      const batches = this.store.getLogenBatches(input.runId);
      if (batches.length === 0) throw new Error("확인할 로젠 PO·SKU 배치가 없습니다.");
      const expectedCartons = batches.flatMap((batch) =>
        this.store.getFulfillmentCartons(batch.id),
      );
      if (input.confirmations.length !== expectedCartons.length) {
        throw new Error(
          `송장번호 확인 행 ${input.confirmations.length}개가 계획 카톤 ${expectedCartons.length}개와 일치하지 않습니다.`,
        );
      }

      const confirmationByCarton = new Map<string, {
        originalSlipNo?: string;
        waybillNo?: string;
        selectedSlipNo: string;
        selectedSource: "original" | "waybill";
      }>();
      for (const confirmation of input.confirmations) {
        const key = `${confirmation.batchId}:${confirmation.cartonIndex}`;
        if (confirmationByCarton.has(key)) {
          throw new Error(`중복된 송장번호 확인 행입니다: ${key}`);
        }
        const carton = expectedCartons.find(
          (item) =>
            item.batchId === confirmation.batchId &&
            item.cartonIndex === confirmation.cartonIndex,
        );
        if (!carton) {
          throw new Error(`계획에 없는 카톤의 송장번호 확인입니다: ${key}`);
        }
        const originalSlipNo = normalizeLogenSlipNo(carton.originalSlipNo);
        const waybillNo = normalizeLogenSlipNo(carton.waybillNo);
        const selectedSlipNo =
          confirmation.selectedSource === "original" ? originalSlipNo : waybillNo;
        if (!selectedSlipNo) {
          throw new Error(
            `${confirmation.batchId} ${confirmation.cartonIndex}번 카톤의 ` +
              `${confirmation.selectedSource === "original" ? "원송장번호" : "운송장번호"} 후보가 로젠에서 조회되지 않았습니다.`,
          );
        }
        confirmationByCarton.set(key, {
          originalSlipNo,
          waybillNo,
          selectedSlipNo,
          selectedSource: confirmation.selectedSource,
        });
      }

      for (const carton of expectedCartons) {
        const key = `${carton.batchId}:${carton.cartonIndex}`;
        if (!confirmationByCarton.has(key)) {
          throw new Error(`계획 카톤의 송장번호 확인이 누락되었습니다: ${key}`);
        }
      }
      const selectedSlipNos = [...confirmationByCarton.values()].map(
        (item) => item.selectedSlipNo,
      );
      if (new Set(selectedSlipNos).size !== selectedSlipNos.length) {
        throw new Error("서로 다른 카톤에 같은 송장번호를 선택할 수 없습니다.");
      }

      const confirmedAt = this.isoNow();
      const existingStage13 = run.stages.find((stage) => stage.stage === 13);
      if (existingStage13?.status !== "completed") {
        for (const batch of batches) {
          this.store.updateLogenBatch(batch.id, {
            status: "registered",
            logenOrderNo: batch.logenOrderNo ?? batch.fixTakeNo,
            message: "사용자가 로젠 주문등록과 출력 대상 생성을 확인했습니다.",
            updatedAt: confirmedAt,
          });
        }
        for (const job of this.store
          .getShippingJobs(input.runId)
          .filter((item) => item.cartonIndex > 0)) {
          this.store.updateShippingJob(job.id, {
            status: "registered",
            error: undefined,
            logenRegisteredAt: job.logenRegisteredAt ?? confirmedAt,
          });
        }
        this.store.saveStageResult({
          runId: input.runId,
          stage: 13,
          status: "completed",
          message: "사용자 확인으로 로젠 주문등록 결과를 기록했습니다.",
          items: this.store.getShippingJobs(input.runId),
          updatedAt: confirmedAt,
        });
      }

      for (const batch of batches) {
        const cartons = this.store.getFulfillmentCartons(batch.id);
        for (const carton of cartons) {
          const confirmation = confirmationByCarton.get(
            `${batch.id}:${carton.cartonIndex}`,
          )!;
          this.store.updateFulfillmentCarton(batch.id, carton.cartonIndex, {
            slipNo: confirmation.selectedSlipNo,
            status: "waybill_assigned",
            message: undefined,
            updatedAt: confirmedAt,
          });

          const job = this.store
            .getShippingJobs(input.runId)
            .find(
              (item) =>
                item.orderNo === batch.orderNo &&
                item.skuCode === batch.skuCode &&
                item.cartonIndex === carton.cartonIndex,
            );
          if (!job) {
            throw new Error(
              `${batch.orderNo} ${batch.skuCode} ${carton.cartonIndex}번 카톤 작업이 없습니다.`,
            );
          }
          const updated = this.store.updateShippingJob(job.id, {
            status: "waybill_printed",
            slipNo: confirmation.selectedSlipNo,
            error: undefined,
            logenRegisteredAt: job.logenRegisteredAt ?? confirmedAt,
            waybillPrintedAt: confirmedAt,
          });
          this.store.recordArtifact({
            id: deterministicArtifactId(input.runId, "waybill_print", [job.id]),
            runId: input.runId,
            shippingJobId: updated.id,
            orderNo: updated.orderNo,
            type: "waybill_print",
            status: "submitted",
            printerName: this.config.waybillPrinterName,
            submittedAt: confirmedAt,
            message:
              `사용자 송장번호 확인 완료 · 원송장번호 ${confirmation.originalSlipNo ?? "-"}` +
              ` · 운송장번호 ${confirmation.waybillNo ?? "-"}` +
              ` · 선택 ${confirmation.selectedSource === "original" ? "원송장번호" : "운송장번호"}`,
          });
        }
        this.store.updateLogenBatch(batch.id, {
          status: "waybills_printed",
          logenOrderNo: batch.logenOrderNo ?? batch.fixTakeNo,
          waybillStatus: "submitted",
          waybillMessage: undefined,
          message: `사용자가 ${cartons.length}개 카톤의 송장번호를 확인했습니다.`,
          updatedAt: confirmedAt,
        });
      }

      const jobs = this.store.getShippingJobs(input.runId);
      return {
        status: "completed" as const,
        items: jobs,
        message: `사용자 확인을 거쳐 카톤 ${selectedSlipNos.length}건의 송장번호를 확정했습니다. 재출력은 실행하지 않았습니다.`,
      };
    }, input.executionToken);
  }

  async registerSupplierHubShipmentTracking(input: {
    runId: string;
    forceRetry?: boolean;
    shipDate?: string;
    shipTime?: string;
    executionToken?: symbol;
  }): Promise<FulfillmentStageReply<ShippingJob>> {
    return this.runStage(input.runId, 15, async () => {
      const shipmentGroups = this.store.getShipmentGroups(input.runId);
      if (
        shipmentGroups.length > 0 &&
        this.ports.shipmentHub &&
        this.ports.shipmentWorkbook
      ) {
        await this.ports.supplierHub.close?.();
        try {
          return await this.uploadSupplierHubShipmentWorkbook(
            input.runId,
            shipmentGroups,
            Boolean(input.forceRetry),
            false,
            input.shipDate,
            input.shipTime,
          );
        } finally {
          await this.ports.shipmentHub.close?.();
        }
      }

      // Compatibility/recovery path for direct per-order tracking entry.
      await this.ports.shipmentHub?.close?.();
      const jobs = this.store.getShippingJobs(input.runId);
      const groups = groupByOrder(jobs.filter((job) => job.slipNo));
      let successCount = 0;
      let failedCount = 0;
      const results: unknown[] = [];
      for (const [orderNo, orderJobs] of groups) {
        if (orderJobs.every((job) => ["tracking_registered", "documents_printed"].includes(job.status))) {
          successCount += orderJobs.length;
          continue;
        }
        const slipNos = [...new Set(orderJobs.map((job) => job.slipNo!).filter(Boolean))];
        const result = await this.ports.supplierHub.registerShipmentTracking(orderNo, slipNos);
        results.push(result);
        if (result.success) {
          for (const job of orderJobs) {
            this.store.updateShippingJob(job.id, {
              status: "tracking_registered",
              shipmentId: result.shipmentId,
              trackingRegisteredAt: this.isoNow(),
              error: undefined,
            });
          }
          successCount += orderJobs.length;
        } else {
          for (const job of orderJobs) {
            this.store.updateShippingJob(job.id, {
              status: "waybill_printed",
              error: result.message,
            });
          }
          failedCount += orderJobs.length;
        }
      }
      return {
        status: aggregateStatus(successCount, failedCount || (groups.size === 0 ? 1 : 0)),
        items: this.store.getShippingJobs(input.runId),
        message: `발주별 쉽먼트 ${groups.size}건에 카톤 송장번호를 등록했습니다.`,
      };
    }, input.executionToken);
  }

  async prepareSupplierHubShipmentTracking(input: {
    runId: string;
    shipDate?: string;
    shipTime?: string;
    executionToken?: symbol;
  }): Promise<FulfillmentStageReply<CoupangUploadJob>> {
    return this.runUnscopedStage(15, input.executionToken, async () => {
      const run = this.store.getRun(input.runId);
      if (run.workflowVersion < 3) {
        return reply(
          15,
          "blocked",
          [],
          `워크플로 v${run.workflowVersion} 실행은 기존 단계 기록 보존을 위해 읽기 전용입니다. 새 v3 Run을 사용하세요.`,
          { runId: input.runId },
        );
      }
      const shipmentGroups = this.store.getShipmentGroups(input.runId);
      if (
        shipmentGroups.length === 0 ||
        !this.ports.shipmentHub ||
        !this.ports.shipmentWorkbook
      ) {
        return reply(
          15,
          "blocked",
          [],
          "준비 테스트에 사용할 쉽먼트 그룹 또는 Supplier Hub 어댑터가 없습니다.",
          { runId: input.runId },
        );
      }

      await this.ports.supplierHub.close?.();
      const prepared = await this.uploadSupplierHubShipmentWorkbook(
        input.runId,
        shipmentGroups,
        false,
        true,
        input.shipDate,
        input.shipTime,
      );
      const uploadJobs = this.store.getCoupangUploadJobs(input.runId);
      const response = reply(
        15,
        prepared.status,
        uploadJobs,
        prepared.message,
        { runId: input.runId },
      );
      return {
        ...response,
        nextTool:
          prepared.status === "partial"
            ? "register_supplierhub_shipment_tracking"
            : undefined,
      };
    });
  }

  async printSupplierHubShipmentDocuments(input: {
    runId: string;
    forceReprint?: boolean;
    executionToken?: symbol;
  }): Promise<FulfillmentStageReply<ShippingJob>> {
    return this.runStage(input.runId, 16, async () => {
      const shipmentGroups = this.store.getShipmentGroups(input.runId);
      if (shipmentGroups.length > 0 && this.ports.shipmentHub) {
        await this.ports.supplierHub.close?.();
        try {
          return await this.printGroupedShipmentDocuments(
            input.runId,
            shipmentGroups,
            Boolean(input.forceReprint),
          );
        } finally {
          await this.ports.shipmentHub.close?.();
        }
      }

      // Compatibility path for direct per-order shipment document retrieval.
      await this.ports.shipmentHub?.close?.();
      const run = this.store.getRun(input.runId);
      const groups = groupByOrder(
        run.shippingJobs.filter(
          (job) =>
            ["tracking_registered", "documents_printed", "unknown"].includes(job.status) &&
            Boolean(job.shipmentId),
        ),
      );
      let successCount = 0;
      let failedCount = 0;
      let unknownCount = 0;
      for (const [orderNo, jobs] of groups) {
        const existing = run.artifacts.filter(
          (artifact) =>
            artifact.orderNo === orderNo &&
            ["shipment_label", "shipment_statement"].includes(artifact.type) &&
            artifact.status === "submitted",
        );
        if (existing.length >= 2 && !input.forceReprint) {
          successCount += 1;
          continue;
        }
        const unknown = run.artifacts.filter(
          (artifact) =>
            artifact.orderNo === orderNo &&
            ["shipment_label", "shipment_statement"].includes(artifact.type) &&
            artifact.status === "unknown",
        );
        if (unknown.length > 0 && !input.forceReprint) {
          unknownCount += 1;
          continue;
        }
        const shipmentId = jobs.find((job) => job.shipmentId)?.shipmentId;
        let printStarted = false;
        try {
          const documents = await this.ports.supplierHub.getShipmentDocuments(orderNo, shipmentId);
          const inFlightMessage =
            "쉽먼트 문서 인쇄 요청을 시작했습니다. 완료 기록 전 중단되면 자동 재출력하지 않습니다.";
          for (const document of documents.documents) {
            this.store.recordArtifact({
              id: deterministicArtifactId(run.id, document.type, [
                orderNo,
                shipmentId ?? "",
                document.filePath,
              ]),
              runId: run.id,
              orderNo,
              type: document.type,
              status: "unknown",
              fileName: document.fileName,
              filePath: document.filePath,
              printerName: this.config.shipmentPrinterName,
              message: inFlightMessage,
            });
          }
          printStarted = true;
          const result = await this.ports.printer.print({
            files: documents.documents.map((document) => ({
              fileName: document.fileName,
              filePath: document.filePath,
              documentType: document.type,
            })),
            printerName: this.config.shipmentPrinterName,
            copies: this.config.copies,
            kind: "shipment",
          });
          for (const document of documents.documents) {
            this.store.recordArtifact({
              id: deterministicArtifactId(run.id, document.type, [
                orderNo,
                shipmentId ?? "",
                document.filePath,
              ]),
              runId: run.id,
              orderNo,
              type: document.type,
              status: result.success ? "submitted" : result.status ?? "unknown",
              fileName: document.fileName,
              filePath: document.filePath,
              printerName: this.config.shipmentPrinterName,
              submittedAt: result.success ? this.isoNow() : undefined,
              message: result.message,
            });
          }
          if (result.success) {
            for (const job of jobs) {
              this.store.updateShippingJob(job.id, {
                status: "documents_printed",
                documentsPrintedAt: this.isoNow(),
              });
            }
            successCount += 1;
          } else {
            if (result.status === "unknown") {
              for (const job of jobs) {
                this.store.updateShippingJob(job.id, {
                  status: "unknown",
                  error: result.message,
                });
              }
              unknownCount += 1;
            } else {
              failedCount += 1;
            }
          }
        } catch (error) {
          if (printStarted) unknownCount += 1;
          else failedCount += 1;
          for (const job of jobs) {
            this.store.updateShippingJob(job.id, {
              status: printStarted ? "unknown" : "tracking_registered",
              error: printStarted
                ? `인쇄 요청 시작 후 결과를 확인하지 못했습니다. 자동 재출력하지 마세요. ${errorMessage(error)}`
                : errorMessage(error),
            });
          }
        }
      }
      return {
        status: outcomeAggregateStatus(
          successCount,
          failedCount || (groups.size === 0 ? 1 : 0),
          unknownCount,
        ),
        items: this.store.getShippingJobs(input.runId),
        message: `쉽먼트 ${successCount}건의 라벨과 내역서를 ${this.config.shipmentPrinterName}에 제출했습니다. 중단 ${failedCount}건, 결과 불명확 ${unknownCount}건.`,
      };
    }, input.executionToken);
  }

  async getFulfillmentRun(input: { runId: string }): Promise<object & { message?: string }> {
    const run = this.store.getRun(input.runId);
    return { ...run, message: `${run.id}의 현재 단계는 ${run.currentStage}, 상태는 ${run.status}입니다.` };
  }

  async listFulfillmentContexts(input: { limit?: number } = {}): Promise<Record<string, unknown> & { message?: string }> {
    const contexts = this.store.listRecentContexts(input.limit ?? 20);
    return {
      status: "completed",
      latestScanId: this.store.getLatestScanId(),
      latestRunId: this.store.getLatestRunId(),
      ...contexts,
      message: "최근 Scan ID와 Run ID를 불러왔습니다.",
    };
  }

  async deleteFulfillmentRunRecord(input: {
    runId: string;
    confirmation: string;
  }): Promise<Record<string, unknown> & { message?: string }> {
    if (input.confirmation !== input.runId) {
      throw new Error("Run 삭제 확인값이 Run ID와 일치하지 않습니다.");
    }
    return {
      status: "completed",
      ...this.store.deleteRunRecord(input.runId),
      message: `Run 기록 ${input.runId}을 삭제했습니다.`,
    };
  }

  async resetFulfillmentStageRecord(input: {
    runId: string;
    stage: FulfillmentStage;
    confirmation?: string;
    allowUnknown?: boolean;
    quickReset?: boolean;
    clearLogenRegistration?: boolean;
  }): Promise<Record<string, unknown> & { message?: string }> {
    const operationMode =
      (await this.config.operationModeReader?.()) ?? "calibration";
    const quickReset = input.quickReset === true && operationMode === "calibration";
    if (input.quickReset && !quickReset) {
      throw new Error("빠른 단계 이력 초기화는 calibration 테스트 모드에서만 사용할 수 있습니다.");
    }
    if (input.clearLogenRegistration && !quickReset) {
      throw new Error("로젠 예약키 초기화는 calibration 테스트 모드의 빠른 초기화에서만 사용할 수 있습니다.");
    }
    if (input.clearLogenRegistration && input.stage !== 13) {
      throw new Error("로젠 예약키 초기화는 13단계에서만 사용할 수 있습니다.");
    }
    if (!quickReset) {
      const expectedConfirmation = input.allowUnknown
        ? `${input.runId}:${input.stage}:NO_PRINT`
        : `${input.runId}:${input.stage}`;
      if (input.confirmation !== expectedConfirmation) {
        throw new Error(
          `단계 이력 초기화 확인값이 '${expectedConfirmation}'과 일치하지 않습니다.`,
        );
      }
    }
    const reset = this.store.resetStageRecord(
      input.runId,
      input.stage,
      this.isoNow(),
      input.allowUnknown === true,
      quickReset,
      input.clearLogenRegistration === true,
    );
    return {
      status: "completed",
      ...reset,
      message:
        `${input.runId}의 ${input.stage}단계 ${reset.previousStatus} 이력을 초기화했습니다.` +
        (reset.resetWaybillBatchIds.length > 0
          ? ` 로젠 송장 출력 대기상태 ${reset.resetWaybillBatchIds.length}건도 복구했습니다.`
          : "") +
        (reset.clearedLogenBatchIds.length > 0
          ? ` 로젠 예약키 ${reset.clearedLogenBatchIds.length}건과 등록상태도 초기화했습니다.`
          : ""),
    };
  }

  async deleteFulfillmentScanRecord(input: {
    scanId: string;
    confirmation: string;
  }): Promise<Record<string, unknown> & { message?: string }> {
    if (input.confirmation !== input.scanId) {
      throw new Error("Scan 삭제 확인값이 Scan ID와 일치하지 않습니다.");
    }
    const deleted = this.store.deleteScanRecord(input.scanId);
    return {
      status: "completed",
      ...deleted,
      message: `Scan 기록 ${input.scanId}과 연결된 Run ${deleted.deletedRunIds.length}건을 삭제했습니다.`,
    };
  }

  async runFulfillmentWorkflow(input: {
    lookAheadDays: 7 | 30;
    dateSearchType?: "expected_inbound_date" | "order_date";
    dateFrom?: string;
    dateTo?: string;
    dataSource: FulfillmentDataSource;
    logenMethod?: LogenIntegrationMethod;
    refreshMaster?: boolean;
    orderNos?: string[];
  }): Promise<object & { message?: string }> {
    const workflowMode = (await this.config.modeReader?.()) ?? "demo";
    const operationMode =
      (await this.config.operationModeReader?.()) ?? "calibration";
    if (workflowMode === "live" && operationMode !== "automatic") {
      return reply(
        1,
        "blocked",
        [],
        "실연동 calibration 모드에서는 16단계 전체 실행을 차단합니다. 통제된 발주를 단계별로 교정한 뒤 automatic으로 전환하세요.",
      );
    }
    if (this.busy || this.mutationOwner) {
      return reply(1, "blocked", [], "다른 Fulfillment 단계 또는 전체 실행이 진행 중입니다.");
    }
    const executionToken = Symbol("fulfillment-aggregate-run");
    this.busy = true;
    this.mutationOwner = executionToken;
    try {
      const opened = await this.openSupplierHub(executionToken);
      if (opened.status !== "completed") return opened;
      let lastResumedRunId: string | undefined;
      for (const resumableRunId of this.store.getAutomaticResumeRunIds()) {
        await this.resumeRun(
          resumableRunId,
          input.dataSource,
          input.logenMethod,
          input.refreshMaster,
          executionToken,
        );
        lastResumedRunId = resumableRunId;
      }
      const listed = await this.listPrivateLabelOrders({
        lookAheadDays: input.lookAheadDays,
        dateSearchType: input.dateSearchType,
        dateFrom: input.dateFrom,
        dateTo: input.dateTo,
        executionToken,
      });
      if (!listed.scanId) return listed;
      const compared = await this.compareNewOrders({
        scanId: listed.scanId,
        executionToken,
      });
      const requestedOrderNos = input.orderNos
        ? new Set(input.orderNos.map((value) => value.trim()).filter(Boolean))
        : undefined;
      const actionableOrderNos = compared.items
        .filter(
          (item) =>
            item.unprocessed &&
            ["needs_confirmation", "already_confirmed"].includes(item.disposition) &&
            (!requestedOrderNos || requestedOrderNos.has(item.order.orderNo)),
        )
        .map((item) => item.order.orderNo);
      if (actionableOrderNos.length === 0) {
        return lastResumedRunId
          ? this.getFulfillmentRun({ runId: lastResumedRunId })
          : compared;
      }
      const selected = await this.selectOrdersForFulfillment({
        scanId: listed.scanId,
        orderNos: actionableOrderNos,
        executionToken,
      });
      const runId = selected.runId!;

      const stages = [
        () => this.downloadOrderConfirmationTemplate({ runId, executionToken }),
        () => this.prepareOrderConfirmationWorkbook({ runId, executionToken }),
        () => this.uploadAndConfirmPrivateLabelOrders({ runId, executionToken }),
        () => this.downloadOrderFiles({ runId, executionToken }),
        () => this.printOrderFiles({ runId, executionToken }),
        () => this.recordPrintResult({ runId, executionToken }),
        () =>
          this.openLogenLogin({
            runId,
            logenMethod: input.logenMethod,
            executionToken,
          }),
        () =>
          this.openLogenSingleOrderRegistration({
            runId,
            logenMethod: input.logenMethod,
            executionToken,
          }),
        () =>
          this.registerLogenDeliveryOrder({
            runId,
            dataSource: input.dataSource,
            logenMethod: input.logenMethod,
            refreshMaster: input.refreshMaster,
            executionToken,
          }),
        () =>
          this.printLogenWaybill({
            runId,
            logenMethod: input.logenMethod,
            executionToken,
          }),
        () => this.registerSupplierHubShipmentTracking({ runId, executionToken }),
        () => this.printSupplierHubShipmentDocuments({ runId, executionToken }),
      ];
      for (const execute of stages) {
        const result = await execute();
        if (["blocked", "failed", "unknown"].includes(result.status)) break;
        if (result.stage >= 11 && result.stage < 14) await workflowDelay(1_000);
      }
      return this.getFulfillmentRun({ runId });
    } finally {
      this.busy = false;
      if (this.mutationOwner === executionToken) this.mutationOwner = undefined;
    }
  }

  private async resumeRun(
    runId: string,
    dataSource: FulfillmentDataSource,
    logenMethod: LogenIntegrationMethod | undefined,
    refreshMaster: boolean | undefined,
    executionToken: symbol,
  ): Promise<void> {
    const run = this.store.getRun(runId);
    if (run.workflowVersion !== 3) return;
    const currentRecord = run.stages.find((record) => record.stage === run.currentStage);
    let startStage =
      run.currentStage < 5
        ? 5
        : currentRecord?.status === "completed"
          ? run.currentStage + 1
          : run.currentStage;
    if (
      run.currentStage >= 15 &&
      (run.shipmentGroups ?? []).some((group) =>
        ["ready", "blocked", "created"].includes(group.status),
      )
    ) {
      startStage = 15;
    }

    const stages: Array<{
      stage: number;
      execute: () => Promise<FulfillmentStageReply>;
    }> = [
      {
        stage: 5,
        execute: () => this.downloadOrderConfirmationTemplate({ runId, executionToken }),
      },
      {
        stage: 6,
        execute: () => this.prepareOrderConfirmationWorkbook({ runId, executionToken }),
      },
      {
        stage: 7,
        execute: () => this.uploadAndConfirmPrivateLabelOrders({ runId, executionToken }),
      },
      { stage: 8, execute: () => this.downloadOrderFiles({ runId, executionToken }) },
      { stage: 9, execute: () => this.printOrderFiles({ runId, executionToken }) },
      { stage: 10, execute: () => this.recordPrintResult({ runId, executionToken }) },
      {
        stage: 11,
        execute: () =>
          this.openLogenLogin({
            runId,
            logenMethod,
            executionToken,
          }),
      },
      {
        stage: 12,
        execute: () =>
          this.openLogenSingleOrderRegistration({
            runId,
            logenMethod,
            executionToken,
          }),
      },
      {
        stage: 13,
        execute: () =>
          this.registerLogenDeliveryOrder({
            runId,
            dataSource,
            logenMethod,
            refreshMaster,
            executionToken,
          }),
      },
      {
        stage: 14,
        execute: () =>
          this.printLogenWaybill({ runId, logenMethod, executionToken }),
      },
      {
        stage: 15,
        execute: () =>
          this.registerSupplierHubShipmentTracking({ runId, executionToken }),
      },
      {
        stage: 16,
        execute: () =>
          this.printSupplierHubShipmentDocuments({ runId, executionToken }),
      },
    ];
    for (const stage of stages) {
      if (stage.stage < startStage) continue;
      const result = await stage.execute();
      if (["blocked", "failed", "unknown"].includes(result.status)) break;
      if (result.stage >= 11 && result.stage < 14) await workflowDelay(1_000);
    }
  }

  private async printLogenBatchWaybills(
    runId: string,
    batches: LogenBatch[],
    forceReprint: boolean,
    logenMethod: LogenIntegrationMethod,
  ): Promise<{
    status: FulfillmentStageStatus;
    items: ShippingJob[];
    message: string;
  }> {
    const run = this.store.getRun(runId);
    let pending = batches.filter((batch) => {
      const waybillStatus = batch.waybillStatus ?? "not_started";
      const hasRegistrationKeys = Boolean(
        batch.registrationKeys?.length || batch.logenOrderNo,
      );
      if (
        batch.status === "registered" &&
        ["not_started", "failed"].includes(waybillStatus)
      ) {
        return true;
      }
      if (
        forceReprint &&
        hasRegistrationKeys &&
        ["in_flight", "unknown", "submitted"].includes(waybillStatus)
      ) {
        return true;
      }
      // Compatibility for a pre-v10 record that persisted registration keys
      // but used the aggregate status for a pre-print failure.
      if (
        batch.status === "failed" &&
        hasRegistrationKeys &&
        ["not_started", "failed"].includes(waybillStatus)
      ) {
        return true;
      }
      // Stage 13 already saved the order, but an older build failed to persist
      // its multiple reservation rows. Stage 14 may reconcile exact unprinted
      // rows; it must never submit stage 13 again.
      if (
        logenMethod === "website_mcp" &&
        ["unknown", "failed"].includes(batch.status) &&
        !hasRegistrationKeys &&
        ["not_started", "failed"].includes(waybillStatus) &&
        (batch.message?.includes("저장은 완료됐지만 새 예약행") ||
          hasSavedUnreconciledLogenEvidence(run.stages, batch))
      ) {
        return true;
      }
      return Boolean(
        forceReprint &&
          ["unknown", "waybills_printed", "completed"].includes(batch.status),
      );
    });
    if (pending.length === 0) {
      const printedCartons = batches.flatMap((batch) =>
        this.store.getFulfillmentCartons(batch.id).filter((carton) => carton.slipNo),
      );
      const hasUnknown = batches.some(
        (batch) =>
          batch.status === "unknown" ||
          ["in_flight", "unknown", "submitted"].includes(
            batch.waybillStatus ?? "not_started",
          ),
      );
      const firstWaybillFailure = batches.find(
        (batch) => batch.waybillStatus === "failed",
      )?.waybillMessage;
      return {
        status: hasUnknown
          ? "unknown"
          : printedCartons.length > 0
            ? "completed"
            : "blocked",
        items: this.store.getShippingJobs(runId),
        message: hasUnknown
          ? "이전 송장 출력 결과가 불명확해 자동 재출력하지 않았습니다."
          : firstWaybillFailure
            ? `로젠 주문등록 기록은 유지했습니다. 송장 출력 전 중단: ${firstWaybillFailure}`
          : printedCartons.length > 0
            ? "이미 송장번호가 있는 PO·SKU 배치는 자동으로 재출력하지 않았습니다."
            : "출력할 로젠 PO·SKU 배치가 없습니다.",
      };
    }

    const recipientNamesByBatchId: Record<string, string> = {};
    for (const batch of pending) {
      const order = run.orders.find((item) => item.orderNo === batch.orderNo);
      if (!order) continue;
      const center =
        this.store.getCenterMaster(order.centerCode) ??
        this.store.getOrderFileCenter(order.orderNo);
      recipientNamesByBatchId[batch.id] = center?.centerName || order.centerName;
    }

    const batchPort = this.ports.logen as LogenPort & LogenBatchPort;
    if (logenMethod === "website_mcp" && batchPort.inspectBatchWaybills) {
      const inspectedAt = this.isoNow();
      const inspections = await batchPort.inspectBatchWaybills(pending, {
        integrationMethod: logenMethod,
        forceReprint,
        recipientNamesByBatchId,
      });
      const inspectionByBatch = new Map(
        inspections.map((inspection) => [inspection.batchId, inspection]),
      );
      const printableIds = new Set<string>();
      for (const batch of pending) {
        const inspection = inspectionByBatch.get(batch.id);
        if (!inspection?.success) {
          this.store.updateLogenBatch(batch.id, {
            waybillStatus: "failed",
            waybillMessage:
              inspection?.message ?? "로젠 예약행 출력 상태를 확인하지 못했습니다.",
            updatedAt: inspectedAt,
          });
          continue;
        }
        const registrationKeys = inspection.registrationKeys;
        const registrationComplete =
          registrationKeys.length === batch.cartonCount &&
          new Set(registrationKeys).size === batch.cartonCount;
        if (!registrationComplete) {
          this.store.updateLogenBatch(batch.id, {
            waybillStatus: "failed",
            waybillMessage:
              `예약행 키 ${registrationKeys.length}개가 계획 카톤 ${batch.cartonCount}개와 일치하지 않습니다.`,
            updatedAt: inspectedAt,
          });
          continue;
        }
        if (inspection.printState === "mixed") {
          this.store.updateLogenBatch(batch.id, {
            waybillStatus: "unknown",
            waybillMessage:
              "같은 배치에 출력·미출력 예약행이 함께 있어 자동 출력을 중단했습니다.",
            updatedAt: inspectedAt,
          });
          continue;
        }
        if (inspection.printState === "printed" && !forceReprint) {
          this.store.updateLogenBatch(batch.id, {
            logenOrderNo: registrationKeys[0],
            registrationKeys,
            registrationRecordedAt: batch.registrationRecordedAt ?? inspectedAt,
            waybillStatus: "unknown",
            waybillMessage:
              "저장된 예약행이 이미 출력되어 자동 재출력하지 않았습니다.",
            message: batch.message,
            updatedAt: inspectedAt,
          });
          continue;
        }

        this.store.updateLogenBatch(batch.id, {
          status: "registered",
          logenOrderNo: registrationKeys[0],
          registrationKeys,
          registrationRecordedAt: batch.registrationRecordedAt ?? inspectedAt,
          waybillStatus: "not_started",
          waybillMessage: undefined,
          message:
            batch.status === "registered"
              ? batch.message
              : "13단계 저장 완료 기록과 로젠 미출력 예약행을 대조해 등록 식별자를 복구했습니다.",
          updatedAt: inspectedAt,
        });
        for (const job of this.store
          .getShippingJobs(runId)
          .filter(
            (item) =>
              item.orderNo === batch.orderNo && item.skuCode === batch.skuCode,
          )) {
          this.store.updateShippingJob(job.id, {
            status: "registered",
            error: undefined,
            logenRegisteredAt: job.logenRegisteredAt ?? inspectedAt,
          });
        }
        printableIds.add(batch.id);
      }
      const refreshed = new Map(
        this.store.getLogenBatches(runId).map((batch) => [batch.id, batch]),
      );
      pending = pending
        .filter((batch) => printableIds.has(batch.id))
        .map((batch) => refreshed.get(batch.id) ?? batch);
      if (pending.length === 0) {
        const current = this.store.getLogenBatches(runId);
        const hasUnknown = current.some(
          (batch) =>
            batch.status === "unknown" || batch.waybillStatus === "unknown",
        );
        const reason = current.find(
          (batch) => ["failed", "unknown"].includes(batch.waybillStatus ?? ""),
        )?.waybillMessage;
        return {
          status: hasUnknown ? "unknown" : "blocked",
          items: this.store.getShippingJobs(runId),
          message: reason ?? "출력 가능한 로젠 예약행을 확인하지 못했습니다.",
        };
      }
    }
    const inFlightMessage =
      "로젠 송장 출력 요청을 시작했습니다. 완료 기록 전 중단되면 자동 재출력하지 않습니다.";
    for (const batch of pending) {
      this.store.updateLogenBatch(batch.id, {
        waybillStatus: "in_flight",
        waybillMessage: inFlightMessage,
        updatedAt: this.isoNow(),
      });
      for (const job of this.store
        .getShippingJobs(runId)
        .filter(
          (item) => item.orderNo === batch.orderNo && item.skuCode === batch.skuCode,
        )) {
        this.store.recordArtifact({
          id: deterministicArtifactId(runId, "waybill_print", [job.id]),
          runId,
          shippingJobId: job.id,
          orderNo: job.orderNo,
          type: "waybill_print",
          status: "unknown",
          printerName: this.config.waybillPrinterName,
          message: inFlightMessage,
        });
      }
    }
    const results = await batchPort.printBatchWaybills(
      pending,
      this.config.waybillPrinterName,
      {
        integrationMethod: logenMethod,
        forceReprint,
        recipientNamesByBatchId,
      },
    );
    const byBatch = new Map(results.map((result) => [result.batchId, result]));

    for (const batch of pending) {
      const result = byBatch.get(batch.id);
      if (!result) {
        this.store.updateLogenBatch(batch.id, {
          waybillStatus: "unknown",
          waybillMessage: "로젠이 이 배치의 송장 출력 결과를 반환하지 않았습니다.",
          updatedAt: this.isoNow(),
        });
        continue;
      }

      const fallbackCandidates: Array<{
        cartonIndex: number;
        originalSlipNo?: string;
        waybillNo?: string;
      }> = result.slipNos.map((waybillNo, index) => ({
        cartonIndex: index + 1,
        waybillNo,
      }));
      const numberCandidates = (result.numberCandidates ?? fallbackCandidates)
        .map((candidate) => ({
          cartonIndex: candidate.cartonIndex,
          originalSlipNo: normalizeLogenSlipNo(candidate.originalSlipNo),
          waybillNo: normalizeLogenSlipNo(candidate.waybillNo),
        }))
        .filter((candidate) => candidate.originalSlipNo || candidate.waybillNo)
        .sort((left, right) => left.cartonIndex - right.cartonIndex);
      const candidateSlipNos = numberCandidates
        .map((candidate) => candidate.waybillNo ?? candidate.originalSlipNo)
        .filter((value): value is string => Boolean(value));
      const candidateCartonIndexes = numberCandidates.map(
        (candidate) => candidate.cartonIndex,
      );
      const exactCount =
        result.success &&
        numberCandidates.length === batch.cartonCount &&
        new Set(candidateCartonIndexes).size === batch.cartonCount &&
        candidateCartonIndexes.every(
          (cartonIndex) => cartonIndex >= 1 && cartonIndex <= batch.cartonCount,
        ) &&
        candidateSlipNos.length === batch.cartonCount &&
        new Set(candidateSlipNos).size === batch.cartonCount;
      const prePrintFailure = !result.success && result.status === "failed";
      const outcomeStatus = exactCount
        ? "unknown"
        : result.status === "unknown" || result.success
          ? "unknown"
          : batch.status;
      const waybillStatus = exactCount
        ? "submitted"
        : prePrintFailure
          ? "failed"
          : "unknown";
      const message = exactCount
        ? `송장 ${numberCandidates.length}장 출력이 제출되었습니다. 원송장번호와 운송장번호를 사용자가 확인해야 합니다.`
        : result.success
          ? `송장번호 후보 ${numberCandidates.length}개가 계획 카톤 ${batch.cartonCount}개와 일치하지 않습니다.`
          : result.message;

      this.store.updateLogenBatch(batch.id, {
        status: outcomeStatus,
        logenOrderNo: result.registrationKeys?.[0] ?? batch.logenOrderNo,
        registrationKeys: result.registrationKeys ?? batch.registrationKeys,
        registrationRecordedAt:
          batch.registrationRecordedAt ??
          (result.registrationKeys?.length ? this.isoNow() : undefined),
        waybillStatus,
        waybillMessage: message,
        message: prePrintFailure ? batch.message : message,
        updatedAt: this.isoNow(),
      });

      const cartons = this.store.getFulfillmentCartons(batch.id);
      if (exactCount) {
        for (const carton of cartons) {
          const candidate = numberCandidates.find(
            (item) => item.cartonIndex === carton.cartonIndex,
          )!;
          this.store.updateFulfillmentCarton(batch.id, carton.cartonIndex, {
            originalSlipNo: candidate.originalSlipNo,
            waybillNo: candidate.waybillNo,
            slipNo: undefined,
            status: "unknown",
            message,
            updatedAt: this.isoNow(),
          });
        }
      } else if (!prePrintFailure) {
        for (const carton of cartons) {
          this.store.updateFulfillmentCarton(batch.id, carton.cartonIndex, {
            status: outcomeStatus === "unknown" ? "unknown" : "failed",
            message,
            updatedAt: this.isoNow(),
          });
        }
      }

      const mirrorJobs = this.store
        .getShippingJobs(runId)
        .filter(
          (job) =>
            job.orderNo === batch.orderNo &&
            job.skuCode === batch.skuCode &&
            job.cartonIndex > 0,
        )
        .sort((left, right) => left.cartonIndex - right.cartonIndex);
      for (const job of mirrorJobs) {
        const updated = prePrintFailure
          ? job
          : this.store.updateShippingJob(job.id, {
              status: "unknown",
              slipNo: undefined,
              error: message,
              waybillPrintedAt: undefined,
            });
        this.store.recordArtifact({
          runId,
          shippingJobId: updated.id,
          orderNo: updated.orderNo,
          type: "waybill_print",
          status: prePrintFailure ? "failed" : "unknown",
          printerName: this.config.waybillPrinterName,
          submittedAt: exactCount ? this.isoNow() : undefined,
          message,
        });
      }
    }

    const finalBatches = this.store.getLogenBatches(runId);
    const printedBatches = finalBatches.filter((batch) =>
      ["waybills_printed", "completed"].includes(batch.status),
    ).length;
    const unknownBatches = finalBatches.filter(
      (batch) =>
        batch.status === "unknown" ||
        ["in_flight", "unknown", "submitted"].includes(
          batch.waybillStatus ?? "not_started",
        ),
    ).length;
    const blockedBatches = finalBatches.filter((batch) =>
      ["blocked", "failed"].includes(batch.status) || batch.waybillStatus === "failed",
    ).length;
    const candidateCartons = finalBatches.reduce(
      (total, batch) =>
        total +
        this.store
          .getFulfillmentCartons(batch.id)
          .filter((carton) => carton.originalSlipNo || carton.waybillNo).length,
      0,
    );
    return {
      status: outcomeAggregateStatus(printedBatches, blockedBatches, unknownBatches),
      items: this.store.getShippingJobs(runId),
      message:
        candidateCartons > 0 && unknownBatches > 0
          ? `${displayLogenMethod(logenMethod)}로 로젠 송장 ${candidateCartons}장의 번호 후보를 조회했습니다. 원송장번호와 운송장번호 중 사용할 번호를 선택해야 합니다.`
          : blockedBatches > 0
            ? `로젠 주문등록 기록은 유지했습니다. 송장 출력 전 중단: ${finalBatches.find((batch) => batch.waybillStatus === "failed")?.waybillMessage ?? "출력 화면을 확인하지 못했습니다."}`
          : `${displayLogenMethod(logenMethod)}로 PO·SKU 배치 ${printedBatches}건의 로젠 송장 ${candidateCartons}장을 ${this.config.waybillPrinterName}에 제출했습니다.`,
    };
  }

  private async uploadSupplierHubShipmentWorkbook(
    runId: string,
    shipmentGroups: ShipmentGroup[],
    forceRetry: boolean,
    prepareOnly = false,
    requestedShipDateInput?: string,
    requestedShipTimeInput?: string,
  ): Promise<{
    status: FulfillmentStageStatus;
    items: ShippingJob[];
    message: string;
  }> {
    const batches = this.store.getLogenBatches(runId);
    const today = dateInTimeZone(this.now(), "Asia/Seoul");
    const requestedShipDate = normalizeOptionalShipDate(requestedShipDateInput);
    const requestedShipTime = normalizeOptionalShipTime(requestedShipTimeInput);
    const existingJobs = this.store.getCoupangUploadJobs(runId);
    const confirmedGroupIds = new Set(
      existingJobs
        .filter((job) => job.status === "confirmed")
        .flatMap((job) => job.shipmentGroupIds ?? []),
    );
    const hasUnscopedConfirmedUpload = existingJobs.some(
      (job) =>
        job.status === "confirmed" && (job.shipmentGroupIds?.length ?? 0) === 0,
    );
    const completedGroups = shipmentGroups.filter(
      (group) =>
        Boolean(group.shipmentId) &&
        ["tracking_uploaded", "documents_printed", "completed"].includes(group.status),
    );
    const newUploadGroups: ShipmentGroup[] = [];
    const groupsToMap: ShipmentGroup[] = [];
    let blockedGroups = 0;
    let unknownGroups = 0;

    for (const group of shipmentGroups) {
      if (completedGroups.some((item) => item.id === group.id)) continue;
      if (group.orderNos.length !== 1) {
        this.store.updateShipmentGroup(group.id, {
          status: "unknown",
          message:
            "발주별 쉽먼트 원칙과 맞지 않는 기존 다중 발주 그룹이라 자동 처리하지 않았습니다.",
          updatedAt: this.isoNow(),
        });
        unknownGroups += 1;
        continue;
      }
      if (confirmedGroupIds.has(group.id)) {
        groupsToMap.push(group);
        continue;
      }
      const groupBatches = batches.filter(
        (batch) => batch.cartonCount > 0 && group.orderNos.includes(batch.orderNo),
      );
      const groupCartons = groupBatches.flatMap((batch) =>
        this.store.getFulfillmentCartons(batch.id),
      );
      const missingWaybills = groupCartons.filter(
        (carton) =>
          !carton.slipNo || carton.status === "unknown" || carton.status === "failed",
      );
      if (groupCartons.length === 0 || missingWaybills.length > 0) {
        const isUnknown =
          missingWaybills.some((carton) => carton.status === "unknown") ||
          groupBatches.some((batch) => batch.status === "unknown");
        this.store.updateShipmentGroup(group.id, {
          status: isUnknown ? "unknown" : "blocked",
          message:
            groupCartons.length === 0
              ? "이 그룹에는 쉽먼트에 올릴 정상 카톤이 없습니다."
              : `송장번호가 확정되지 않은 카톤 ${missingWaybills.length}건이 있습니다.`,
          updatedAt: this.isoNow(),
        });
        if (isUnknown) unknownGroups += 1;
        else blockedGroups += 1;
        continue;
      }
      const savedGroupJob = existingJobs.find(
        (job) =>
          job.shipmentGroupId === group.id ||
          (job.shipmentGroupIds ?? []).includes(group.id),
      );
      const groupShipDate = requestedShipDate ?? savedGroupJob?.shipDate ?? today;
      if (!chooseAutomaticShipDate(group.expectedInboundDate, groupShipDate)) {
        this.store.updateShipmentGroup(group.id, {
          status: "blocked",
          message: `발송일 ${groupShipDate}은 이 그룹의 허용 출고일(EDD D-3~D-1)이 아닙니다.`,
          updatedAt: this.isoNow(),
        });
        blockedGroups += 1;
        continue;
      }
      newUploadGroups.push(group);
    }

    if (hasUnscopedConfirmedUpload && newUploadGroups.length > 0) {
      for (const group of newUploadGroups) {
        this.store.updateShipmentGroup(group.id, {
          status: "unknown",
          message:
            "기존 확정 업로드에 포함된 그룹 범위를 식별할 수 없어 중복 업로드를 차단했습니다.",
          updatedAt: this.isoNow(),
        });
      }
      unknownGroups += newUploadGroups.length;
      newUploadGroups.length = 0;
    }

    let uploadMessage = "";
    if (newUploadGroups.length > 0) {
      const uploadOrderNos = new Set(
        newUploadGroups.flatMap((group) => group.orderNos),
      );
      const runnableBatches = batches.filter(
        (batch) => batch.cartonCount > 0 && uploadOrderNos.has(batch.orderNo),
      );
      const cartons = runnableBatches.flatMap((batch) =>
        this.store.getFulfillmentCartons(batch.id),
      );
      const uploadJobId = deterministicUploadJobId(
        runId,
        newUploadGroups.map((group) => group.id),
      );
      let uploadJob = existingJobs.find((job) => job.id === uploadJobId);
      const shipDate = requestedShipDate ?? uploadJob?.shipDate ?? today;
      const shipTime =
        requestedShipTime ?? uploadJob?.shipTime ?? this.config.shipTime ?? "16:00";
      const unresolved =
        uploadJob && ["unknown", "failed", "uploaded"].includes(uploadJob.status)
          ? uploadJob
          : undefined;

      if (unresolved && !forceRetry) {
        const isUnknown = unresolved.status === "unknown" || unresolved.status === "uploaded";
        for (const group of newUploadGroups) {
          this.store.updateShipmentGroup(group.id, {
            status: isUnknown ? "unknown" : "failed",
            message: `이전 쉽먼트 일괄등록 상태가 ${unresolved.status}여서 자동 재업로드하지 않았습니다.`,
            updatedAt: this.isoNow(),
          });
        }
        if (isUnknown) unknownGroups += newUploadGroups.length;
        else blockedGroups += newUploadGroups.length;
        uploadMessage =
          `이전 쉽먼트 일괄등록 상태가 ${unresolved.status}여서 자동 재업로드하지 않았습니다.`;
      } else {
        if (!uploadJob) {
          const workbook = await this.ports.shipmentWorkbook!.build({
            runId,
            orders: this.store
              .getRun(runId)
              .orders.filter((order) => uploadOrderNos.has(order.orderNo)),
            batches: runnableBatches,
            cartons,
          });
          uploadJob = {
            id: uploadJobId,
            runId,
            shipmentGroupId:
              newUploadGroups.length === 1 ? newUploadGroups[0].id : undefined,
            shipmentGroupIds: newUploadGroups.map((group) => group.id),
            fileName: workbook.fileName,
            filePath: workbook.filePath,
            shipDate,
            shipTime,
            status: "prepared",
            message: "송장입력용 XLSX를 생성했습니다.",
            createdAt: this.isoNow(),
            updatedAt: this.isoNow(),
          };
          this.store.saveCoupangUploadJobs([uploadJob]);
          uploadJob = this.store.getCoupangUploadJob(uploadJob.id) ?? uploadJob;
        } else if (unresolved && forceRetry) {
          uploadJob = this.store.updateCoupangUploadJob(uploadJob.id, {
            shipDate,
            shipTime,
            status: "prepared",
            message: "사용자가 쉽먼트 일괄등록 재시도를 명시했습니다.",
            updatedAt: this.isoNow(),
          });
        } else if (
          uploadJob.status === "prepared" &&
          (uploadJob.shipDate !== shipDate || uploadJob.shipTime !== shipTime)
        ) {
          uploadJob = this.store.updateCoupangUploadJob(uploadJob.id, {
            shipDate,
            shipTime,
            message: "사용자가 지정한 발송일·시간을 미제출 작업에 저장했습니다.",
            updatedAt: this.isoNow(),
          });
        }

        if (uploadJob.status !== "confirmed") {
          if (prepareOnly) {
            const preview = await this.ports.shipmentHub!.uploadTrackingWorkbook({
              fileName: uploadJob.fileName,
              filePath: uploadJob.filePath,
              expectedInboundDate: newUploadGroups[0].expectedInboundDate,
              shipDate: uploadJob.shipDate,
              shipTime: uploadJob.shipTime,
              submit: false,
              expectedGroupCount: newUploadGroups.length,
              shipmentGroups: newUploadGroups.map((group) => ({
                orderNo: group.orderNos[0],
                centerCode: group.centerCode,
                expectedInboundDate: group.expectedInboundDate,
              })),
            });
            uploadJob = this.store.updateCoupangUploadJob(uploadJob.id, {
              status: "prepared",
              message: preview.message,
              updatedAt: this.isoNow(),
            });
            if (preview.status === "prepared") {
              for (const group of newUploadGroups) {
                this.store.updateShipmentGroup(group.id, {
                  status: "ready",
                  message: "쉽먼트 XLSX 준비 테스트를 마쳤습니다. 실제 업로드는 실행하지 않았습니다.",
                  updatedAt: this.isoNow(),
                });
              }
              return {
                status: "partial",
                items: this.store.getShippingJobs(runId),
                message:
                  `15단계 준비 테스트 완료: ${uploadJob.filePath} 파일을 첨부하고 요약 화면을 확인했습니다. 실제 업로드는 실행하지 않았습니다.`,
              };
            }
            for (const group of newUploadGroups) {
              this.store.updateShipmentGroup(group.id, {
                status: preview.status === "unknown" ? "unknown" : "blocked",
                message: preview.message,
                updatedAt: this.isoNow(),
              });
            }
            return {
              status: preview.status === "unknown" ? "unknown" : "blocked",
              items: this.store.getShippingJobs(runId),
              message: `15단계 준비 화면을 확인하지 못했습니다. 실제 업로드는 실행하지 않았습니다: ${preview.message}`,
            };
          }
          uploadJob = this.store.updateCoupangUploadJob(uploadJob.id, {
            status: "unknown",
            message:
              "Supplier Hub 쉽먼트 제출을 시작했습니다. 완료 기록 전 중단되면 자동 재업로드하지 않습니다.",
            updatedAt: this.isoNow(),
          });
          try {
            const submission = await this.ports.shipmentHub!.uploadTrackingWorkbook({
              fileName: uploadJob.fileName,
              filePath: uploadJob.filePath,
              expectedInboundDate: newUploadGroups[0].expectedInboundDate,
              shipDate: uploadJob.shipDate,
              shipTime: uploadJob.shipTime,
              submit: true,
              expectedGroupCount: newUploadGroups.length,
              shipmentGroups: newUploadGroups.map((group) => ({
                orderNo: group.orderNos[0],
                centerCode: group.centerCode,
                expectedInboundDate: group.expectedInboundDate,
              })),
            });
            uploadJob = this.store.updateCoupangUploadJob(uploadJob.id, {
              status: submission.status,
              uploadNumber: submission.uploadNumber,
              message: submission.message,
              updatedAt: this.isoNow(),
            });
          } catch (error) {
            uploadJob = this.store.updateCoupangUploadJob(uploadJob.id, {
              status: "unknown",
              message:
                `쉽먼트 제출 시작 후 결과를 확인하지 못했습니다. 자동 재업로드하지 마세요. ${errorMessage(error)}`,
              updatedAt: this.isoNow(),
            });
          }
        }

        if (uploadJob.status === "confirmed") {
          groupsToMap.push(...newUploadGroups);
        } else {
          const isUnknown = uploadJob.status === "unknown" || uploadJob.status === "uploaded";
          for (const group of newUploadGroups) {
            this.store.updateShipmentGroup(group.id, {
              status: isUnknown ? "unknown" : "failed",
              message: uploadJob.message ?? uploadJob.status,
              updatedAt: this.isoNow(),
            });
          }
          if (isUnknown) unknownGroups += newUploadGroups.length;
          else blockedGroups += newUploadGroups.length;
          uploadMessage =
            `쉽먼트 XLSX 일괄등록이 확정되지 않았습니다: ${uploadJob.message ?? uploadJob.status}`;
        }
      }
    }

    if (groupsToMap.length === 0) {
      const mapped = completedGroups.length;
      return {
        status: outcomeAggregateStatus(mapped, blockedGroups, unknownGroups),
        items: this.store.getShippingJobs(runId),
        message:
          uploadMessage || (mapped > 0
            ? `이미 연결된 쉽먼트 ${mapped}건을 재사용했습니다. 현재 처리 가능한 추가 그룹은 없습니다.`
            : `처리 가능한 쉽먼트 그룹이 없습니다. 중단 ${blockedGroups}건, 결과 불명확 ${unknownGroups}건입니다.`),
      };
    }

    const summariesByDate = new Map<string, Awaited<ReturnType<SupplierHubShipmentPort["listShipmentSummaries"]>>>();
    for (const expectedInboundDate of new Set(
      groupsToMap.map((group) => group.expectedInboundDate),
    )) {
      const dateOrderNos = groupsToMap
        .filter((group) => group.expectedInboundDate === expectedInboundDate)
        .map((group) => group.orderNos[0]);
      summariesByDate.set(
        expectedInboundDate,
        await this.ports.shipmentHub!.listShipmentSummaries(
          expectedInboundDate,
          dateOrderNos,
        ),
      );
    }

    let mapped = completedGroups.length;
    let unmapped = 0;
    for (const group of groupsToMap) {
      const matches = (summariesByDate.get(group.expectedInboundDate) ?? []).filter(
        (summary) =>
          summary.orderNo === group.orderNos[0] &&
          summary.centerCode === group.centerCode &&
          summary.expectedInboundDate === group.expectedInboundDate,
      );
      if (matches.length !== 1) {
        this.store.updateShipmentGroup(group.id, {
          status: matches.length === 0 ? "created" : "unknown",
          message:
            matches.length === 0
              ? "업로드 완료 후 일치하는 쉽먼트를 찾지 못했습니다."
              : "같은 센터·입고예정일의 쉽먼트가 여러 건이라 자동 연결하지 않았습니다.",
          updatedAt: this.isoNow(),
        });
        unmapped += 1;
        continue;
      }

      const shipmentId = matches[0].shipmentId;
      this.store.updateShipmentGroup(group.id, {
        shipmentId,
        status: "tracking_uploaded",
        message: "XLSX 일괄등록 후 쉽먼트를 연결했습니다.",
        updatedAt: this.isoNow(),
      });
      for (const batch of batches.filter(
        (item) => item.cartonCount > 0 && group.orderNos.includes(item.orderNo),
      )) {
        for (const carton of this.store.getFulfillmentCartons(batch.id)) {
          this.store.updateFulfillmentCarton(batch.id, carton.cartonIndex, {
            status: "uploaded",
            message: undefined,
            updatedAt: this.isoNow(),
          });
        }
      }
      for (const job of this.store
        .getShippingJobs(runId)
        .filter((item) => group.orderNos.includes(item.orderNo) && item.slipNo)) {
        this.store.updateShippingJob(job.id, {
          status: "tracking_registered",
          shipmentId,
          trackingRegisteredAt: this.isoNow(),
          error: undefined,
        });
      }
      mapped += 1;
    }

    return {
      status: outcomeAggregateStatus(
        mapped,
        blockedGroups,
        unknownGroups + unmapped,
      ),
      items: this.store.getShippingJobs(runId),
      message: `송장입력 XLSX를 처리했고 발주별 쉽먼트 ${mapped}/${shipmentGroups.length}건을 연결했습니다. 중단 ${blockedGroups}건, 결과 불명확 ${unknownGroups + unmapped}건입니다.`,
    };
  }

  private async printGroupedShipmentDocuments(
    runId: string,
    shipmentGroups: ShipmentGroup[],
    forceReprint: boolean,
  ): Promise<{
    status: FulfillmentStageStatus;
    items: ShippingJob[];
    message: string;
  }> {
    const uploadJobs = this.store.getCoupangUploadJobs(runId);
    if (uploadJobs.length === 0) {
      return {
        status: "blocked",
        items: this.store.getShippingJobs(runId),
        message: "15단계 쉽먼트 XLSX 일괄등록 기록이 없습니다.",
      };
    }
    const confirmedUploadJobs = uploadJobs.filter((job) => job.status === "confirmed");
    if (confirmedUploadJobs.length === 0) {
      const hasUnknown = uploadJobs.some((job) =>
        ["unknown", "uploaded"].includes(job.status),
      );
      return {
        status: hasUnknown ? "unknown" : "blocked",
        items: this.store.getShippingJobs(runId),
        message: hasUnknown
          ? "쉽먼트 일괄등록 결과가 불명확해 문서를 자동 출력하지 않았습니다."
          : "확정된 15단계 쉽먼트 일괄등록 기록이 없습니다.",
      };
    }

    const run = this.store.getRun(runId);
    const batches = this.store.getLogenBatches(runId);
    let printed = 0;
    let blocked = 0;
    let unknown = 0;
    for (const group of shipmentGroups) {
      const current = this.store.getShipmentGroup(group.id) ?? group;
      if (!current.shipmentId) {
        blocked += 1;
        continue;
      }
      if (["documents_printed", "completed"].includes(current.status) && !forceReprint) {
        printed += 1;
        continue;
      }
      if (["unknown", "failed"].includes(current.status) && !forceReprint) {
        if (current.status === "unknown") unknown += 1;
        else blocked += 1;
        continue;
      }

      const marker = `[shipment-group:${current.id}]`;
      const priorArtifacts = run.artifacts.filter(
        (artifact) =>
          ["shipment_label", "shipment_statement"].includes(artifact.type) &&
          artifact.message?.startsWith(marker),
      );
      if (
        priorArtifacts.filter((artifact) => artifact.status === "submitted").length >= 2 &&
        !forceReprint
      ) {
        this.store.updateShipmentGroup(current.id, {
          status: "completed",
          message: "기존 쉽먼트 문서 출력 기록을 재사용했습니다.",
          updatedAt: this.isoNow(),
        });
        printed += 1;
        continue;
      }
      if (
        priorArtifacts.some((artifact) => artifact.status === "unknown") &&
        !forceReprint
      ) {
        unknown += 1;
        continue;
      }

      let printStarted = false;
      try {
        const documents = await this.ports.shipmentHub!.getShipmentDocuments({
          shipmentId: current.shipmentId,
          centerCode: current.centerCode,
          expectedInboundDate: current.expectedInboundDate,
          outputDir: this.config.shipmentDocumentsDir ?? "outputs/shipment-documents",
        });
        const documentTypes = new Set(documents.map((document) => document.type));
        if (
          !documentTypes.has("shipment_label") ||
          !documentTypes.has("shipment_statement")
        ) {
          throw new Error("쉽먼트 라벨과 내역서가 모두 준비되지 않았습니다.");
        }
        const inFlightMessage =
          "쉽먼트 문서 인쇄 요청을 시작했습니다. 완료 기록 전 중단되면 자동 재출력하지 않습니다.";
        this.store.updateShipmentGroup(current.id, {
          status: "unknown",
          message: inFlightMessage,
          updatedAt: this.isoNow(),
        });
        for (const document of documents) {
          this.store.recordArtifact({
            id: deterministicArtifactId(runId, document.type, [
              current.id,
              document.filePath,
            ]),
            runId,
            orderNo: current.orderNos[0],
            type: document.type,
            status: "unknown",
            fileName: document.fileName,
            filePath: document.filePath,
            printerName: this.config.shipmentPrinterName,
            message: `${marker} ${inFlightMessage}`,
          });
        }
        printStarted = true;
        const result = await this.ports.printer.print({
          files: documents.map((document) => ({
            fileName: document.fileName,
            filePath: document.filePath,
            documentType: document.type,
          })),
          printerName: this.config.shipmentPrinterName,
          copies: this.config.copies,
          kind: "shipment",
        });
        for (const document of documents) {
          this.store.recordArtifact({
            id: deterministicArtifactId(runId, document.type, [
              current.id,
              document.filePath,
            ]),
            runId,
            orderNo: current.orderNos[0],
            type: document.type,
            status: result.success ? "submitted" : result.status ?? "unknown",
            fileName: document.fileName,
            filePath: document.filePath,
            printerName: this.config.shipmentPrinterName,
            submittedAt: result.success ? this.isoNow() : undefined,
            message: `${marker} ${result.message}`,
          });
        }
        if (!result.success) {
          const status = result.status === "unknown" ? "unknown" : "failed";
          this.store.updateShipmentGroup(current.id, {
            status,
            message: result.message,
            updatedAt: this.isoNow(),
          });
          if (status === "unknown") unknown += 1;
          else blocked += 1;
          continue;
        }

        this.store.updateShipmentGroup(current.id, {
          status: "completed",
          message: "쉽먼트 라벨과 내역서를 인쇄 제출했습니다.",
          updatedAt: this.isoNow(),
        });
        for (const batch of batches.filter(
          (item) =>
            current.orderNos.includes(item.orderNo) && item.status === "waybills_printed",
        )) {
          const batchCartons = this.store.getFulfillmentCartons(batch.id);
          if (
            batchCartons.length === 0 ||
            batchCartons.some((carton) => carton.status !== "uploaded")
          ) {
            continue;
          }
          for (const carton of batchCartons) {
            this.store.updateFulfillmentCarton(batch.id, carton.cartonIndex, {
              status: "completed",
              message: undefined,
              updatedAt: this.isoNow(),
            });
          }
          this.store.updateLogenBatch(batch.id, {
            status: "completed",
            message: "쉽먼트 문서 출력까지 완료했습니다.",
            updatedAt: this.isoNow(),
          });
        }
        for (const job of this.store
          .getShippingJobs(runId)
          .filter(
            (item) =>
              current.orderNos.includes(item.orderNo) &&
              item.slipNo &&
              ["tracking_registered", "documents_printed"].includes(item.status),
          )) {
          this.store.updateShippingJob(job.id, {
            status: "documents_printed",
            shipmentId: current.shipmentId,
            documentsPrintedAt: this.isoNow(),
            error: undefined,
          });
        }
        printed += 1;
      } catch (error) {
        this.store.updateShipmentGroup(current.id, {
          status: printStarted ? "unknown" : "failed",
          message: printStarted
            ? `인쇄 요청 시작 후 결과를 확인하지 못했습니다. 자동 재출력하지 마세요. ${errorMessage(error)}`
            : errorMessage(error),
          updatedAt: this.isoNow(),
        });
        if (printStarted) unknown += 1;
        else blocked += 1;
      }
    }

    const finalBatches = this.store.getLogenBatches(runId);
    blocked += finalBatches.filter((batch) => ["blocked", "failed"].includes(batch.status)).length;
    unknown += finalBatches.filter((batch) => batch.status === "unknown").length;
    return {
      status: outcomeAggregateStatus(printed, blocked, unknown),
      items: this.store.getShippingJobs(runId),
      message: `쉽먼트 ${printed}/${shipmentGroups.length}건의 라벨과 내역서를 ${this.config.shipmentPrinterName}에 제출했습니다. 미완료 배치: 중단 ${blocked}건, 결과 불명확 ${unknown}건.`,
    };
  }

  private createCartonJobs(
    runId: string,
    orders: FulfillmentOrder[],
    dataSource: FulfillmentDataSource,
    refreshMaster: boolean,
    allowDemoMaster: boolean,
  ): ShippingJob[] {
    const jobs: ShippingJob[] = [];
    for (const order of orders) {
      for (const item of order.items) {
        const storedMaster = this.store.getProductMaster(item.skuCode);
        const master =
          storedMaster?.source === "demo" && !allowDemoMaster
            ? undefined
            : storedMaster;
        const fileUnits = positiveInteger(item.unitsPerCarton);
        let unitsPerCarton: number | undefined;
        if (dataSource === "backend") unitsPerCarton = positiveInteger(master?.unitsPerCarton);
        if (dataSource === "order_file") unitsPerCarton = fileUnits;
        if (dataSource === "auto") unitsPerCarton = positiveInteger(master?.unitsPerCarton) ?? fileUnits;

        if (fileUnits && (refreshMaster || !master || dataSource === "order_file")) {
          const updated: ProductMaster = {
            skuCode: item.skuCode,
            skuName: item.skuName,
            unitsPerCarton: fileUnits,
            source: "order_file",
            updatedAt: this.isoNow(),
          };
          this.store.upsertProductMaster(updated);
          unitsPerCarton =
            dataSource === "backend" && !refreshMaster
              ? unitsPerCarton
              : updated.unitsPerCarton;
        }

        const orderQuantity = positiveInteger(item.orderedQuantity) ?? 0;
        if (!unitsPerCarton || orderQuantity === 0 || orderQuantity % unitsPerCarton !== 0) {
          jobs.push({
            id: deterministicJobId(runId, order.orderNo, item.skuCode, 0),
            runId,
            orderNo: order.orderNo,
            skuCode: item.skuCode,
            skuName: item.skuName,
            cartonIndex: 0,
            shippedQuantity: orderQuantity,
            unitsPerCarton: unitsPerCarton ?? 0,
            fixTakeNo: fixTakeNo(order.orderNo, item.skuCode, 0),
            status: "blocked",
            error: !unitsPerCarton
              ? "입수수량이 없습니다."
              : `주문수량 ${orderQuantity}이 입수수량 ${unitsPerCarton}으로 나누어지지 않습니다.`,
          });
          continue;
        }

        const cartonCount = orderQuantity / unitsPerCarton;
        for (let cartonIndex = 1; cartonIndex <= cartonCount; cartonIndex += 1) {
          jobs.push({
            id: deterministicJobId(runId, order.orderNo, item.skuCode, cartonIndex),
            runId,
            orderNo: order.orderNo,
            skuCode: item.skuCode,
            skuName: item.skuName,
            cartonIndex,
            shippedQuantity: unitsPerCarton,
            unitsPerCarton,
            fixTakeNo: fixTakeNo(order.orderNo, item.skuCode, cartonIndex),
            status: "ready",
          });
        }
      }
    }
    return jobs;
  }

  /** Saved center data always wins; the order-file snapshot is only a fallback. */
  private resolveCenterForOrder(
    order: FulfillmentOrder,
    allowDemoMaster: boolean,
  ): CenterMaster | undefined {
    const stored = this.store.getCenterMaster(order.centerCode);
    if (stored && (allowDemoMaster || stored.source !== "demo") && isUsableCenter(stored)) {
      return stored;
    }

    const fromOrderFile = this.store.getOrderFileCenter(order.orderNo);
    if (!fromOrderFile || !isUsableCenter(fromOrderFile)) return undefined;
    const promoted: CenterMaster = {
      ...fromOrderFile,
      centerCode: order.centerCode,
      centerName: order.centerName,
      source: "order_file",
      updatedAt: this.isoNow(),
    };
    this.store.upsertCenterMaster(promoted);
    return promoted;
  }

  /** Re-imports metadata from an already-downloaded order workbook. */
  private importOrderFileArtifact(
    artifact: FulfillmentArtifact,
    orders: FulfillmentOrder[],
  ): void {
    if (!artifact.orderNo || !artifact.filePath?.toLowerCase().endsWith(".xlsx")) return;
    try {
      const workbook = readShipmentWorkbookData(artifact.filePath);
      const parsedOrder = workbook.orders.find(
        (order) => order.orderNo === artifact.orderNo,
      );
      if (parsedOrder?.items.length) {
        this.store.replaceOrderItems(artifact.orderNo, parsedOrder.items);
      }
      if (parsedOrder?.centerMaster) {
        const selectedOrder = orders.find((order) => order.orderNo === artifact.orderNo);
        this.store.saveOrderFileCenter(artifact.orderNo, {
          ...parsedOrder.centerMaster,
          centerCode: selectedOrder?.centerCode ?? parsedOrder.centerMaster.centerCode,
          centerName: selectedOrder?.centerName ?? parsedOrder.centerMaster.centerName,
        });
      }
      if (workbook.sender) this.promoteOrderFileSender(workbook.sender);
    } catch {
      // Re-import is best effort and never turns an existing download into a validation failure.
    }
  }

  /** Saved sender data wins; otherwise promote a complete order-file sender into SQLite. */
  private resolveSenderForRun(run: {
    artifacts: FulfillmentArtifact[];
  }): SenderProfile | undefined {
    const stored = this.store.getSenderProfile();
    if (stored && !isDemoSender(stored)) return stored;

    for (const artifact of run.artifacts) {
      if (
        artifact.type !== "order_file" ||
        artifact.status !== "downloaded" ||
        !artifact.filePath?.toLowerCase().endsWith(".xlsx")
      ) {
        continue;
      }
      try {
        const sender = readShipmentWorkbookData(artifact.filePath).sender;
        if (!sender) continue;
        const promoted = this.promoteOrderFileSender(sender);
        if (promoted) return promoted;
      } catch {
        // A downloaded workbook is a best-effort fallback, not a validation gate.
      }
    }
    return this.store.getSenderProfile();
  }

  private promoteOrderFileSender(
    sender: OrderFileSenderProfile,
  ): SenderProfile | undefined {
    const stored = this.store.getSenderProfile();
    if (stored && !isDemoSender(stored)) return stored;

    const customerCode =
      sender.customerCode?.trim() || this.config.senderDefaults?.customerCode?.trim();
    if (!customerCode || customerCode === "DEMO0000") return undefined;
    const deliveryFare = Number(this.config.senderDefaults?.deliveryFare ?? 0);
    const promoted: SenderProfile = {
      name: sender.name.trim(),
      address: sender.address.trim(),
      telephone: sender.telephone.trim(),
      mobile: sender.mobile?.trim() || undefined,
      postalCode: sender.postalCode?.trim() || undefined,
      customerCode,
      fareType: this.config.senderDefaults?.fareType?.trim() || "030",
      boxTypeCode: this.config.senderDefaults?.boxTypeCode?.trim() || undefined,
      deliveryFare: Number.isFinite(deliveryFare) ? deliveryFare : 0,
      updatedAt: this.isoNow(),
    };
    if (!isUsableSender(promoted)) return undefined;
    this.store.setSenderProfile(promoted);
    return promoted;
  }

  private async runStage<T>(
    runId: string,
    stage: FulfillmentStage,
    operation: () => Promise<{
      status: FulfillmentStageStatus;
      items: T[];
      message: string;
    }>,
    executionToken?: symbol,
  ): Promise<FulfillmentStageReply<T>> {
    const owner = executionToken ?? Symbol(`fulfillment-stage-${stage}`);
    if (this.mutationOwner && this.mutationOwner !== owner) {
      return reply(
        stage,
        "blocked",
        [],
        "다른 Fulfillment 단계가 진행 중이어서 중복 제출 방지를 위해 이번 호출을 실행하지 않았습니다.",
        { runId },
      );
    }
    const acquired = !this.mutationOwner;
    if (acquired) this.mutationOwner = owner;
    try {
      const run = this.store.getRun(runId);
      if (run.workflowVersion < 3 && stage >= 11) {
        throw new Error(
          `워크플로 v${run.workflowVersion} 실행은 기존 단계 기록 보존을 위해 읽기 전용입니다. 새 v3 Run을 사용하세요.`,
        );
      }
      const result = await operation();
      this.store.saveStageResult({
        runId,
        stage,
        status: result.status,
        message: result.message,
        items: result.items,
        updatedAt: this.isoNow(),
      });
      return reply(stage, result.status, result.items, result.message, { runId });
    } catch (error) {
      const message = errorMessage(error);
      this.store.saveStageResult({
        runId,
        stage,
        status: "failed",
        message,
        items: [],
        updatedAt: this.isoNow(),
      });
      return reply(stage, "failed", [], message, { runId });
    } finally {
      if (acquired && this.mutationOwner === owner) this.mutationOwner = undefined;
    }
  }

  private async runUnscopedStage<T>(
    stage: FulfillmentStage,
    executionToken: symbol | undefined,
    operation: () => Promise<FulfillmentStageReply<T>>,
  ): Promise<FulfillmentStageReply<T>> {
    const owner = executionToken ?? Symbol(`fulfillment-unscoped-stage-${stage}`);
    if (this.mutationOwner && this.mutationOwner !== owner) {
      return reply(
        stage,
        "blocked",
        [],
        "다른 Fulfillment 단계가 진행 중이어서 중복 실행 방지를 위해 이번 호출을 실행하지 않았습니다.",
      );
    }
    const acquired = !this.mutationOwner;
    if (acquired) this.mutationOwner = owner;
    try {
      return await operation();
    } catch (error) {
      return reply(stage, "failed", [], errorMessage(error));
    } finally {
      if (acquired && this.mutationOwner === owner) this.mutationOwner = undefined;
    }
  }

  private isoNow(): string {
    return this.now().toISOString();
  }
}

function reply<T>(
  stage: FulfillmentStage,
  status: FulfillmentStageStatus,
  items: T[],
  message: string,
  ids: { runId?: string; scanId?: string } = {},
): FulfillmentStageReply<T> {
  return {
    ...ids,
    stage,
    status,
    items,
    message,
    nextTool: status === "completed" || status === "partial" ? NEXT_TOOL[stage] : undefined,
    agent: agentForStage(stage),
  };
}

function aggregateStatus(successCount: number, problemCount: number): FulfillmentStageStatus {
  if (successCount > 0 && problemCount > 0) return "partial";
  if (successCount > 0) return "completed";
  return "blocked";
}

function normalizeLogenSlipNo(value: string | undefined): string | undefined {
  if (!value?.trim()) return undefined;
  const normalized = value.replace(/[^0-9]/g, "");
  if (normalized.length < 10 || normalized.length > 14) {
    throw new Error(`로젠 송장번호 형식이 올바르지 않습니다: ${value}`);
  }
  return normalized;
}

function outcomeAggregateStatus(
  successCount: number,
  blockedCount: number,
  unknownCount: number,
): FulfillmentStageStatus {
  if (successCount > 0 && blockedCount + unknownCount > 0) return "partial";
  if (successCount > 0) return "completed";
  if (unknownCount > 0) return "unknown";
  return "blocked";
}

function deterministicUploadJobId(
  runId: string,
  shipmentGroupIds: string[],
): string {
  return `upload-${createHash("sha256")
    .update(
      `${runId}|${[...new Set(shipmentGroupIds)].sort().join(",")}`,
    )
    .digest("hex")
    .slice(0, 16)}`;
}

function deterministicArtifactId(
  runId: string,
  type: FulfillmentArtifact["type"],
  identityParts: string[],
): string {
  return `artifact-${createHash("sha256")
    .update(`${runId}|${type}|${[...identityParts].sort().join("|")}`)
    .digest("hex")
    .slice(0, 20)}`;
}

function dateInTimeZone(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = new Map(parts.map((part) => [part.type, part.value]));
  const year = values.get("year");
  const month = values.get("month");
  const day = values.get("day");
  if (!year || !month || !day) throw new Error(`${timeZone} 기준 날짜를 계산할 수 없습니다.`);
  return `${year}-${month}-${day}`;
}

function normalizeOptionalShipDate(value: string | undefined): string | undefined {
  if (!value?.trim()) return undefined;
  const normalized = value.trim();
  const match = normalized.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) throw new Error("발송일은 YYYY-MM-DD 형식이어야 합니다.");
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const candidate = new Date(Date.UTC(year, month - 1, day));
  if (
    candidate.getUTCFullYear() !== year ||
    candidate.getUTCMonth() !== month - 1 ||
    candidate.getUTCDate() !== day
  ) {
    throw new Error("발송일이 올바른 날짜가 아닙니다.");
  }
  return normalized;
}

function normalizeOptionalShipTime(value: string | undefined): string | undefined {
  if (!value?.trim()) return undefined;
  const normalized = value.trim();
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(normalized)) {
    throw new Error("발송시간은 HH:mm 형식이어야 합니다.");
  }
  return normalized;
}

function positiveInteger(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : undefined;
}

function isSafePreSubmissionLogenFailure(
  status: LogenBatch["status"],
  message: string | undefined,
): boolean {
  if (!["blocked", "failed"].includes(status)) return false;
  const text = message ?? "";
  return [
    "주문등록 제출 전 중단:",
    "로젠 로그인 완료 화면을 확인하지 못했습니다.",
    "로젠 로그인이 필요합니다.",
    "로젠 주문등록 URL",
    "셀렉터 설정이 필요합니다.",
  ].some((marker) => text.includes(marker));
}

function hasSavedUnreconciledLogenEvidence(
  stages: StageRecord[],
  batch: LogenBatch,
): boolean {
  for (const stage of stages) {
    for (const item of stage.items) {
      if (!item || typeof item !== "object") continue;
      const record = item as Record<string, unknown>;
      if (
        String(record.orderNo ?? "") !== batch.orderNo ||
        String(record.skuCode ?? "") !== batch.skuCode
      ) {
        continue;
      }
      const evidence = `${String(record.error ?? "")} ${String(record.message ?? "")}`;
      if (
        evidence.includes("저장은 완료됐지만 새 예약행") ||
        evidence.includes("저장은 완료됐지만 새 예약행을 하나로 확정하지 못했습니다")
      ) {
        return true;
      }
    }
  }
  return false;
}

function deterministicJobId(runId: string, orderNo: string, skuCode: string, cartonIndex: number): string {
  return `job-${createHash("sha256")
    .update(`${runId}|${orderNo}|${skuCode}|${cartonIndex}`)
    .digest("hex")
    .slice(0, 16)}`;
}

function fixTakeNo(orderNo: string, skuCode: string, cartonIndex: number): string {
  const raw = `${orderNo}|${skuCode}|${cartonIndex}`;
  const hash = createHash("sha256").update(raw).digest("hex").slice(0, 8);
  const safeOrder = sanitizeKey(orderNo).slice(0, 55);
  const safeSku = sanitizeKey(skuCode).slice(0, 22);
  return `${safeOrder}-${safeSku}-C${String(cartonIndex).padStart(3, "0")}-${hash}`.slice(0, 100);
}

function sanitizeKey(value: string): string {
  return (
    value.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") ||
    createHash("sha256").update(value).digest("hex").slice(0, 8)
  );
}

function isDemoSender(sender: { name: string; customerCode: string }): boolean {
  return sender.name === "DEMO SENDER" || sender.customerCode === "DEMO0000";
}

function isUsableSender(sender: SenderProfile): boolean {
  return Boolean(
    sender.name.trim() &&
      sender.address.trim() &&
      (sender.telephone.trim() || sender.mobile?.trim()) &&
      sender.customerCode.trim(),
  );
}

function isUsableCenter(center: CenterMaster): boolean {
  return Boolean(
    center.recipientName.trim() &&
      center.address.trim() &&
      (center.telephone.trim() || center.mobile?.trim()),
  );
}

function displayLogenMethod(method: LogenIntegrationMethod): string {
  return method === "api" ? "API 연동" : "웹사이트 MCP";
}

function agentForStage(stage: FulfillmentStage) {
  if ([11, 12, 13, 14].includes(stage)) return "logen_agent" as const;
  if ([1, 2, 5, 7, 8, 15, 16].includes(stage)) return "supplierhub_agent" as const;
  return "fulfillment_coordinator" as const;
}

function groupByOrder(jobs: ShippingJob[]): Map<string, ShippingJob[]> {
  const grouped = new Map<string, ShippingJob[]>();
  for (const job of jobs) grouped.set(job.orderNo, [...(grouped.get(job.orderNo) ?? []), job]);
  return grouped;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function workflowDelay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
