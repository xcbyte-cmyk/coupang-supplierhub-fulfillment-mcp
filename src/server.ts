import { existsSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { createWorkflowHttpServer } from "./server-http.js";
import { createWorkflowMcpServer } from "./server-mcp.js";
import { createConfirmationFileOpener, createOrderFileOpener } from "./confirmation-file-opener.js";
import { createWorkspaceWindowPreparer } from "./workspace-window-layout.js";
import {
  createWorkflowToolHandlers,
  createFulfillmentToolHandlers,
} from "./server-tool-handlers.js";
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
import {
  ModeRoutedFulfillmentPrinterAdapter,
  LogenAgent,
  ModeRoutedSupplierHubAdapter,
} from "./fulfillment-mode-router.js";
import { LogenOpenApiAdapter } from "./logen-api-adapter.js";
import { resolveLogenOpenApiEnvironment } from "./logen-api-environment.js";
import { LogenWindowsPrintMcpClient } from "./logen-windows-print-client.js";
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
  LogenIntegrationMethod,
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
import { SupplierHubWorkflow } from "./workflow-module.js";

const PROJECT_ROOT = fileURLToPath(new URL("..", import.meta.url));
loadLocalEnvironmentFiles();
const MCP_PATH = "/mcp";
const PORT = Number(process.env.PORT ?? 4310);
const HOST = "127.0.0.1";
const dashboardHtml = readFileSync(join(PROJECT_ROOT, "public", "workflow.html"), "utf8");
const fulfillmentHtml = readFileSync(
  join(PROJECT_ROOT, "public", "fulfillment.html"),
  "utf8",
);
const practiceHtml = readFileSync(join(PROJECT_ROOT, "public", "practice.html"), "utf8");
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
  autoStart:
    process.platform === "win32"
      ? () => requestLogenWindowsMcpStart(discoveredWaybillPrinter)
      : undefined,
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
const logenApiConfig = resolveLogenOpenApiEnvironment(process.env);
const logenApi = new LogenOpenApiAdapter(logenApiConfig);
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

const httpServer = createWorkflowHttpServer({
  host: HOST,
  port: PORT,
  mcpPath: MCP_PATH,
  fulfillmentHtml,
  projectRoot: PROJECT_ROOT,
  practiceHtml,
  getWorkflowStatus: () => workflow.getStatus(),
  getFulfillmentStatus,
  getLogenTestPrintPopupUrl: () => logenApi.getTestInvoicePrintPopupUrl(),
  toolHandlers: createWorkflowToolHandlers(workflow),
  fulfillmentToolHandlers: {
    ...createFulfillmentToolHandlers(fulfillmentWorkflow, defaultLogenMethod),
    open_order_confirmation_file: createConfirmationFileOpener({
      getRun: (runId) => fulfillmentStore.getRun(runId),
    }),
    open_order_carton_file: createOrderFileOpener({ getRun: runId => fulfillmentStore.getRun(runId) }),
    prepare_workspace_windows: createWorkspaceWindowPreparer({ getRun: runId => fulfillmentStore.getRun(runId) }),
  },
  createMcpServer: () =>
    createWorkflowMcpServer({ workflow, fulfillmentWorkflow, dashboardHtml }),
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

async function getFulfillmentStatus() {
  const apiRegistration = logenApi.getReadiness("register", {
    integrationMethod: "api",
  });
  const apiPrinting = logenApi.getReadiness("print", {
    integrationMethod: "api",
  });
  const websiteRegistration = logenWebsiteMcp.getReadiness("register");
  const websitePrinting = logenWebsiteMcp.getReadiness("print");
  return {
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
        environment: logenApiConfig.environment,
      },
      website_mcp: {
        registration: websiteRegistration,
        printing: websitePrinting,
      },
    },
  };
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

function loadLocalEnvironmentFiles(): void {
  const candidates = [
    join(PROJECT_ROOT, ".env"),
    ...(process.env.SUPPLIERHUB_PORTABLE === "1" || existsSync(join(PROJECT_ROOT, ".portable")) ? [] : [resolve(PROJECT_ROOT, "..", "..", ".env")]),
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

async function requestLogenWindowsMcpStart(
  printerName: string | undefined,
): Promise<void> {
  if (!printerName?.trim()) {
    throw new Error("로젠 송장 프린터 이름이 설정되지 않았습니다.");
  }
  const scriptPath = join(PROJECT_ROOT, "scripts", "start-logen-windows-mcp.ps1");
  if (!existsSync(scriptPath)) {
    throw new Error(`로젠 Windows MCP 시작 스크립트를 찾지 못했습니다: ${scriptPath}`);
  }
  await new Promise<void>((resolveStart, rejectStart) => {
    const child = spawn(
      "pwsh.exe",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        scriptPath,
        "-PrinterName",
        printerName,
      ],
      { cwd: PROJECT_ROOT, stdio: "ignore", windowsHide: true },
    );
    const timeout = setTimeout(() => {
      child.kill();
      rejectStart(new Error("로젠 Windows MCP 시작 요청이 10초 안에 끝나지 않았습니다."));
    }, 10_000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      rejectStart(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      if (code === 0) resolveStart();
      else rejectStart(new Error(`로젠 Windows MCP 시작 스크립트 종료 코드: ${code}`));
    });
  });
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
