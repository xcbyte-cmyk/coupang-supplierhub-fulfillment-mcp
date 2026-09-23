import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ConfirmCartonOrderReviewInput } from "./carton-order-review.js";
import type { FulfillmentStage, ProductUnitsUpdate, RegistrationPreviewInput } from "./fulfillment-types.js";

export type FulfillmentLookAheadDays = 7 | 30;
export type FulfillmentDataSource = "auto" | "backend" | "order_file";
export type LogenIntegrationMethod = "api" | "website_mcp";

/**
 * The MCP-facing seam of the fulfillment workflow.
 *
 * The concrete workflow may expose additional methods, but MCP registration only
 * depends on this interface so the orchestration and transport layers remain
 * independently testable.
 */
export interface FulfillmentWorkflowMcpPort {
  confirmCartonOrderReview(input: ConfirmCartonOrderReviewInput): Promise<FulfillmentToolResult>;
  previewLogenRegistration(input: RegistrationPreviewInput): Promise<FulfillmentToolResult>;
  saveProductCartonUnits(input: { runId: string; updates: ProductUnitsUpdate[]; confirmed: boolean }): Promise<FulfillmentToolResult>;
  openSupplierHub(): Promise<FulfillmentToolResult>;
  openLogenLogin(input: {
    runId: string;
    logenMethod?: LogenIntegrationMethod;
  }): Promise<FulfillmentToolResult>;
  openLogenSingleOrderRegistration(input: {
    runId: string;
    logenMethod?: LogenIntegrationMethod;
  }): Promise<FulfillmentToolResult>;
  listPrivateLabelOrders(input: {
    lookAheadDays: FulfillmentLookAheadDays;
    dateSearchType?: "expected_inbound_date" | "order_date";
    dateFrom?: string;
    dateTo?: string;
  }): Promise<FulfillmentToolResult>;
  compareNewOrders(input: { scanId: string }): Promise<FulfillmentToolResult>;
  selectOrdersForFulfillment(input: {
    scanId: string;
    orderNos?: string[];
  }): Promise<FulfillmentToolResult>;
  selectOrdersForPrint(input: {
    scanId: string;
    orderNos?: string[];
  }): Promise<FulfillmentToolResult>;
  releaseFulfillmentRunAssignments(input: { runId: string }): Promise<FulfillmentToolResult>;
  downloadOrderConfirmationTemplate(input: { runId: string }): Promise<FulfillmentToolResult>;
  prepareOrderConfirmationWorkbook(input: { runId: string }): Promise<FulfillmentToolResult>;
  uploadAndConfirmPrivateLabelOrders(input: {
    runId: string;
    forceRetry?: boolean;
  }): Promise<FulfillmentToolResult>;
  downloadOrderFiles(input: { runId: string }): Promise<FulfillmentToolResult>;
  printOrderFiles(input: {
    runId: string;
    forceReprint?: boolean;
  }): Promise<FulfillmentToolResult>;
  recordPrintResult(input: { runId: string }): Promise<FulfillmentToolResult>;
  registerLogenDeliveryOrder(input: {
    runId: string;
    dataSource: FulfillmentDataSource;
    logenMethod?: LogenIntegrationMethod;
    refreshMaster?: boolean;
    reviewToken?: string;
  }): Promise<FulfillmentToolResult>;
  printLogenWaybill(input: {
    runId: string;
    logenMethod?: LogenIntegrationMethod;
    forceReprint?: boolean;
  }): Promise<FulfillmentToolResult>;
  confirmLogenWaybillNumbers(input: {
    runId: string;
    confirmations: Array<{
      batchId: string;
      cartonIndex: number;
      selectedSource: "original" | "waybill";
    }>;
  }): Promise<FulfillmentToolResult>;
  prepareSupplierHubShipmentTracking(input: {
    runId: string;
    shipDate?: string;
    shipTime?: string;
  }): Promise<FulfillmentToolResult>;
  registerSupplierHubShipmentTracking(input: {
    runId: string;
    forceRetry?: boolean;
    shipDate?: string;
    shipTime?: string;
  }): Promise<FulfillmentToolResult>;
  printSupplierHubShipmentDocuments(input: {
    runId: string;
    forceReprint?: boolean;
  }): Promise<FulfillmentToolResult>;
  getFulfillmentRun(input: { runId: string }): Promise<FulfillmentToolResult>;
  listFulfillmentContexts(input: { limit?: number }): Promise<FulfillmentToolResult>;
  resetFulfillmentStageRecord(input: {
    runId: string;
    stage: FulfillmentStage;
    confirmation?: string;
    allowUnknown?: boolean;
    quickReset?: boolean;
    clearLogenRegistration?: boolean;
  }): Promise<FulfillmentToolResult>;
  deleteFulfillmentRunRecord(input: {
    runId: string;
    confirmation: string;
  }): Promise<FulfillmentToolResult>;
  deleteFulfillmentScanRecord(input: {
    scanId: string;
    confirmation: string;
  }): Promise<FulfillmentToolResult>;
  runFulfillmentWorkflow(input: {
    lookAheadDays: FulfillmentLookAheadDays;
    dateSearchType?: "expected_inbound_date" | "order_date";
    dateFrom?: string;
    dateTo?: string;
    dataSource: FulfillmentDataSource;
    logenMethod?: LogenIntegrationMethod;
    refreshMaster?: boolean;
    orderNos?: string[];
  }): Promise<FulfillmentToolResult>;
}

export type FulfillmentToolResult = object & { message?: string };

const fulfillmentOutputSchema = {
  fulfillment: z.record(z.unknown()),
};

const lookAheadDaysSchema = z.union([z.literal(7), z.literal(30)]);
const dateOnlySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional();
const timeOnlySchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional();
const dateSearchTypeSchema = z.enum(["expected_inbound_date", "order_date"]).optional();
const dataSourceSchema = z.enum(["auto", "backend", "order_file"]);
const logenMethodSchema = z.enum(["api", "website_mcp"]);
const scanIdSchema = z.string().trim().min(1).max(200);
const runIdSchema = z.string().trim().min(1).max(200);
const recordLimitSchema = z.number().int().min(1).max(50).optional();
const fulfillmentStageSchema = z.number().int().min(1).max(16);
const stageResetConfirmationSchema = z.string().trim().min(1).max(240);
const waybillNumberConfirmationSchema = z.object({
  batchId: z.string().trim().min(1).max(200),
  cartonIndex: z.number().int().min(1).max(1000),
  selectedSource: z.enum(["original", "waybill"]),
});
const calibrationOrderNosSchema = z
  .array(z.string().trim().min(1).max(200))
  .min(1)
  .max(100)
  .optional();

/** Register the 16 fulfillment stages, the legacy stage-4 alias, and operational tools. */
export function registerFulfillmentMcpTools(
  server: McpServer,
  workflow: FulfillmentWorkflowMcpPort,
): void {
  server.registerTool("confirm_carton_order_review", {
    title: "발주서 포장 기준 확인 저장",
    description: "Persist operator review of each current PO file and applied carton units. Missing or conflicting evidence requires a note. Does not register deliveries or update the SKU master.",
    inputSchema: { runId: runIdSchema, dataSource: dataSourceSchema, confirmed: z.literal(true),
      reviews: z.array(z.object({ orderNo: z.string().min(1), skuCode: z.string().min(1), evidenceToken: z.string().min(1),
        unitsPerCarton: z.number().int().positive(), note: z.string().max(1000) })).min(1).max(100) },
    outputSchema: fulfillmentOutputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: false },
  }, async input => fulfillmentReply(await workflow.confirmCartonOrderReview(input), "발주서 확인을 저장했습니다."));
  server.registerTool("preview_logen_registration", {
    title: "13단계 입수수량·등록 계획 확인",
    description: "Read the current run's carton units, source, related-product suggestions, recipient and registration history. Draft units are calculation only and never saved or submitted.",
    inputSchema: {
      runId: runIdSchema, dataSource: dataSourceSchema, logenMethod: logenMethodSchema.optional(),
      draftUnits: z.array(z.object({ skuCode: z.string().min(1), unitsPerCarton: z.number().int().positive() })).max(100).optional(),
    },
    outputSchema: fulfillmentOutputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
  }, async (input) => fulfillmentReply(await workflow.previewLogenRegistration(input), "등록 계획을 확인했습니다."));
  server.registerTool("save_product_carton_units", {
    title: "확인한 SKU 입수수량 저장",
    description: "Save operator-confirmed carton units with an audit record. Does not register deliveries, clear runs, or modify previously registered carton snapshots. Suggestions require operator confirmation.",
    inputSchema: {
      runId: runIdSchema, confirmed: z.literal(true),
      updates: z.array(z.object({
        skuCode: z.string().min(1), unitsPerCarton: z.number().int().positive(),
        expectedUnitsPerCarton: z.number().int().nonnegative().nullable(), expectedUpdatedAt: z.string().nullable(),
      })).min(1).max(100),
    },
    outputSchema: fulfillmentOutputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: false },
  }, async (input) => fulfillmentReply(await workflow.saveProductCartonUnits(input), "포장 기준을 저장했습니다."));

  server.registerTool(
    "open_supplierhub",
    {
      title: "Open Supplier Hub",
      description:
        "Open the dedicated Supplier Hub browser profile at the Private Label order screen and report whether login is ready.",
      inputSchema: {},
      outputSchema: fulfillmentOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async () => fulfillmentReply(await workflow.openSupplierHub(), "Supplier Hub opened."),
  );

  server.registerTool(
    "open_logen_login",
    {
      title: "Open Logen login",
      description:
        "Stage 11: open the dedicated Logen browser profile, complete login when credentials are filled, and stop on the authenticated main screen.",
      inputSchema: {
        runId: runIdSchema,
        logenMethod: logenMethodSchema.optional(),
      },
      outputSchema: fulfillmentOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ runId, logenMethod }) =>
      fulfillmentReply(
        await workflow.openLogenLogin({ runId, logenMethod }),
        "Logen login completed.",
      ),
  );

  server.registerTool(
    "open_logen_single_order_registration",
    {
      title: "Open Logen single-order registration",
      description:
        "Stage 12: reuse the authenticated Logen session, open Reservation Management and the single-order registration/print screen, and stop before pressing New (F3).",
      inputSchema: {
        runId: runIdSchema,
        logenMethod: logenMethodSchema.optional(),
      },
      outputSchema: fulfillmentOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ runId, logenMethod }) =>
      fulfillmentReply(
        await workflow.openLogenSingleOrderRegistration({ runId, logenMethod }),
        "Logen single-order registration opened.",
      ),
  );

  server.registerTool(
    "list_private_label_orders",
    {
      title: "List Private Label orders",
      description:
        "Read the Supplier Hub Private Label order list for an explicit expected-inbound-date range, or fall back to the next 7/30 days, and persist a new scan without changing order state.",
      inputSchema: {
        lookAheadDays: lookAheadDaysSchema,
        dateSearchType: dateSearchTypeSchema,
        dateFrom: dateOnlySchema,
        dateTo: dateOnlySchema,
      },
      outputSchema: fulfillmentOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ lookAheadDays, dateSearchType, dateFrom, dateTo }) =>
      fulfillmentReply(
        await workflow.listPrivateLabelOrders({
          lookAheadDays,
          dateSearchType,
          dateFrom,
          dateTo,
        }),
        "Private Label orders listed.",
      ),
  );

  server.registerTool(
    "compare_new_orders",
    {
      title: "Compare new orders",
      description:
        "Classify each saved Private Label order as confirmation-required, already confirmed, already assigned, or excluded without changing Supplier Hub state.",
      inputSchema: { scanId: scanIdSchema },
      outputSchema: fulfillmentOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ scanId }) =>
      fulfillmentReply(await workflow.compareNewOrders({ scanId }), "New orders compared."),
  );

  server.registerTool(
    "select_orders_for_fulfillment",
    {
      title: "Select orders for fulfillment",
      description:
        "Create a workflow-v2 fulfillment run from every actionable order in a scan, or from an optional calibration subset.",
      inputSchema: {
        scanId: scanIdSchema,
        orderNos: calibrationOrderNosSchema,
      },
      outputSchema: fulfillmentOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ scanId, orderNos }) =>
      fulfillmentReply(
        await workflow.selectOrdersForFulfillment({ scanId, orderNos }),
        "Orders selected for the fulfillment run.",
      ),
  );

  server.registerTool(
    "select_orders_for_print",
    {
      title: "Select orders for fulfillment (legacy alias)",
      description:
        "Compatibility alias of select_orders_for_fulfillment.",
      inputSchema: {
        scanId: scanIdSchema,
        orderNos: calibrationOrderNosSchema,
      },
      outputSchema: fulfillmentOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ scanId, orderNos }) =>
      fulfillmentReply(
        await workflow.selectOrdersForPrint({ scanId, orderNos }),
        "Orders selected for the fulfillment run.",
      ),
  );

  server.registerTool(
    "release_fulfillment_run_assignments",
    {
      title: "Release fulfillment run assignments",
      description:
        "Release purchase-order assignments from a run only before any remote upload, delivery registration, or printing has started, so the orders can be selected again from stage 3.",
      inputSchema: { runId: runIdSchema },
      outputSchema: fulfillmentOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ runId }) =>
      fulfillmentReply(
        await workflow.releaseFulfillmentRunAssignments({ runId }),
        "Fulfillment run assignments released.",
      ),
  );

  server.registerTool(
    "download_order_confirmation_template",
    {
      title: "Download order confirmation template",
      description:
        "Download the Supplier Hub 발주서 업로드 양식 for confirmation-required orders in a fulfillment run.",
      inputSchema: { runId: runIdSchema },
      outputSchema: fulfillmentOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ runId }) =>
      fulfillmentReply(
        await workflow.downloadOrderConfirmationTemplate({ runId }),
        "Order confirmation template downloaded.",
      ),
  );

  server.registerTool(
    "prepare_order_confirmation_workbook",
    {
      title: "Prepare order confirmation workbook",
      description:
        "Copy ordered quantity into confirmed quantity only for the selected purchase orders while preserving all other workbook cells and formatting.",
      inputSchema: { runId: runIdSchema },
      outputSchema: fulfillmentOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ runId }) =>
      fulfillmentReply(
        await workflow.prepareOrderConfirmationWorkbook({ runId }),
        "Order confirmation workbook prepared.",
      ),
  );

  server.registerTool(
    "upload_and_confirm_private_label_orders",
    {
      title: "Upload and confirm Private Label orders",
      description:
        "Recheck current order status, upload the prepared workbook, and verify 발주확정. Unknown submissions are not retried unless forceRetry=true.",
      inputSchema: {
        runId: runIdSchema,
        forceRetry: z.boolean().optional(),
      },
      outputSchema: fulfillmentOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ runId, forceRetry }) =>
      fulfillmentReply(
        await workflow.uploadAndConfirmPrivateLabelOrders({ runId, forceRetry }),
        "Private Label order confirmation submitted.",
      ),
  );

  server.registerTool(
    "download_order_files",
    {
      title: "Download order files",
      description:
        "Download purchase-order files for a fulfillment run without ZIP or XLSX content validation.",
      inputSchema: { runId: runIdSchema },
      outputSchema: fulfillmentOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ runId }) =>
      fulfillmentReply(
        await workflow.downloadOrderFiles({ runId }),
        "Order files downloaded.",
      ),
  );

  server.registerTool(
    "print_order_files",
    {
      title: "Print order files",
      description:
        "Submit downloaded purchase-order files to SINDOH N600. Reprinting requires forceReprint=true.",
      inputSchema: {
        runId: runIdSchema,
        forceReprint: z.boolean().optional(),
      },
      outputSchema: fulfillmentOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ runId, forceReprint }) =>
      fulfillmentReply(
        await workflow.printOrderFiles({ runId, forceReprint }),
        "Order files submitted to the printer.",
      ),
  );

  server.registerTool(
    "record_print_result",
    {
      title: "Record order print result",
      description:
        "Record purchase-order print submission results and move eligible orders to delivery processing.",
      inputSchema: { runId: runIdSchema },
      outputSchema: fulfillmentOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ runId }) =>
      fulfillmentReply(
        await workflow.recordPrintResult({ runId }),
        "Order print results recorded.",
      ),
  );

  server.registerTool(
    "register_logen_delivery_order",
    {
      title: "Register Logen delivery orders",
      description:
        "Stage 13: press New (F3), enter the order information, and save (F5) through either the official API or the already-open Logen website MCP screen.",
      inputSchema: {
        runId: runIdSchema,
        dataSource: dataSourceSchema,
        logenMethod: logenMethodSchema.optional(),
        refreshMaster: z.boolean().optional(),
        reviewToken: z.string().min(1).optional(),
        orderNos: calibrationOrderNosSchema,
      },
      outputSchema: fulfillmentOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ runId, dataSource, logenMethod, refreshMaster, reviewToken }) =>
      fulfillmentReply(
        await workflow.registerLogenDeliveryOrder({
          runId,
          dataSource,
          logenMethod,
          refreshMaster,
          reviewToken,
        }),
        "Logen delivery orders registered.",
      ),
  );

  server.registerTool(
    "print_logen_waybill",
    {
      title: "Print Logen waybills",
      description:
        "Stage 14: print each PO-SKU batch on AllLive OLIVE-308B, query all waybill numbers, and associate one number with each planned carton. Reprinting requires forceReprint=true.",
      inputSchema: {
        runId: runIdSchema,
        logenMethod: logenMethodSchema.optional(),
        forceReprint: z.boolean().optional(),
      },
      outputSchema: fulfillmentOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ runId, logenMethod, forceReprint }) =>
      fulfillmentReply(
        await workflow.printLogenWaybill({ runId, logenMethod, forceReprint }),
        "Logen waybills submitted to the printer.",
      ),
  );

  server.registerTool(
    "confirm_logen_waybill_numbers",
    {
      title: "Confirm Logen waybill numbers",
      description:
        "After physical printing, show the Logen-read original and current waybill numbers for every carton. Accept only the operator's choice, save the selected numbers, and complete stage 14 without reprinting.",
      inputSchema: {
        runId: runIdSchema,
        confirmations: z.array(waybillNumberConfirmationSchema).min(1).max(1000),
      },
      outputSchema: fulfillmentOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ runId, confirmations }) =>
      fulfillmentReply(
        await workflow.confirmLogenWaybillNumbers({ runId, confirmations }),
        "Logen waybill numbers confirmed by the operator.",
      ),
  );

  server.registerTool(
    "prepare_supplierhub_shipment_tracking",
    {
      title: "Prepare Supplier Hub shipment tracking",
      description:
        "Build the shipment XLSX, attach it in Supplier Hub, and verify the summary and enabled upload button without submitting the external registration.",
      inputSchema: {
        runId: runIdSchema,
        shipDate: dateOnlySchema,
        shipTime: timeOnlySchema,
      },
      outputSchema: fulfillmentOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ runId, shipDate, shipTime }) =>
      fulfillmentReply(
        await workflow.prepareSupplierHubShipmentTracking({ runId, shipDate, shipTime }),
        "Supplier Hub shipment tracking upload prepared without submission.",
      ),
  );

  server.registerTool(
    "register_supplierhub_shipment_tracking",
    {
      title: "Register Supplier Hub shipment tracking",
      description:
        "Build and submit one Supplier Hub shipment XLSX with every carton tracking number, then map shipments by fulfillment center and expected inbound date. An unknown or failed submission is never retried unless forceRetry=true.",
      inputSchema: {
        runId: runIdSchema,
        forceRetry: z.boolean().optional(),
        shipDate: dateOnlySchema,
        shipTime: timeOnlySchema,
      },
      outputSchema: fulfillmentOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ runId, forceRetry, shipDate, shipTime }) =>
      fulfillmentReply(
        await workflow.registerSupplierHubShipmentTracking({
          runId,
          forceRetry,
          shipDate,
          shipTime,
        }),
        "Supplier Hub shipment tracking registered.",
      ),
  );

  server.registerTool(
    "print_supplierhub_shipment_documents",
    {
      title: "Print Supplier Hub shipment documents",
      description:
        "Download and print Supplier Hub shipment labels and statements on SINDOH N600. Reprinting requires forceReprint=true.",
      inputSchema: {
        runId: runIdSchema,
        forceReprint: z.boolean().optional(),
      },
      outputSchema: fulfillmentOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ runId, forceReprint }) =>
      fulfillmentReply(
        await workflow.printSupplierHubShipmentDocuments({ runId, forceReprint }),
        "Supplier Hub shipment documents submitted to the printer.",
      ),
  );

  server.registerTool(
    "list_fulfillment_contexts",
    {
      title: "List fulfillment Scan and Run IDs",
      description: "List recent Scan IDs and Run IDs so an operator can reconnect or recover a workflow manually.",
      inputSchema: { limit: recordLimitSchema },
      outputSchema: fulfillmentOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ limit }) =>
      fulfillmentReply(await workflow.listFulfillmentContexts({ limit }), "Fulfillment IDs loaded."),
  );

  server.registerTool(
    "reset_fulfillment_stage_record",
    {
      title: "Reset a blocked or failed fulfillment stage record",
      description:
        "Destructive recovery tool. In calibration mode quickReset=true removes one stage row. Stage 14 quick reset also clears local waybill candidates and print artifacts while preserving Logen registration keys. For stage 13, clearLogenRegistration=true also clears local registration keys only after the operator has deleted the external Logen reservation.",
      inputSchema: {
        runId: runIdSchema,
        stage: fulfillmentStageSchema,
        confirmation: stageResetConfirmationSchema.optional(),
        allowUnknown: z.boolean().optional(),
        quickReset: z.boolean().optional(),
        clearLogenRegistration: z.boolean().optional(),
      },
      outputSchema: fulfillmentOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ runId, stage, confirmation, allowUnknown, quickReset, clearLogenRegistration }) =>
      fulfillmentReply(
        await workflow.resetFulfillmentStageRecord({
          runId,
          stage: stage as FulfillmentStage,
          confirmation,
          allowUnknown,
          quickReset,
          clearLogenRegistration,
        }),
        "Fulfillment stage record reset.",
      ),
  );

  server.registerTool(
    "delete_fulfillment_run_record",
    {
      title: "Delete a fulfillment Run record",
      description: "Temporarily available destructive recovery tool. Deletes one Run and its linked stage/job records. confirmation must exactly equal runId.",
      inputSchema: { runId: runIdSchema, confirmation: runIdSchema },
      outputSchema: fulfillmentOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ runId, confirmation }) =>
      fulfillmentReply(
        await workflow.deleteFulfillmentRunRecord({ runId, confirmation }),
        "Fulfillment Run deleted.",
      ),
  );

  server.registerTool(
    "delete_fulfillment_scan_record",
    {
      title: "Delete a fulfillment Scan record",
      description: "Temporarily available destructive recovery tool. Deletes one Scan and all Runs linked to it. confirmation must exactly equal scanId.",
      inputSchema: { scanId: scanIdSchema, confirmation: scanIdSchema },
      outputSchema: fulfillmentOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ scanId, confirmation }) =>
      fulfillmentReply(
        await workflow.deleteFulfillmentScanRecord({ scanId, confirmation }),
        "Fulfillment Scan deleted.",
      ),
  );

  server.registerTool(
    "get_fulfillment_run",
    {
      title: "Get fulfillment run",
      description:
        "Read the orders, SKU jobs, tracking numbers, document submissions, and current stage for a fulfillment run.",
      inputSchema: { runId: runIdSchema },
      outputSchema: fulfillmentOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ runId }) =>
      fulfillmentReply(
        await workflow.getFulfillmentRun({ runId }),
        "Fulfillment run loaded.",
      ),
  );

  server.registerTool(
    "run_fulfillment_workflow",
    {
      title: "Run fulfillment workflow",
      description:
        "Run all 11 Supplier Hub and Logen fulfillment stages in sequence. Demo mode is allowed; live mode requires FULFILLMENT_OPERATION_MODE=automatic after step-by-step calibration because this creates remote orders, registers tracking, and physically prints documents.",
      inputSchema: {
        lookAheadDays: lookAheadDaysSchema,
        dateSearchType: dateSearchTypeSchema,
        dateFrom: dateOnlySchema,
        dateTo: dateOnlySchema,
        dataSource: dataSourceSchema,
        logenMethod: logenMethodSchema.optional(),
        refreshMaster: z.boolean().optional(),
        orderNos: calibrationOrderNosSchema,
      },
      outputSchema: fulfillmentOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({
      lookAheadDays,
      dateSearchType,
      dateFrom,
      dateTo,
      dataSource,
      logenMethod,
      refreshMaster,
      orderNos,
    }) =>
      fulfillmentReply(
        await workflow.runFulfillmentWorkflow({
          lookAheadDays,
          dateSearchType,
          dateFrom,
          dateTo,
          dataSource,
          logenMethod,
          refreshMaster,
          orderNos,
        }),
        "Fulfillment workflow run completed.",
      ),
  );
}

function fulfillmentReply(result: FulfillmentToolResult, fallbackMessage: string) {
  return {
    content: [
      {
        type: "text" as const,
        text:
          typeof result.message === "string" && result.message.trim()
            ? result.message
            : fallbackMessage,
      },
    ],
    structuredContent: {
      fulfillment: result as Record<string, unknown>,
    },
  };
}
