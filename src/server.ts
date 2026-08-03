import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import {
  DemoSupplierHubAdapter,
  DryRunPrinterAdapter,
  ExcelPrinterAdapter,
  SupplierHubBrowserAdapter,
} from "./adapters.js";
import {
  DemoFulfillmentPrinterAdapter,
  DemoLogenAdapter,
  DemoSupplierHubFulfillmentAdapter,
  LOGEN_WAYBILL_PRINTER_NAME,
  LogenBrowserAdapter,
  SINDOH_PRINTER_NAME,
  SupplierHubFulfillmentBrowserAdapter,
  WindowsFulfillmentPrinterAdapter,
  type LogenBrowserSelectors,
  type SupplierHubBrowserSelectors,
} from "./fulfillment-adapters.js";
import { registerFulfillmentMcpTools } from "./fulfillment-mcp.js";
import {
  ModeRoutedFulfillmentPrinterAdapter,
  LogenAgent,
  ModeRoutedSupplierHubAdapter,
} from "./fulfillment-mode-router.js";
import { LogenOpenApiAdapter } from "./logen-api-adapter.js";
import { LogenWindowsPrintMcpClient } from "./logen-windows-print-client.js";
import { isAllowedUiRequest } from "./ui-request.js";
import {
  BlockedSupplierHubShipmentAdapter,
  DemoSupplierHubShipmentAdapter,
  LiveSupplierHubShipmentAdapter,
  ModeRoutedSupplierHubShipmentAdapter,
} from "./fulfillment-v2-adapters.js";
import { FulfillmentStore } from "./fulfillment-store.js";
import type {
  CenterMaster,
  FulfillmentDataSource,
  FulfillmentStage,
  LogenIntegrationMethod,
  LogenWaybillNumberConfirmation,
  ProductMaster,
  SenderProfile,
} from "./fulfillment-types.js";
import { FulfillmentWorkflow } from "./fulfillment-workflow.js";
import {
  DemoOrderConfirmationWorkbookAdapter,
  ModeRoutedOrderConfirmationWorkbookAdapter,
  OrderConfirmationWorkbookAdapter,
} from "./order-confirmation-workbook-adapter.js";
import {
  SupplierHubShipmentFulfillmentAdapter,
  discoverInstalledPrinterNameBySuffix,
  type AuthenticatedPdfRequest,
  type ShipmentFulfillmentBrowserConfig,
  type ShipmentFulfillmentSelectors,
} from "./shipment-fulfillment-adapters.js";
import {
  BlockedShipmentWorkbookAdapter,
  DemoShipmentWorkbookAdapter,
  ModeRoutedShipmentWorkbookAdapter,
  ShipmentWorkbookAdapter,
} from "./shipment-workbook-adapter.js";
import { readOrdersFromShipmentWorkbook } from "./xlsx-order-reader.js";
import { JsonStateStore } from "./state-store.js";
import type { WorkflowReply, WorkflowSettings } from "./types.js";
import { SupplierHubWorkflow } from "./workflow-module.js";

const PROJECT_ROOT = fileURLToPath(new URL("..", import.meta.url));
loadLocalEnvironmentFiles();
const UI_URI = "ui://supplierhub-workflow/dashboard-v1.html";
const MCP_PATH = "/mcp";
const PORT = Number(process.env.PORT ?? 4310);
const HOST = "127.0.0.1";
const dashboardHtml = readFileSync(join(PROJECT_ROOT, "public", "workflow.html"), "utf8");
const fulfillmentHtml = readFileSync(
  join(PROJECT_ROOT, "public", "fulfillment.html"),
  "utf8",
);
const fulfillmentOperationMode =
  process.env.FULFILLMENT_OPERATION_MODE === "automatic" ? "automatic" : "calibration";

const legacyStateStore = new JsonStateStore(
  join(PROJECT_ROOT, "data", "workflow-state.json"),
);
const workflow = new SupplierHubWorkflow(
  legacyStateStore,
  {
    suppliers: {
      demo: new DemoSupplierHubAdapter(),
      live: new SupplierHubBrowserAdapter(
        join(PROJECT_ROOT, "data", "browser-profile"),
        join(PROJECT_ROOT, "data", "downloads"),
      ),
    },
    printers: {
      demo: new DryRunPrinterAdapter(),
      live: new ExcelPrinterAdapter(join(PROJECT_ROOT, "scripts", "print-xlsx.ps1")),
    },
  },
);

const fulfillmentStore = new FulfillmentStore(
  resolve(
    PROJECT_ROOT,
    process.env.FULFILLMENT_DB_PATH ?? join("data", "fulfillment.db"),
  ),
);
seedFulfillmentStore(fulfillmentStore);

const fulfillmentMode = async () => (await legacyStateStore.read()).settings.mode;
const shipmentBrowserConfig = shipmentBrowserConfigFromEnvironment();
const blockedShipmentPort = new BlockedSupplierHubShipmentAdapter(
  "Supplier Hub 쉽먼트 URL·셀렉터·PDF 요청 설정을 모두 교정해야 합니다.",
);
const liveShipmentPort = shipmentBrowserConfig
  ? new LiveSupplierHubShipmentAdapter(
      new SupplierHubShipmentFulfillmentAdapter(shipmentBrowserConfig),
    )
  : blockedShipmentPort;
const shipmentPortMode = async () => {
  if ((await fulfillmentMode()) === "demo") return "demo" as const;
  return shipmentBrowserConfig ? ("live" as const) : ("blocked" as const);
};

const shipmentTemplate =
  process.env.FULFILLMENT_SHIPMENT_UPLOAD_TEMPLATE ??
  process.env.FULFILLMENT_SHIPMENT_WORKBOOK;
const blockedWorkbook = new BlockedShipmentWorkbookAdapter(
  "FULFILLMENT_SHIPMENT_UPLOAD_TEMPLATE 경로가 없거나 파일을 찾을 수 없습니다.",
);
const liveWorkbook =
  shipmentTemplate?.trim() && existsSync(resolve(PROJECT_ROOT, shipmentTemplate))
    ? new ShipmentWorkbookAdapter({
        sourceWorkbook: resolve(PROJECT_ROOT, shipmentTemplate),
        outputRoot: resolve(
          PROJECT_ROOT,
          process.env.FULFILLMENT_SHIPMENT_UPLOAD_OUTPUT_DIR ??
            join("data", "shipment-upload-workbooks"),
        ),
        pythonExecutable: process.env.FULFILLMENT_PYTHON_EXECUTABLE,
      })
    : blockedWorkbook;
const workbookMode = async () => {
  if ((await fulfillmentMode()) === "demo") return "demo" as const;
  return liveWorkbook === blockedWorkbook ? ("blocked" as const) : ("live" as const);
};
let waybillPrinterDiscoveryError: string | undefined;
let discoveredWaybillPrinter = process.env.FULFILLMENT_WAYBILL_PRINTER?.trim();
if (!discoveredWaybillPrinter) {
  try {
    discoveredWaybillPrinter = await discoverInstalledPrinterNameBySuffix();
  } catch (error) {
    waybillPrinterDiscoveryError =
      `공유 로젠 송장 프린터 '${LOGEN_WAYBILL_PRINTER_NAME}'의 정확한 설치 이름을 확인하지 못해 실출력을 차단했습니다: ${errorMessage(error)}`;
    discoveredWaybillPrinter = LOGEN_WAYBILL_PRINTER_NAME;
  }
}

const defaultLogenMethod = logenIntegrationMethod();
const logenWindowsPrintMcp = new LogenWindowsPrintMcpClient({
  endpoint:
    process.env.LOGEN_WINDOWS_MCP_URL?.trim() ?? "http://127.0.0.1:4311/mcp",
  token: process.env.LOGEN_WINDOWS_MCP_TOKEN,
  tokenFile: join(PROJECT_ROOT, "data", "logen-windows-mcp.token"),
});
const logenWebsiteMcp = new LogenBrowserAdapter({
  profileDir: join(PROJECT_ROOT, "data", "logen-browser-profile"),
  registrationUrl:
    process.env.LOGEN_REGISTRATION_URL ??
    "https://logis.ilogen.com/",
  waybillUrl:
    process.env.LOGEN_WAYBILL_URL ??
    "https://logis.ilogen.com/common/html/main.html",
  trackingUrl: process.env.LOGEN_TRACKING_URL,
  chromeConnection: "cdp",
  chromeExecutablePath: process.env.SUPPLIERHUB_CHROME_EXECUTABLE,
  selectors: jsonEnvironment<LogenBrowserSelectors>("LOGEN_SELECTORS_JSON"),
  windowsPrintDialog: logenWindowsPrintMcp,
});
const logenApi = new LogenOpenApiAdapter({
  environment: process.env.LOGEN_API_ENVIRONMENT === "live" ? "live" : "test",
  userId: process.env.LOGEN_API_USER_ID,
  customerCode: process.env.LOGEN_CUSTOMER_CODE,
  secretKey: process.env.LOGEN_API_SECRET_KEY,
});
const logenAgent = new LogenAgent(
  fulfillmentMode,
  new DemoLogenAdapter(),
  { api: logenApi, website_mcp: logenWebsiteMcp },
  defaultLogenMethod,
);

const fulfillmentWorkflow = new FulfillmentWorkflow(
  fulfillmentStore,
  {
    supplierHub: new ModeRoutedSupplierHubAdapter(
      fulfillmentMode,
      new DemoSupplierHubFulfillmentAdapter(),
      new SupplierHubFulfillmentBrowserAdapter({
        profileDir:
          process.env.SUPPLIERHUB_PROFILE_DIR?.trim() ||
          join(PROJECT_ROOT, "data", "fulfillment-supplierhub-profile"),
        downloadsDir: join(PROJECT_ROOT, "data", "fulfillment-downloads"),
        chromeConnection: "cdp",
        chromeExecutablePath: process.env.SUPPLIERHUB_CHROME_EXECUTABLE,
        shipmentUrl: process.env.SUPPLIERHUB_SHIPMENT_URL,
        selectors: jsonEnvironment<SupplierHubBrowserSelectors>(
          "SUPPLIERHUB_FULFILLMENT_SELECTORS_JSON",
        ),
      }),
    ),
    logen: logenAgent,
    printer: new ModeRoutedFulfillmentPrinterAdapter(
      fulfillmentMode,
      new DemoFulfillmentPrinterAdapter(),
      new WindowsFulfillmentPrinterAdapter({
        excelPrintScript: join(PROJECT_ROOT, "scripts", "print-xlsx.ps1"),
        shipmentPrintScript: join(
          PROJECT_ROOT,
          "scripts",
          "print-shipment-documents.py",
        ),
        pythonExecutable: process.env.FULFILLMENT_PYTHON_EXECUTABLE,
      }),
    ),
    shipmentHub: new ModeRoutedSupplierHubShipmentAdapter(
      shipmentPortMode,
      new DemoSupplierHubShipmentAdapter(),
      liveShipmentPort,
      blockedShipmentPort,
    ),
    shipmentWorkbook: new ModeRoutedShipmentWorkbookAdapter(
      workbookMode,
      new DemoShipmentWorkbookAdapter(),
      liveWorkbook,
      blockedWorkbook,
    ),
    confirmationWorkbook: new ModeRoutedOrderConfirmationWorkbookAdapter(
      fulfillmentMode,
      new DemoOrderConfirmationWorkbookAdapter(),
      new OrderConfirmationWorkbookAdapter({
        outputRoot: resolve(PROJECT_ROOT, "data", "confirmation-workbooks"),
        pythonExecutable: process.env.FULFILLMENT_PYTHON_EXECUTABLE,
      }),
    ),
  },
  {
    orderPrinterName: process.env.FULFILLMENT_ORDER_PRINTER ?? SINDOH_PRINTER_NAME,
    waybillPrinterName: discoveredWaybillPrinter,
    shipmentPrinterName:
      process.env.FULFILLMENT_SHIPMENT_PRINTER ?? SINDOH_PRINTER_NAME,
    copies: 1,
    shipTime: process.env.FULFILLMENT_SHIP_TIME ?? "16:00",
    shipmentDocumentsDir: resolve(
      PROJECT_ROOT,
      process.env.FULFILLMENT_SHIPMENT_DOCUMENTS_DIR ??
        join("data", "shipment-documents"),
    ),
    modeReader: fulfillmentMode,
    operationModeReader: () => fulfillmentOperationMode,
    waybillPrinterDiscoveryError,
    defaultLogenIntegrationMethod: defaultLogenMethod,
    senderDefaults: {
      customerCode: process.env.LOGEN_CUSTOMER_CODE?.trim() || undefined,
      fareType: process.env.LOGEN_FARE_TYPE?.trim() || "030",
      boxTypeCode: process.env.LOGEN_BOX_TYPE_CODE?.trim() || undefined,
      deliveryFare: Number(process.env.LOGEN_DELIVERY_FARE ?? 0),
    },
  },
);

const dashboardOutputSchema = {
  dashboard: z.record(z.unknown()),
};

const toolHandlers: Record<string, (input: Record<string, unknown>) => Promise<WorkflowReply>> = {
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

const fulfillmentToolHandlers: Record<
  string,
  (input: Record<string, unknown>) => Promise<unknown>
> = {
  open_logen_login: (input) =>
    fulfillmentWorkflow.openLogenLogin({
      runId: asString(input.runId, "runId"),
      logenMethod: optionalLogenIntegrationMethod(input.logenMethod),
    }),
  open_logen_registration: (input) =>
    fulfillmentWorkflow.openLogenSingleOrderRegistration({
      runId: asString(input.runId, "runId"),
      logenMethod: optionalLogenIntegrationMethod(input.logenMethod),
    }),
  open_logen_single_order_registration: (input) =>
    fulfillmentWorkflow.openLogenSingleOrderRegistration({
      runId: asString(input.runId, "runId"),
      logenMethod: optionalLogenIntegrationMethod(input.logenMethod),
    }),
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
      logenMethod: asLogenIntegrationMethod(input.logenMethod),
      refreshMaster: input.refreshMaster === true,
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
      logenMethod: asLogenIntegrationMethod(input.logenMethod),
      refreshMaster: input.refreshMaster === true,
      orderNos: optionalStringArray(input.orderNos, "orderNos"),
    }),
};

function createWorkflowMcpServer(): McpServer {
  const server = new McpServer(
    { name: "coupang-supplierhub-workflow", version: "0.1.0" },
    {
      instructions:
        "Use get_workflow_dashboard first. Scanning never confirms orders. Printing requires a prepared batch and the exact confirmation phrase returned by prepare_print_batch.",
    },
  );

  registerAppResource(server, "supplierhub-workflow-dashboard", UI_URI, {}, async () => ({
    contents: [
      {
        uri: UI_URI,
        mimeType: RESOURCE_MIME_TYPE,
        text: dashboardHtml,
        _meta: {
          ui: {
            prefersBorder: false,
            csp: { connectDomains: [], resourceDomains: [] },
          },
        },
      },
    ],
  }));

  registerAppTool(
    server,
    "get_workflow_dashboard",
    {
      title: "Supplier Hub workflow dashboard",
      description:
        "Use this when the user wants to open or review the Private Label order and printing workflow dashboard.",
      inputSchema: {},
      outputSchema: dashboardOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      _meta: { ui: { resourceUri: UI_URI } },
    },
    async () => mcpReply(await workflow.getStatus()),
  );

  registerAppTool(
    server,
    "open_supplierhub_login",
    {
      title: "Open Supplier Hub login",
      description:
        "Use this when the operator needs to open the dedicated Chrome profile and sign in to Supplier Hub.",
      inputSchema: {},
      outputSchema: dashboardOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      _meta: { ui: { resourceUri: UI_URI } },
    },
    async () => mcpReply(await workflow.openLogin()),
  );

  registerAppTool(
    server,
    "scan_private_label_orders",
    {
      title: "Scan Private Label orders",
      description:
        "Use this to read the Supplier Hub Private Label purchase-order list and record newly discovered order numbers without confirming orders.",
      inputSchema: {},
      outputSchema: dashboardOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      _meta: { ui: { resourceUri: UI_URI } },
    },
    async () => mcpReply(await workflow.scan("manual")),
  );

  registerAppTool(
    server,
    "update_workflow_settings",
    {
      title: "Update workflow settings",
      description:
        "Use this to change demo/live mode, scan cadence, active hours, printer, copies, or date range.",
      inputSchema: {
        mode: z.enum(["demo", "live"]).optional(),
        scheduleEnabled: z.boolean().optional(),
        intervalMinutes: z.number().int().min(5).max(1440).optional(),
        windowStart: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
        windowEnd: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
        printerName: z.string().min(1).max(200).optional(),
        copies: z.number().int().min(1).max(5).optional(),
        lookAheadDays: z.union([z.literal(7), z.literal(30)]).optional(),
        firstLiveScanIsBaseline: z.boolean().optional(),
      },
      outputSchema: dashboardOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      _meta: { ui: { resourceUri: UI_URI } },
    },
    async (args) => mcpReply(await workflow.updateSettings(args)),
  );

  registerAppTool(
    server,
    "prepare_print_batch",
    {
      title: "Prepare print batch",
      description:
        "Use this after the operator selects new orders. It creates an approval-gated print batch but does not download or print yet.",
      inputSchema: {
        orderNos: z.array(z.string().min(1)).min(1).max(100),
      },
      outputSchema: dashboardOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      _meta: { ui: { resourceUri: UI_URI } },
    },
    async ({ orderNos }) => mcpReply(await workflow.preparePrintBatch(orderNos)),
  );

  registerAppTool(
    server,
    "hold_print_batch",
    {
      title: "Hold print batch",
      description: "Use this to hold an approval-pending print batch without printing it.",
      inputSchema: { batchId: z.string().min(1) },
      outputSchema: dashboardOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      _meta: { ui: { resourceUri: UI_URI } },
    },
    async ({ batchId }) => mcpReply(await workflow.holdBatch(batchId)),
  );

  registerAppTool(
    server,
    "print_batch",
    {
      title: "Print approved batch",
      description:
        "Use this only after explicit operator approval. It downloads, validates, and physically prints the batch. confirmation must equal PRINT plus the batch id.",
      inputSchema: {
        batchId: z.string().min(1),
        confirmation: z.string().min(1),
      },
      outputSchema: dashboardOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      _meta: { ui: { resourceUri: UI_URI } },
    },
    async ({ batchId, confirmation }) =>
      mcpReply(await workflow.printBatch(batchId, confirmation)),
  );

  registerFulfillmentMcpTools(server, fulfillmentWorkflow);

  return server;
}

const httpServer = createServer(async (req, res) => {
  try {
    if (!isAllowedHost(req)) {
      sendText(res, 403, "Forbidden host");
      return;
    }
    if (!req.url) {
      sendText(res, 400, "Missing URL");
      return;
    }

    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === "GET" && url.pathname === "/fulfillment") {
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "content-security-policy":
          "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
      });
      res.end(fulfillmentHtml);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/fulfillment/status") {
      const apiRegistration = logenApi.getReadiness("register", {
        integrationMethod: "api",
      });
      const apiPrinting = logenApi.getReadiness("print", {
        integrationMethod: "api",
      });
      const websiteRegistration = logenWebsiteMcp.getReadiness("register");
      const websitePrinting = logenWebsiteMcp.getReadiness("print");
      sendJson(res, 200, {
        workflowMode: await fulfillmentMode(),
        operationMode: fulfillmentOperationMode,
        latestScanId: fulfillmentStore.getLatestScanId(),
        latestRunId: fulfillmentStore.getLatestRunId(),
        scheduleEnabled: process.env.FULFILLMENT_SCHEDULE_ENABLED === "true",
        scheduleRunnable:
          fulfillmentOperationMode === "automatic" &&
          process.env.FULFILLMENT_SCHEDULE_ENABLED === "true",
        orderPrinterName: process.env.FULFILLMENT_ORDER_PRINTER ?? SINDOH_PRINTER_NAME,
        waybillPrinterReady: !waybillPrinterDiscoveryError,
        waybillPrinterName: discoveredWaybillPrinter,
        waybillPrinterMessage: waybillPrinterDiscoveryError,
        shipmentPrinterName:
          process.env.FULFILLMENT_SHIPMENT_PRINTER ?? SINDOH_PRINTER_NAME,
        defaultShipTime: process.env.FULFILLMENT_SHIP_TIME ?? "16:00",
        defaultLogenMethod,
        logenMethods: {
          api: {
            registration: apiRegistration,
            printing: apiPrinting,
            environment:
              process.env.LOGEN_API_ENVIRONMENT === "live" ? "live" : "test",
          },
          website_mcp: {
            registration: websiteRegistration,
            printing: websitePrinting,
          },
        },
      });
      return;
    }

    if (req.method === "POST" && url.pathname.startsWith("/api/fulfillment/tools/")) {
      if (!isAllowedUiRequest(req.headers, HOST, PORT)) {
        sendText(res, 403, "Forbidden origin");
        return;
      }
      const toolName = decodeURIComponent(
        url.pathname.slice("/api/fulfillment/tools/".length),
      );
      const handler = fulfillmentToolHandlers[toolName];
      if (!handler) {
        sendText(res, 404, "Unknown fulfillment tool");
        return;
      }
      const body = await readJsonBody(req);
      sendJson(res, 200, await handler(body));
      return;
    }

    if (req.method === "GET" && url.pathname === "/health") {
      sendJson(res, 200, { ok: true, mcp: `http://${HOST}:${PORT}${MCP_PATH}` });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/status") {
      sendJson(res, 200, await workflow.getStatus());
      return;
    }

    if (req.method === "POST" && url.pathname.startsWith("/api/tools/")) {
      if (!isAllowedUiRequest(req.headers, HOST, PORT)) {
        sendText(res, 403, "Forbidden origin");
        return;
      }
      const toolName = decodeURIComponent(url.pathname.slice("/api/tools/".length));
      const handler = toolHandlers[toolName];
      if (!handler) {
        sendText(res, 404, "Unknown tool");
        return;
      }
      const body = await readJsonBody(req);
      sendJson(res, 200, await handler(body));
      return;
    }

    if (req.method === "OPTIONS" && url.pathname === MCP_PATH) {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, GET, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "content-type, mcp-session-id, last-event-id",
        "Access-Control-Expose-Headers": "Mcp-Session-Id",
      });
      res.end();
      return;
    }

    if (
      url.pathname === MCP_PATH &&
      req.method &&
      new Set(["POST", "GET", "DELETE"]).has(req.method)
    ) {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
      const server = createWorkflowMcpServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res);
      return;
    }

    sendText(res, 404, "Not Found");
  } catch (error) {
    console.error(error);
    if (!res.headersSent) sendJson(res, 500, { error: errorMessage(error) });
    else res.end();
  }
});

let fulfillmentScheduleBusy = false;
let lastFulfillmentScheduledAt = 0;
const scheduler = setInterval(() => {
  workflow.scheduledTick().catch((error) => console.error("Scheduled scan failed", error));
  runScheduledFulfillment().catch((error) =>
    console.error("Scheduled fulfillment failed", error),
  );
}, 30_000);
scheduler.unref();

httpServer.listen(PORT, HOST, () => {
  console.log(`Supplier Hub workflow dashboard: http://${HOST}:${PORT}/`);
  console.log(`Supplier Hub workflow MCP: http://${HOST}:${PORT}${MCP_PATH}`);
});

function mcpReply(reply: WorkflowReply) {
  return {
    content: [{ type: "text" as const, text: reply.message }],
    structuredContent: { dashboard: reply.dashboard },
  };
}

function asString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} 값이 필요합니다.`);
  return value.trim();
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

function isAllowedHost(req: IncomingMessage): boolean {
  const host = req.headers.host ?? "";
  return host === `${HOST}:${PORT}` || host === `localhost:${PORT}`;
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > 128 * 1024) throw new Error("Request body is too large");
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("JSON object body is required");
  }
  return parsed as Record<string, unknown>;
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(JSON.stringify(value));
}

function sendText(res: ServerResponse, status: number, value: string): void {
  res.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "x-content-type-options": "nosniff",
  });
  res.end(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function runScheduledFulfillment(): Promise<void> {
  if (
    fulfillmentOperationMode !== "automatic" ||
    process.env.FULFILLMENT_SCHEDULE_ENABLED !== "true" ||
    fulfillmentScheduleBusy
  ) return;
  const state = await legacyStateStore.read();
  if (!state.settings.scheduleEnabled) return;
  const now = new Date();
  if (!insideScheduleWindow(now, state.settings.windowStart, state.settings.windowEnd)) return;
  const dueAt = lastFulfillmentScheduledAt + state.settings.intervalMinutes * 60_000;
  if (now.getTime() < dueAt) return;

  fulfillmentScheduleBusy = true;
  lastFulfillmentScheduledAt = now.getTime();
  try {
    await fulfillmentWorkflow.runFulfillmentWorkflow({
      lookAheadDays: state.settings.lookAheadDays === 7 ? 7 : 30,
      dataSource: fulfillmentDataSource(),
      logenMethod: defaultLogenMethod,
    });
  } finally {
    fulfillmentScheduleBusy = false;
  }
}

function insideScheduleWindow(now: Date, start: string, end: string): boolean {
  if ([0, 6].includes(now.getDay())) return false;
  const current = now.getHours() * 60 + now.getMinutes();
  const [startHour, startMinute] = start.split(":").map(Number);
  const [endHour, endMinute] = end.split(":").map(Number);
  return current >= startHour * 60 + startMinute && current <= endHour * 60 + endMinute;
}

function fulfillmentDataSource(): FulfillmentDataSource {
  const value = process.env.FULFILLMENT_DATA_SOURCE;
  return value === "backend" || value === "order_file" ? value : "auto";
}

function logenIntegrationMethod(): LogenIntegrationMethod {
  return process.env.LOGEN_INTEGRATION_METHOD === "api" ? "api" : "website_mcp";
}

function asLogenIntegrationMethod(value: unknown): LogenIntegrationMethod {
  return value === undefined || value === null || value === ""
    ? defaultLogenMethod
    : value === "api" || value === "website_mcp"
      ? value
      : (() => {
          throw new Error("logenMethod must be api or website_mcp");
        })();
}

function optionalLogenIntegrationMethod(
  value: unknown,
): LogenIntegrationMethod | undefined {
  return value === undefined || value === null || value === ""
    ? undefined
    : asLogenIntegrationMethod(value);
}

function loadLocalEnvironmentFiles(): void {
  const candidates = [
    join(PROJECT_ROOT, ".env"),
    resolve(PROJECT_ROOT, "..", "..", ".env"),
  ];
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    try {
      process.loadEnvFile(candidate);
    } catch (error) {
      console.warn(`Environment file could not be loaded: ${candidate}: ${errorMessage(error)}`);
    }
  }
}

function jsonEnvironment<T extends object>(name: string): Partial<T> | undefined {
  const raw = process.env[name];
  if (!raw?.trim()) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Partial<T>)
      : undefined;
  } catch {
    console.warn(`${name} is not valid JSON; live adapter remains blocked until corrected.`);
    return undefined;
  }
}

function jsonArrayEnvironment<T>(name: string): T[] | undefined {
  const raw = process.env[name];
  if (!raw?.trim()) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as T[]) : undefined;
  } catch {
    console.warn(`${name} is not valid JSON; live adapter remains blocked until corrected.`);
    return undefined;
  }
}

function shipmentBrowserConfigFromEnvironment(): ShipmentFulfillmentBrowserConfig | undefined {
  const uploadUrl = process.env.SUPPLIERHUB_SHIPMENT_UPLOAD_URL?.trim();
  const shipmentListUrl = process.env.SUPPLIERHUB_SHIPMENT_LIST_URL?.trim();
  const jobsUrl = process.env.SUPPLIERHUB_SHIPMENT_JOBS_URL?.trim();
  const selectors = jsonEnvironment<ShipmentFulfillmentSelectors>(
    "SUPPLIERHUB_SHIPMENT_SELECTORS_JSON",
  );
  const pdfRequests =
    jsonArrayEnvironment<AuthenticatedPdfRequest>(
      "SUPPLIERHUB_SHIPMENT_PDF_REQUESTS_JSON",
    ) ?? [
      {
        type: "label" as const,
        urlTemplate:
          "/ibs/shipment/parcel/pdf-label/generate?parcelShipmentSeq={shipmentId}",
      },
      {
        type: "manifest" as const,
        urlTemplate:
          "/ibs/shipment/parcel/pdf-manifest/generate?parcelShipmentSeq={shipmentId}",
      },
    ];
  const requiredSelectorKeys: Array<keyof ShipmentFulfillmentSelectors> = [
    "uploadReadyMarker",
    "shipDateInput",
    "shipTimeInput",
    "carrierVisibleInput",
    "carrierHiddenInput",
    "workbookInput",
    "uploadSubmitButton",
  ];
  const submissionSelectorKeys: Array<keyof ShipmentFulfillmentSelectors> = [
    "jobsReadyMarker",
    "jobsRows",
    "jobsFileName",
    "jobsStatus",
    "shipmentReadyMarker",
    "shipmentSearchButton",
    "shipmentRows",
    "shipmentId",
    "shipmentCenter",
    "shipmentOrderNo",
  ];
  const selectorsReady = requiredSelectorKeys.every((key) => {
    const value = selectors?.[key];
    return typeof value === "string" && value.trim().length > 0;
  });
  const submissionReady =
    Boolean(jobsUrl && shipmentListUrl) &&
    submissionSelectorKeys.every((key) => {
      const value = selectors?.[key];
      return typeof value === "string" && value.trim().length > 0;
    });
  const pdfReady =
    pdfRequests?.length === 2 &&
    new Set(pdfRequests.map((request) => request.type)).size === 2 &&
    pdfRequests.every(
      (request) =>
        (request.type === "label" || request.type === "manifest") &&
        typeof request.urlTemplate === "string" &&
        request.urlTemplate.trim().length > 0,
    );
  if (!uploadUrl || !selectorsReady || !pdfReady) return undefined;

  return {
    profileDir:
      process.env.SUPPLIERHUB_PROFILE_DIR?.trim() ||
      join(PROJECT_ROOT, "data", "fulfillment-supplierhub-profile"),
    uploadUrl,
    jobsUrl: jobsUrl || undefined,
    shipmentListUrl: shipmentListUrl || uploadUrl,
    selectors: selectors as ShipmentFulfillmentSelectors,
    pdfRequests: pdfRequests as [AuthenticatedPdfRequest, AuthenticatedPdfRequest],
    dateInputFormat:
      process.env.SUPPLIERHUB_DATE_INPUT_FORMAT === "yyyyMMdd"
        ? "yyyyMMdd"
        : "yyyy-MM-dd",
    submissionReady,
  };
}

function seedFulfillmentStore(store: FulfillmentStore): void {
  const at = new Date().toISOString();
  const demoCenters: CenterMaster[] = [
    {
      centerCode: "FC-ICN2",
      centerName: "이천2",
      recipientName: "데모 이천2 센터",
      address: "데모 주소",
      telephone: "0000000000",
      source: "demo",
      updatedAt: at,
    },
    {
      centerCode: "FC-GOY1",
      centerName: "고양1",
      recipientName: "데모 고양1 센터",
      address: "데모 주소",
      telephone: "0000000000",
      source: "demo",
      updatedAt: at,
    },
  ];
  for (const center of demoCenters) {
    if (!store.getCenterMaster(center.centerCode)) store.upsertCenterMaster(center);
  }

  const masterPath = process.env.FULFILLMENT_MASTER_DATA_FILE;
  if (masterPath?.trim() && existsSync(masterPath)) {
    const master = JSON.parse(readFileSync(masterPath, "utf8")) as {
      products?: ProductMaster[];
      centers?: CenterMaster[];
      sender?: SenderProfile;
    };
    for (const product of master.products ?? []) store.upsertProductMaster(product);
    for (const center of master.centers ?? []) store.upsertCenterMaster(center);
    if (master.sender) store.setSenderProfile(master.sender);
  }

  const workbookPath = process.env.FULFILLMENT_SHIPMENT_WORKBOOK;
  if (workbookPath?.trim() && existsSync(workbookPath)) {
    for (const order of readOrdersFromShipmentWorkbook(workbookPath)) {
      for (const item of order.items) {
        if (!item.unitsPerCarton) continue;
        store.upsertProductMaster({
          skuCode: item.skuCode,
          skuName: item.skuName,
          unitsPerCarton: item.unitsPerCarton,
          source: "order_file",
          updatedAt: at,
        });
      }
    }
  }

  const senderFromEnvironment = senderProfileFromEnvironment(at);
  if (senderFromEnvironment) store.setSenderProfile(senderFromEnvironment);
  else if (!store.getSenderProfile()) {
    store.setSenderProfile({
      name: "DEMO SENDER",
      address: "DEMO ADDRESS",
      telephone: "0000000000",
      customerCode: "DEMO0000",
      fareType: "030",
      deliveryFare: 0,
      updatedAt: at,
    });
  }
}

function senderProfileFromEnvironment(updatedAt: string): SenderProfile | undefined {
  const name = process.env.FULFILLMENT_SENDER_NAME?.trim();
  const address = process.env.FULFILLMENT_SENDER_ADDRESS?.trim();
  const telephone = process.env.FULFILLMENT_SENDER_TELEPHONE?.trim();
  const customerCode = process.env.LOGEN_CUSTOMER_CODE?.trim();
  if (!name || !address || !telephone || !customerCode) return undefined;
  return {
    name,
    address,
    telephone,
    mobile: process.env.FULFILLMENT_SENDER_MOBILE?.trim() || undefined,
    postalCode: process.env.FULFILLMENT_SENDER_POSTAL_CODE?.trim() || undefined,
    customerCode,
    fareType: process.env.LOGEN_FARE_TYPE?.trim() || "030",
    boxTypeCode: process.env.LOGEN_BOX_TYPE_CODE?.trim() || undefined,
    deliveryFare: Number(process.env.LOGEN_DELIVERY_FARE ?? 0),
    updatedAt,
  };
}
