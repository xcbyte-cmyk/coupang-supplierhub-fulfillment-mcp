import type { FulfillmentWorkflowMcpPort } from "./fulfillment-mcp.js";
import type {
  FulfillmentDataSource,
  FulfillmentStage,
  LogenIntegrationMethod,
  LogenWaybillNumberConfirmation,
  ProductUnitsUpdate,
} from "./fulfillment-types.js";
import type { WorkflowSettings } from "./types.js";
import type { SupplierHubWorkflow } from "./workflow-module.js";

export type WorkflowToolHandler = (input: Record<string, unknown>) => Promise<unknown>;
export type WorkflowToolHandlers = Record<string, WorkflowToolHandler>;

export function createWorkflowToolHandlers(workflow: SupplierHubWorkflow): WorkflowToolHandlers {
  return {
    get_workflow_dashboard: () => workflow.getStatus(),
    open_supplierhub_login: () => workflow.openLogin(),
    scan_private_label_orders: () => workflow.scan("manual"),
    update_workflow_settings: (input) =>
      workflow.updateSettings(input as Partial<WorkflowSettings>),
    prepare_print_batch: (input) =>
      workflow.preparePrintBatch(asStringArray(input.orderNos, "orderNos")),
    hold_print_batch: (input) => workflow.holdBatch(asString(input.batchId, "batchId")),
    print_batch: (input) =>
      workflow.printBatch(
        asString(input.batchId, "batchId"),
        asString(input.confirmation, "confirmation"),
      ),
  };
}

export function createFulfillmentToolHandlers(
  fulfillmentWorkflow: FulfillmentWorkflowMcpPort,
  defaultLogenMethod: LogenIntegrationMethod,
): WorkflowToolHandlers {
  const openLogenRegistration: WorkflowToolHandler = (input) =>
    fulfillmentWorkflow.openLogenSingleOrderRegistration({
      runId: asString(input.runId, "runId"),
      logenMethod: optionalLogenIntegrationMethod(input.logenMethod),
    });

  return {
    open_logen_login: (input) =>
      fulfillmentWorkflow.openLogenLogin({
        runId: asString(input.runId, "runId"),
        logenMethod: optionalLogenIntegrationMethod(input.logenMethod),
      }),
    open_logen_registration: openLogenRegistration,
    open_logen_single_order_registration: openLogenRegistration,
    preview_logen_registration: (input) => fulfillmentWorkflow.previewLogenRegistration({
      runId: asString(input.runId, "runId"), dataSource: asFulfillmentDataSource(input.dataSource),
      logenMethod: optionalLogenIntegrationMethod(input.logenMethod),
      draftUnits: input.draftUnits === undefined ? undefined : asProductUnitRows(input.draftUnits, true),
    }),
    save_product_carton_units: (input) => fulfillmentWorkflow.saveProductCartonUnits({
      runId: asString(input.runId, "runId"), confirmed: input.confirmed === true,
      updates: asProductUnitUpdates(input.updates),
    }),
    confirm_carton_order_review: (input) => {
      if (!Array.isArray(input.reviews) || !input.reviews.length || input.reviews.length > 100) throw new Error("확인할 품목을 1~100개 지정하세요.");
      return fulfillmentWorkflow.confirmCartonOrderReview({
        runId: asString(input.runId, "runId"), dataSource: asFulfillmentDataSource(input.dataSource), confirmed: input.confirmed === true,
        reviews: input.reviews.map(row => {
          if (!row || !Number.isSafeInteger(row.unitsPerCarton) || row.unitsPerCarton <= 0) throw new Error("입수수량은 양의 정수여야 합니다.");
          return { orderNo: asString(row.orderNo, "orderNo"), skuCode: asString(row.skuCode, "skuCode"),
            evidenceToken: asString(row.evidenceToken, "evidenceToken"), unitsPerCarton: row.unitsPerCarton,
            note: typeof row.note === "string" ? row.note : "" };
        }),
      });
    },
    list_fulfillment_contexts: (input) =>
      fulfillmentWorkflow.listFulfillmentContexts({
        limit: optionalPositiveInteger(input.limit),
      }),
    reset_fulfillment_stage_record: (input) =>
      fulfillmentWorkflow.resetFulfillmentStageRecord({
        runId: asString(input.runId, "runId"),
        stage: asFulfillmentStage(input.stage),
        confirmation: optionalString(input.confirmation),
        allowUnknown: input.allowUnknown === true,
        quickReset: input.quickReset === true,
        clearLogenRegistration: input.clearLogenRegistration === true,
      }),
    delete_fulfillment_run_record: (input) =>
      fulfillmentWorkflow.deleteFulfillmentRunRecord({
        runId: asString(input.runId, "runId"),
        confirmation: asString(input.confirmation, "confirmation"),
      }),
    delete_fulfillment_scan_record: (input) =>
      fulfillmentWorkflow.deleteFulfillmentScanRecord({
        scanId: asString(input.scanId, "scanId"),
        confirmation: asString(input.confirmation, "confirmation"),
      }),
    open_supplierhub: () => fulfillmentWorkflow.openSupplierHub(),
    list_private_label_orders: (input) =>
      fulfillmentWorkflow.listPrivateLabelOrders({
        lookAheadDays: asLookAheadDays(input.lookAheadDays),
        dateSearchType: optionalDateSearchType(input.dateSearchType),
        dateFrom: optionalString(input.dateFrom),
        dateTo: optionalString(input.dateTo),
      }),
    compare_new_orders: (input) =>
      fulfillmentWorkflow.compareNewOrders({ scanId: asString(input.scanId, "scanId") }),
    select_orders_for_fulfillment: (input) =>
      fulfillmentWorkflow.selectOrdersForFulfillment({
        scanId: asString(input.scanId, "scanId"),
        orderNos: optionalStringArray(input.orderNos, "orderNos"),
      }),
    select_orders_for_print: (input) =>
      fulfillmentWorkflow.selectOrdersForPrint({
        scanId: asString(input.scanId, "scanId"),
        orderNos: optionalStringArray(input.orderNos, "orderNos"),
      }),
    release_fulfillment_run_assignments: (input) =>
      fulfillmentWorkflow.releaseFulfillmentRunAssignments({
        runId: asString(input.runId, "runId"),
      }),
    download_order_confirmation_template: (input) =>
      fulfillmentWorkflow.downloadOrderConfirmationTemplate({
        runId: asString(input.runId, "runId"),
      }),
    prepare_order_confirmation_workbook: (input) =>
      fulfillmentWorkflow.prepareOrderConfirmationWorkbook({
        runId: asString(input.runId, "runId"),
      }),
    upload_and_confirm_private_label_orders: (input) =>
      fulfillmentWorkflow.uploadAndConfirmPrivateLabelOrders({
        runId: asString(input.runId, "runId"),
        forceRetry: input.forceRetry === true,
      }),
    download_order_files: (input) =>
      fulfillmentWorkflow.downloadOrderFiles({ runId: asString(input.runId, "runId") }),
    print_order_files: (input) =>
      fulfillmentWorkflow.printOrderFiles({
        runId: asString(input.runId, "runId"),
        forceReprint: input.forceReprint === true,
      }),
    record_print_result: (input) =>
      fulfillmentWorkflow.recordPrintResult({ runId: asString(input.runId, "runId") }),
    register_logen_delivery_order: (input) =>
      fulfillmentWorkflow.registerLogenDeliveryOrder({
        runId: asString(input.runId, "runId"),
        dataSource: asFulfillmentDataSource(input.dataSource),
        logenMethod: optionalLogenIntegrationMethod(input.logenMethod) ?? defaultLogenMethod,
        refreshMaster: input.refreshMaster === true,
        ...(optionalString(input.reviewToken) ? { reviewToken: optionalString(input.reviewToken) } : {}),
      }),
    print_logen_waybill: (input) =>
      fulfillmentWorkflow.printLogenWaybill({
        runId: asString(input.runId, "runId"),
        logenMethod: optionalLogenIntegrationMethod(input.logenMethod),
        forceReprint: input.forceReprint === true,
      }),
    confirm_logen_waybill_numbers: (input) =>
      fulfillmentWorkflow.confirmLogenWaybillNumbers({
        runId: asString(input.runId, "runId"),
        confirmations: asWaybillNumberConfirmations(input.confirmations),
      }),
    prepare_supplierhub_shipment_tracking: (input) =>
      fulfillmentWorkflow.prepareSupplierHubShipmentTracking({
        runId: asString(input.runId, "runId"),
        shipDate: optionalString(input.shipDate),
        shipTime: optionalString(input.shipTime),
      }),
    register_supplierhub_shipment_tracking: (input) =>
      fulfillmentWorkflow.registerSupplierHubShipmentTracking({
        runId: asString(input.runId, "runId"),
        forceRetry: input.forceRetry === true,
        shipDate: optionalString(input.shipDate),
        shipTime: optionalString(input.shipTime),
      }),
    print_supplierhub_shipment_documents: (input) =>
      fulfillmentWorkflow.printSupplierHubShipmentDocuments({
        runId: asString(input.runId, "runId"),
        forceReprint: input.forceReprint === true,
      }),
    get_fulfillment_run: (input) =>
      fulfillmentWorkflow.getFulfillmentRun({ runId: asString(input.runId, "runId") }),
    run_fulfillment_workflow: (input) =>
      fulfillmentWorkflow.runFulfillmentWorkflow({
        lookAheadDays: asLookAheadDays(input.lookAheadDays),
        dateSearchType: optionalDateSearchType(input.dateSearchType),
        dateFrom: optionalString(input.dateFrom),
        dateTo: optionalString(input.dateTo),
        dataSource: asFulfillmentDataSource(input.dataSource),
        logenMethod: optionalLogenIntegrationMethod(input.logenMethod) ?? defaultLogenMethod,
        refreshMaster: input.refreshMaster === true,
        orderNos: optionalStringArray(input.orderNos, "orderNos"),
      }),
  };
}

function asString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} 값이 필요합니다.`);
  return value.trim();
}

function asProductUnitRows(value: unknown, allowEmpty = false): Array<{ skuCode: string; unitsPerCarton: number }> {
  if (!Array.isArray(value) || (!allowEmpty && !value.length) || value.length > 100) throw new Error("입수수량은 최대 100개 SKU의 배열로 지정하고, 저장할 때는 1개 이상 입력하세요.");
  return value.map(row => {
    if (!row || typeof row !== "object" || !Number.isSafeInteger(row.unitsPerCarton) || row.unitsPerCarton <= 0) throw new Error("입수수량은 양의 정수여야 합니다.");
    return { skuCode: asString(row.skuCode, "skuCode"), unitsPerCarton: row.unitsPerCarton };
  });
}

function asProductUnitUpdates(value: unknown): ProductUnitsUpdate[] {
  return asProductUnitRows(value).map((row, index) => {
    const source = (value as Array<Record<string, unknown>>)[index];
    const units = source.expectedUnitsPerCarton;
    const at = source.expectedUpdatedAt;
    if ((units !== null && (!Number.isSafeInteger(units) || Number(units) < 0)) || (at !== null && typeof at !== "string")) throw new Error("기준정보를 새로 확인한 뒤 저장하세요.");
    return { ...row, expectedUnitsPerCarton: units as number | null, expectedUpdatedAt: at as string | null };
  });
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalPositiveInteger(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error("limit must be a positive integer");
  }
  return parsed;
}

function asFulfillmentStage(value: unknown): FulfillmentStage {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 16) {
    throw new Error("stage는 1~16 사이의 정수여야 합니다.");
  }
  return parsed as FulfillmentStage;
}

function optionalDateSearchType(
  value: unknown,
): "expected_inbound_date" | "order_date" | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (value === "expected_inbound_date" || value === "order_date") return value;
  throw new Error("dateSearchType은 expected_inbound_date 또는 order_date여야 합니다.");
}

function asStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${field}는 문자열 배열이어야 합니다.`);
  }
  return value as string[];
}

function optionalStringArray(value: unknown, field: string): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  return asStringArray(value, field);
}

function asWaybillNumberConfirmations(
  value: unknown,
): LogenWaybillNumberConfirmation[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 1000) {
    throw new Error("confirmations는 1~1000개의 송장번호 확인 행이어야 합니다.");
  }
  return value.map((item, index) => {
    if (!item || typeof item !== "object") {
      throw new Error(`confirmations[${index}] 형식이 올바르지 않습니다.`);
    }
    const row = item as Record<string, unknown>;
    const cartonIndex = Number(row.cartonIndex);
    if (!Number.isInteger(cartonIndex) || cartonIndex < 1) {
      throw new Error(`confirmations[${index}].cartonIndex는 1 이상의 정수여야 합니다.`);
    }
    if (row.selectedSource !== "original" && row.selectedSource !== "waybill") {
      throw new Error(
        `confirmations[${index}].selectedSource는 original 또는 waybill이어야 합니다.`,
      );
    }
    return {
      batchId: asString(row.batchId, `confirmations[${index}].batchId`),
      cartonIndex,
      selectedSource: row.selectedSource,
    };
  });
}

function asLookAheadDays(value: unknown): 7 | 30 {
  const parsed = Number(value);
  if (parsed !== 7 && parsed !== 30) throw new Error("lookAheadDays는 7 또는 30이어야 합니다.");
  return parsed;
}

function asFulfillmentDataSource(value: unknown): FulfillmentDataSource {
  if (value === "auto" || value === "backend" || value === "order_file") return value;
  throw new Error("dataSource는 auto, backend, order_file 중 하나여야 합니다.");
}

function optionalLogenIntegrationMethod(
  value: unknown,
): LogenIntegrationMethod | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (value === "api" || value === "website_mcp") return value;
  throw new Error("logenMethod must be api or website_mcp");
}
