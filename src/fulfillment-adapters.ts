import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { access, mkdir, stat, writeFile } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import AdmZip from "adm-zip";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Dialog,
  type Download,
  type Frame,
  type Locator,
  type Page,
} from "playwright-core";
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
  LogenReadiness,
  LogenRegistrationResult,
  LogenPort,
  LogenWaybillResult,
  OrderConfirmationUploadResult,
  PrintSubmission,
  SenderProfile,
  ShipmentDocumentResult,
  ShipmentTrackingResult,
  ShippingJob,
  SupplierHubFulfillmentPort,
} from "./fulfillment-types.js";
import {
  fulfillmentOrderQueryLabel,
  normalizeFulfillmentOrderQuery,
} from "./fulfillment-order-query.js";
import { readShipmentWorkbookData } from "./xlsx-order-reader.js";
import type {
  LogenWindowsPrintDialogPort,
  LogenWindowsPrintDialogResult,
} from "./logen-windows-print-client.js";

export const SINDOH_PRINTER_NAME = "SINDOH N600 Series PCL-8";
export const LOGEN_WAYBILL_PRINTER_NAME = "AllLive OLIVE-308B";

export const SUPPLIER_PRIVATE_LABEL_URL =
  "https://supplier.coupang.com/po-web/cplb/po/list";
export const SUPPLIER_CONFIRMATION_UPLOAD_URL =
  "https://supplier.coupang.com/scm/cplb/po/simple/confirmation/list";
export const SUPPLIERHUB_LOGIN_BUTTON_NAME = "로그인";
const LOGEN_HOME_URL = "https://logis.ilogen.com/";
const LOGEN_MAIN_URL = "https://logis.ilogen.com/common/html/main.html";
const LOGEN_WEBSITE_FARE_PER_CARTON = 4_000;
const LOGEN_LOGIN_TRANSITION_TIMEOUT_MS = 30_000;
const LOGEN_MAIN_READY_TIMEOUT_MS = 20_000;
const LOGEN_PRINT_DIALOG_TIMEOUT_MS = 15_000;
const LOGEN_PRINT_DIALOG_POLL_INTERVAL_MS = 500;
const DEFAULT_PRINT_TIMEOUT_MS = 120_000;
const SUPPLIER_ORDER_PAGE_SETTLE_MS = 2_000;
const SUPPLIER_ORDER_FILTER_SETTLE_MS = 600;
const SUPPLIER_ORDER_RESULTS_SETTLE_MS = 2_000;
const MODULE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export interface SupplierHubBrowserSelectors {
  readyHeading: string;
  orderRows: string;
  orderNumberInput: string;
  orderSearchButton: string;
  dateSearchTypeInput: string;
  inboundDateStartInput: string;
  inboundDateEndInput: string;
  orderCheckbox: string;
  orderFileDownloadButton: string;
  orderFileDownloadConfirmButton?: string;
  confirmationTemplateDownloadButton: string;
  confirmationTemplateDownloadConfirmButton?: string;
  confirmationUploadButton: string;
  confirmationUploadAgreementCheckbox: string;
  confirmationUploadFileInput: string;
  confirmationUploadSubmitButton: string;
  confirmationUploadSuccess?: string;
  nextPageItem: string;
  nextPageButton: string;
  shipmentOrderNumberInput?: string;
  shipmentSearchButton?: string;
  shipmentRows?: string;
  shipmentNumber?: string;
  trackingInputs?: string;
  addTrackingInputButton?: string;
  saveTrackingButton?: string;
  trackingSaveSuccess?: string;
  shipmentLabelDownloadButton?: string;
  shipmentStatementDownloadButton?: string;
  shipmentDownloadConfirmButton?: string;
}

export interface SupplierHubBrowserConfig {
  profileDir: string;
  downloadsDir: string;
  privateLabelUrl?: string;
  shipmentUrl?: string;
  headless?: boolean;
  chromeConnection?: "playwright" | "cdp";
  chromeExecutablePath?: string;
  semiAutomaticLogin?: boolean;
  selectors?: Partial<SupplierHubBrowserSelectors>;
}

export type LogenOrderField =
  | "fixTakeNo"
  | "productName"
  | "quantity"
  | "recipientName"
  | "recipientPostalCode"
  | "recipientAddress1"
  | "recipientAddress2"
  | "recipientPhone"
  | "senderName"
  | "senderPostalCode"
  | "senderAddress1"
  | "senderAddress2"
  | "senderPhone"
  | "customerCode"
  | "fareType"
  | "totalFare";

export interface LogenBrowserSelectors {
  readyMarker?: string;
  registrationMenuLink?: string;
  registrationNewButton?: string;
  /** Legacy selector. The current single-order screen resolves a saved recipient with Enter. */
  recipientLookupButton?: string;
  /** Legacy separate-search input kept only for environment compatibility. */
  registrationSearchInput?: string;
  /** Current single-order screen 조회(F2) button. */
  registrationSearchButton?: string;
  registrationResultRows?: string;
  registrationOrderNumber?: string;
  registrationFields?: Partial<Record<LogenOrderField, string>>;
  registrationSubmitButton?: string;
  registrationSuccess?: string;
  registrationRecipientBranch?: string;
  waybillNoPrintFilter?: string;
  waybillPrintedFilter?: string;
  waybillOpenPrintButton?: string;
  waybillFinalPrintButton?: string;
  waybillWebConfirmDialog?: string;
  waybillWebConfirmYesButton?: string;
  waybillLoadingConfirmButton?: string;
  waybillSheetName?: string;
  /** Legacy separate-waybill-screen selectors kept only for environment compatibility. */
  waybillSearchInput?: string;
  waybillSearchButton?: string;
  waybillResultRows?: string;
  waybillCheckbox?: string;
  waybillPrinterInput?: string;
  waybillPrintButton?: string;
  waybillPrintSuccess?: string;
  trackingSearchInput?: string;
  trackingSearchButton?: string;
  trackingResultRows?: string;
  /** Cell selector for the original number shown after a Logen reissue. */
  trackingOriginalNumber?: string;
  /** Cell selector for the current waybill number. */
  trackingWaybillNumber?: string;
  /** Legacy alias for trackingWaybillNumber. */
  trackingNumber?: string;
}

const DEFAULT_LOGEN_BROWSER_SELECTORS: LogenBrowserSelectors = {
  readyMarker: "#menuInput",
  registrationMenuLink: '#lnb a[title="주문등록/출력(단건)"]',
  registrationNewButton: "button.btn.base.new",
  registrationSearchButton: "button.btn.base.search",
  registrationOrderNumber: "#strTakeNo",
  registrationFields: {
    quantity: "#strQty",
    recipientName: "#strRcvCustNm",
    recipientPhone: "#strRcvCustTelNo",
    recipientAddress1: "#strRcvCustAddr1",
    recipientAddress2: "#strRcvCustAddr2",
    totalFare: "#strTotPrice",
  },
  registrationSubmitButton: "button.btn.base.save",
  registrationSuccess: ".modalWrap.alert",
  registrationRecipientBranch: "#strDlvBranNm",
  waybillNoPrintFilter: "#rdo_noprint",
  waybillPrintedFilter: "#rdo_print",
  waybillOpenPrintButton: "#btnPrint",
  waybillFinalPrintButton: "#prtBtn",
  waybillWebConfirmDialog: ".modalWrap.alert",
  waybillWebConfirmYesButton: "#btn-popupModal1",
  waybillLoadingConfirmButton: "#btn-popupModal2",
  waybillSheetName: "lrm01f0050Sheet1",
};

export interface LogenBrowserConfig {
  profileDir: string;
  homeUrl?: string;
  registrationUrl?: string;
  waybillUrl?: string;
  trackingUrl?: string;
  headless?: boolean;
  chromeConnection?: "playwright" | "cdp";
  chromeExecutablePath?: string;
  selectors?: LogenBrowserSelectors;
  windowsPrintDialog?: LogenWindowsPrintDialogPort;
}

export async function waitForLogenLoginTransition(input: {
  isLoginFormVisible: () => Promise<boolean>;
  isReadyMarkerVisible: () => Promise<boolean>;
  wait: (milliseconds: number) => Promise<void>;
  timeoutMs?: number;
  intervalMs?: number;
}): Promise<"ready" | "left_login" | "timeout"> {
  const timeoutMs = input.timeoutMs ?? LOGEN_LOGIN_TRANSITION_TIMEOUT_MS;
  const intervalMs = input.intervalMs ?? 500;
  const attempts = Math.max(1, Math.ceil(timeoutMs / intervalMs));
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await input.isReadyMarkerVisible()) return "ready";
    if (!(await input.isLoginFormVisible())) return "left_login";
    await input.wait(intervalMs);
  }
  return "timeout";
}

export async function waitForLogenPrintDialog(input: {
  check: () => Promise<LogenWindowsPrintDialogResult>;
  wait: (milliseconds: number) => Promise<void>;
  now?: () => number;
  timeoutMs?: number;
  intervalMs?: number;
}): Promise<LogenWindowsPrintDialogResult> {
  const now = input.now ?? Date.now;
  const timeoutMs = input.timeoutMs ?? LOGEN_PRINT_DIALOG_TIMEOUT_MS;
  const intervalMs = input.intervalMs ?? LOGEN_PRINT_DIALOG_POLL_INTERVAL_MS;
  const deadline = now() + timeoutMs;
  let attempts = 0;

  while (true) {
    attempts += 1;
    const result = await input.check();
    if (!isMissingLogenPrintDialog(result)) return result;

    const remainingMs = deadline - now();
    if (remainingMs <= 0) {
      return {
        ...result,
        message: `로젠 Windows 인쇄창을 ${Math.ceil(timeoutMs / 1_000)}초 동안 ${attempts}회 확인했지만 찾지 못했습니다. 마지막 결과: ${result.message}`,
      };
    }
    await input.wait(Math.min(intervalMs, remainingMs));
  }
}

function isMissingLogenPrintDialog(result: LogenWindowsPrintDialogResult): boolean {
  return (
    !result.success &&
    result.status === "blocked" &&
    /Logen print dialog; found 0|인쇄창.*(?:0개|찾지 못)/i.test(result.message)
  );
}

export interface WindowsFulfillmentPrinterConfig {
  excelPrintScript?: string;
  shipmentPrintScript?: string;
  pythonExecutable?: string;
  timeoutMs?: number;
}

interface LogenSingleOrderRow {
  rowId: string;
  /** Stable server-side reservation key; never the transient IBSheet row id alone. */
  registrationKey: string;
  takeNo: string;
  recipientName: string;
  orderQuantity: number;
  printCount: number;
  originalSlipNos: string[];
  waybillNos: string[];
}

export const DEFAULT_SUPPLIER_SELECTORS: SupplierHubBrowserSelectors = {
  readyHeading:
    'h1:has-text("Private Label 발주 리스트"), h2:has-text("Private Label 발주 리스트"), h3:has-text("Private Label 발주 리스트")',
  orderRows: "table tbody tr",
  orderNumberInput: 'input[placeholder="발주번호를 (,)로 구분하여 입력해주세요"]',
  orderSearchButton: 'button:has-text("검색")',
  dateSearchTypeInput:
    'label:text-is("기간검색") + div input[role="combobox"]',
  inboundDateStartInput: 'input[placeholder="Start date"]',
  inboundDateEndInput: 'input[placeholder="End date"]',
  orderCheckbox: 'input[type="checkbox"]',
  orderFileDownloadButton: 'button:text-is("발주서")',
  orderFileDownloadConfirmButton:
    '[role="dialog"] button:has-text("다운로드"), [role="dialog"] button:has-text("확인"), .ant-modal button:has-text("다운로드"), .ant-modal button:has-text("확인")',
  confirmationTemplateDownloadButton: 'button:has-text("발주서 업로드 양식")',
  confirmationTemplateDownloadConfirmButton:
    '[role="dialog"] button:has-text("다운로드"), [role="dialog"] button:has-text("확인"), .ant-modal button:has-text("다운로드"), .ant-modal button:has-text("확인")',
  confirmationUploadButton: "#btn-upload-show",
  confirmationUploadAgreementCheckbox:
    '#fileUploadModal input[name="checkAgreeAll"]',
  confirmationUploadFileInput:
    '#fileUploadModal input[type="file"][name="uploadFile"]',
  confirmationUploadSubmitButton: "#fileUploadModal #btn-upload-execute",
  confirmationUploadSuccess:
    '[role="dialog"] :text("완료"), .ant-message-success, .ant-notification-notice-success',
  nextPageItem: "li.ant-pagination-next",
  nextPageButton: "button",
};

const DEMO_ORDERS: FulfillmentOrder[] = [
  {
    orderNo: "202607300001",
    status: "발주확정",
    createdAt: "2026-07-30T09:10:00+09:00",
    transportType: "쉽먼트",
    centerCode: "FC-ICN2",
    centerName: "이천2",
    expectedInboundDate: "2026-08-01",
    items: [
      {
        skuCode: "8809000001011",
        skuName: "코멧 TPU 양면 도마 차콜",
        orderedQuantity: 48,
        unitsPerCarton: 12,
        source: "demo",
      },
      {
        skuCode: "8809000001012",
        skuName: "코멧 TPU 양면 도마 아이스블루",
        orderedQuantity: 24,
        unitsPerCarton: 12,
        source: "demo",
      },
    ],
  },
  {
    orderNo: "202607300002",
    status: "발주확정",
    createdAt: "2026-07-30T10:20:00+09:00",
    transportType: "쉽먼트",
    centerCode: "FC-GOY1",
    centerName: "고양1",
    expectedInboundDate: "2026-08-02",
    items: [
      {
        skuCode: "8809000002021",
        skuName: "코멧 걸이형 양면 도마 웜그레이",
        orderedQuantity: 30,
        unitsPerCarton: 10,
        source: "demo",
      },
    ],
  },
];

/** Deterministic, side-effect-free Supplier Hub adapter for tests and demo mode. */
export class DemoSupplierHubFulfillmentAdapter
  implements SupplierHubFulfillmentPort
{
  async open(): Promise<FulfillmentConnectionResult> {
    return {
      status: "ready",
      message: "데모 Supplier Hub 연결이 준비되었습니다.",
      url: "demo://supplierhub/private-label",
    };
  }

  async listOrders(queryInput: FulfillmentOrderQuery): Promise<FulfillmentOrderListResult> {
    const query = normalizeFulfillmentOrderQuery(queryInput);
    const orders = query.dateFrom
      ? DEMO_ORDERS.filter(
          (order) => {
            const date =
              query.dateSearchType === "order_date"
                ? order.createdAt.slice(0, 10)
                : order.expectedInboundDate;
            return date >= query.dateFrom! && date <= query.dateTo!;
          },
        )
      : DEMO_ORDERS;
    return {
      connection: {
        status: "ready",
        message: `데모 발주 ${orders.length}건을 ${fulfillmentOrderQueryLabel(query)} 범위로 조회했습니다.`,
        url: "demo://supplierhub/private-label",
      },
      orders: structuredClone(orders),
    };
  }

  async downloadOrderConfirmationTemplate(
    runId: string,
    orders: FulfillmentOrder[],
  ): Promise<DownloadedOrderConfirmationTemplate> {
    const orderNos = orders.map((order) => order.orderNo);
    const fileName = `발주서_업로드_양식_${sanitizePathSegment(runId)}_demo.xlsx`;
    return {
      fileName,
      filePath: `demo://${runId}/confirmation/${fileName}`,
      orderNos,
    };
  }

  async uploadOrderConfirmationWorkbook(input: {
    runId: string;
    fileName: string;
    filePath: string;
    orderNos: string[];
  }): Promise<OrderConfirmationUploadResult> {
    return {
      status: "confirmed",
      confirmedOrderNos: [...input.orderNos],
      unresolvedOrderNos: [],
      message: `데모 발주 ${input.orderNos.length}건의 확정 엑셀을 업로드했습니다.`,
    };
  }

  async getOrderStatuses(orderNos: string[]): Promise<Record<string, string>> {
    return Object.fromEntries(
      orderNos.map((orderNo) => [
        orderNo,
        DEMO_ORDERS.find((order) => order.orderNo === orderNo)?.status ?? "발주확정",
      ]),
    );
  }

  async downloadOrderFiles(
    runId: string,
    orders: FulfillmentOrder[],
  ): Promise<DownloadedOrderFile[]> {
    return orders.map((order) => {
      const fileName = `발주서_${sanitizePathSegment(order.orderNo)}.xlsx`;
      return {
        orderNo: order.orderNo,
        fileName,
        filePath: `demo://${runId}/orders/${fileName}`,
        items: order.items.map((item) => ({
          skuCode: item.skuCode,
          skuName: item.skuName,
          orderedQuantity: item.orderedQuantity,
          barcode: item.barcode,
          unitsPerCarton: item.unitsPerCarton,
          source: "demo",
        })),
      };
    });
  }

  async registerShipmentTracking(
    orderNo: string,
    slipNos: string[],
  ): Promise<ShipmentTrackingResult> {
    return {
      orderNo,
      shipmentId: `DEMO-SHP-${shortHash(orderNo, 10)}`,
      slipNos: [...new Set(slipNos)],
      success: true,
      message: "데모 쉽먼트에 송장번호를 등록했습니다.",
    };
  }

  async getShipmentDocuments(
    orderNo: string,
    shipmentId = `DEMO-SHP-${shortHash(orderNo, 10)}`,
  ): Promise<ShipmentDocumentResult> {
    const safeOrderNo = sanitizePathSegment(orderNo);
    return {
      orderNo,
      shipmentId,
      documents: [
        {
          type: "shipment_label",
          fileName: `${safeOrderNo}_라벨.pdf`,
          filePath: `demo://shipments/${safeOrderNo}_라벨.pdf`,
        },
        {
          type: "shipment_statement",
          fileName: `${safeOrderNo}_내역서.pdf`,
          filePath: `demo://shipments/${safeOrderNo}_내역서.pdf`,
        },
      ],
    };
  }
}

/** Deterministic carton-level Logen adapter. It never opens a browser or printer. */
export class DemoLogenAdapter implements LogenPort, LogenBatchPort {
  private readonly registrations = new Set<string>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  getReadiness(
    _action: LogenAction,
    context: LogenExecutionContext,
  ): LogenReadiness {
    return {
      ready: true,
      message: `${context.integrationMethod === "api" ? "API" : "웹사이트 MCP"} 데모 채널이 준비되었습니다.`,
    };
  }

  async openRegistration(): Promise<FulfillmentConnectionResult> {
    return {
      status: "ready",
      message: "데모 로젠 로그인 단계가 준비되었습니다.",
      url: "demo://logen/main",
    };
  }

  async openSingleOrderRegistration(): Promise<FulfillmentConnectionResult> {
    return {
      status: "ready",
      message: "데모 주문등록/출력(단건) 화면이 준비되었습니다.",
      url: "demo://logen/single-order",
    };
  }

  async registerOrders(
    jobs: ShippingJob[],
    _sender: SenderProfile,
    _centers: CenterMaster[],
  ): Promise<LogenRegistrationResult[]> {
    return jobs.map((job) => {
      if (this.registrations.has(job.fixTakeNo)) {
        return {
          shippingJobId: job.id,
          fixTakeNo: job.fixTakeNo,
          success: true,
          message: "이미 등록된 데모 로젠 주문을 재사용했습니다.",
        };
      }
      this.registrations.add(job.fixTakeNo);
      return {
        shippingJobId: job.id,
        fixTakeNo: job.fixTakeNo,
        success: true,
        message: `데모 로젠 주문 ${job.cartonIndex}번 박스를 등록했습니다.`,
      };
    });
  }

  async printWaybills(
    jobs: ShippingJob[],
    printerName: string,
  ): Promise<LogenWaybillResult[]> {
    return jobs.map((job) => {
      if (!isLogenWaybillPrinter(printerName)) {
        return {
          shippingJobId: job.id,
          fixTakeNo: job.fixTakeNo,
          success: false,
          status: "failed",
          message: `로젠 송장은 ${LOGEN_WAYBILL_PRINTER_NAME} 프린터만 사용할 수 있습니다.`,
        };
      }
      if (!this.registrations.has(job.fixTakeNo)) {
        return {
          shippingJobId: job.id,
          fixTakeNo: job.fixTakeNo,
          success: false,
          status: "failed",
          message: "먼저 데모 로젠 주문을 등록해야 합니다.",
        };
      }
      return {
        shippingJobId: job.id,
        fixTakeNo: job.fixTakeNo,
        slipNo: numericHash(`slip:${job.fixTakeNo}`, 12),
        success: true,
        status: "submitted",
        message: `데모 송장 출력을 ${this.now().toISOString()}에 제출했습니다.`,
      };
    });
  }

  async registerBatches(
    batches: LogenBatch[],
    _sender: SenderProfile,
    _centersByOrder: Record<string, CenterMaster>,
  ): Promise<LogenBatchRegistrationResult[]> {
    return batches.map((batch) => {
      const reused = this.registrations.has(batch.fixTakeNo);
      this.registrations.add(batch.fixTakeNo);
      return {
        batchId: batch.id,
        fixTakeNo: batch.fixTakeNo,
        success: true,
        status: "registered" as const,
        logenOrderNo: batch.fixTakeNo,
        message: reused
          ? "이미 등록된 데모 로젠 배치를 재사용했습니다."
          : `카톤 ${batch.cartonCount}개의 데모 로젠 배치를 등록했습니다.`,
      };
    });
  }

  async printBatchWaybills(
    batches: LogenBatch[],
    printerName: string,
  ): Promise<LogenBatchWaybillResult[]> {
    return batches.map((batch) => {
      if (!isLogenWaybillPrinter(printerName)) {
        return {
          batchId: batch.id,
          fixTakeNo: batch.fixTakeNo,
          slipNos: [],
          success: false,
          status: "failed" as const,
          message: `로젠 송장은 ${LOGEN_WAYBILL_PRINTER_NAME} 프린터만 사용할 수 있습니다.`,
        };
      }
      if (!this.registrations.has(batch.fixTakeNo)) {
        return {
          batchId: batch.id,
          fixTakeNo: batch.fixTakeNo,
          slipNos: [],
          success: false,
          status: "failed" as const,
          message: "먼저 데모 로젠 배치를 등록해야 합니다.",
        };
      }
      const slipNos = Array.from({ length: batch.cartonCount }, (_, index) =>
        numericHash(`slip:${batch.fixTakeNo}:${index + 1}`, 11),
      );
      return {
        batchId: batch.id,
        fixTakeNo: batch.fixTakeNo,
        slipNos,
        success: true,
        status: "submitted" as const,
        message: `데모 송장 ${slipNos.length}장의 출력을 제출했습니다.`,
      };
    });
  }
}

/** Records submissions in memory while enforcing the two fixed printer routes. */
export class DemoFulfillmentPrinterAdapter implements FulfillmentPrinterPort {
  private readonly submissions: Array<PrintSubmission & { at: string }> = [];

  constructor(private readonly now: () => Date = () => new Date()) {}

  async print(input: {
    files: Array<{ fileName: string; filePath: string }>;
    printerName: string;
    copies: number;
    kind: "order" | "shipment";
  }): Promise<PrintSubmission> {
    if (input.printerName !== SINDOH_PRINTER_NAME) {
      return {
        success: false,
        status: "failed",
        submittedFiles: [],
        message: `${input.kind} 문서는 ${SINDOH_PRINTER_NAME} 프린터로만 보낼 수 있습니다.`,
      };
    }
    const result: PrintSubmission & { at: string } = {
      success: true,
      status: "submitted",
      submittedFiles: input.files.map((file) => file.fileName),
      message: `데모 ${input.kind} 인쇄 ${input.copies}부를 제출했습니다.`,
      at: this.now().toISOString(),
    };
    this.submissions.push(result);
    return structuredClone(result);
  }

  getSubmissions(): Array<PrintSubmission & { at: string }> {
    return structuredClone(this.submissions);
  }
}

/**
 * Live Supplier Hub browser adapter.
 *
 * The read-only Private Label selectors reuse the currently observed screen.
 * Shipment mutation selectors intentionally have no defaults: until they are
 * calibrated against the operator's account, the adapter returns/throws a
 * blocked result before clicking a remote mutation control.
 */
export class SupplierHubFulfillmentBrowserAdapter
  implements SupplierHubFulfillmentPort
{
  private readonly session: PersistentChromeSession;
  private readonly selectors: SupplierHubBrowserSelectors;
  private readonly privateLabelUrl: string;
  private readonly shipmentUrl?: string;
  private readonly semiAutomaticLogin: boolean;

  constructor(private readonly config: SupplierHubBrowserConfig) {
    this.privateLabelUrl = config.privateLabelUrl ?? SUPPLIER_PRIVATE_LABEL_URL;
    this.shipmentUrl = config.shipmentUrl;
    this.semiAutomaticLogin = config.semiAutomaticLogin ?? true;
    this.selectors = { ...DEFAULT_SUPPLIER_SELECTORS, ...config.selectors };
    this.session = new PersistentChromeSession(
      config.profileDir,
      config.headless ?? false,
      config.chromeConnection ?? "playwright",
      config.chromeExecutablePath,
    );
  }

  async open(): Promise<FulfillmentConnectionResult> {
    try {
      const page = await this.session.open(this.privateLabelUrl);
      await page.bringToFront();
      const loginSubmitted = this.semiAutomaticLogin
        ? await this.submitAutofilledLogin(page)
        : false;
      await this.navigateDashboardToPrivateLabel(page, loginSubmitted);
      const connection = await this.privateLabelConnection(page);
      if (loginSubmitted && connection.status === "login_required") {
        return {
          ...connection,
          message:
            "자동완성된 계정으로 로그인 버튼을 눌렀지만 로그인 화면에 머물러 있습니다. 추가 인증 또는 계정 확인이 필요합니다.",
        };
      }
      return connection;
    } catch (error) {
      return {
        status: "error",
        message: errorMessage(error),
      };
    }
  }

  async listOrders(queryInput: FulfillmentOrderQuery): Promise<FulfillmentOrderListResult> {
    try {
      const query = normalizeFulfillmentOrderQuery(queryInput);
      const page = await this.session.open(this.privateLabelUrl);
      await this.navigateDashboardToPrivateLabel(page);
      const connection = await this.privateLabelConnection(page);
      if (connection.status !== "ready") return { connection, orders: [] };
      await page.waitForTimeout(SUPPLIER_ORDER_PAGE_SETTLE_MS);

      if (query.dateSearchType === "order_date") {
        const dateSearchTypeInput = await requireUniqueVisible(
          page.locator(this.selectors.dateSearchTypeInput),
          "Supplier Hub 기간검색 기준 선택란",
        );
        const visibleDateSearchOptions = page
          .locator(".ant-select-dropdown:visible .ant-select-item-option")
          .filter({ hasText: "발주일" });
        if ((await visibleDateSearchOptions.count()) === 0) {
          const dateSearchControl = await requireUniqueVisible(
            dateSearchTypeInput.locator("xpath=.."),
            "Supplier Hub 기간검색 기준 컨트롤",
          );
          await dateSearchControl.click();
        }
        await visibleDateSearchOptions.waitFor({
          state: "visible",
          timeout: 5_000,
        });
        const dateSearchOption = await requireUniqueVisible(
          visibleDateSearchOptions,
          "Supplier Hub 기간검색 '발주일' 옵션",
        );
        await dateSearchOption.click();
        await page.waitForTimeout(SUPPLIER_ORDER_FILTER_SETTLE_MS);
      }

      if (query.dateFrom && query.dateTo) {
        const startInput = await requireUniqueVisible(
          page.locator(this.selectors.inboundDateStartInput),
          "Supplier Hub 입고예정일 시작 입력란",
        );
        const endInput = await requireUniqueVisible(
          page.locator(this.selectors.inboundDateEndInput),
          "Supplier Hub 입고예정일 종료 입력란",
        );
        await startInput.fill(query.dateFrom);
        await endInput.fill(query.dateTo);
        await page.waitForTimeout(SUPPLIER_ORDER_FILTER_SETTLE_MS);
      } else {
        const quickRangeLabel = query.lookAheadDays === 7 ? "다음 7일" : "다음 30일";
        const rangeButton = page.getByRole("button", {
          name: quickRangeLabel,
          exact: true,
        });
        const rangeButtonCount = await visibleCount(rangeButton);
        if (rangeButtonCount !== 1) {
          throw new FulfillmentAdapterBlockedError(
            `Supplier Hub '${quickRangeLabel}' 조회 범위 버튼을 하나로 식별하지 못했습니다.`,
          );
        }
        await rangeButton.click();
        await page.waitForTimeout(SUPPLIER_ORDER_FILTER_SETTLE_MS);
      }

      const search = await requireUniqueVisible(
        page.locator(this.selectors.orderSearchButton),
        "Supplier Hub 발주 검색 버튼",
      );
      await search.click();
      await page.waitForTimeout(SUPPLIER_ORDER_RESULTS_SETTLE_MS);

      const orders = await this.collectAllOrderPages(page);
      return {
        connection: {
          status: "ready",
          message: `Private Label 발주 ${orders.length}건을 ${fulfillmentOrderQueryLabel(query)} 기준으로 조회했습니다.`,
          url: page.url(),
        },
        orders,
      };
    } catch (error) {
      return {
        connection: {
          status: error instanceof FulfillmentAdapterBlockedError ? "blocked" : "error",
          message: errorMessage(error),
        },
        orders: [],
      };
    }
  }

  async downloadOrderConfirmationTemplate(
    runId: string,
    orders: FulfillmentOrder[],
  ): Promise<DownloadedOrderConfirmationTemplate> {
    if (orders.length === 0) throw new FulfillmentAdapterBlockedError("확정할 발주가 없습니다.");
    if (orders.length > 100) {
      throw new FulfillmentAdapterBlockedError("한 번에 최대 100건까지 확정할 수 있습니다.");
    }

    const page = await this.session.open(this.privateLabelUrl);
    await this.requirePrivateLabelReady(page);
    const orderNos = [...new Set(orders.map((order) => order.orderNo))];
    await this.searchOrders(page, orderNos);
    for (const orderNo of orderNos) {
      const row = await requireUniqueVisible(
        page.locator(this.selectors.orderRows).filter({ hasText: orderNo }),
        `발주 ${orderNo} 행`,
      );
      const checkbox = await requireUniqueVisible(
        row.locator(this.selectors.orderCheckbox),
        `발주 ${orderNo} 선택란`,
      );
      if (!(await checkbox.isChecked())) await checkbox.check();
    }

    const button = await requireUniqueVisible(
      page.locator(this.selectors.confirmationTemplateDownloadButton),
      "Supplier Hub 발주서 업로드 양식 다운로드 버튼",
    );
    const download = await this.captureDownload(
      page,
      button,
      this.selectors.confirmationTemplateDownloadConfirmButton,
    );
    const saved = await saveRawDownload(
      download,
      this.config.downloadsDir,
      ["confirmation", runId, "source"],
      runId,
    );
    return { ...saved, orderNos };
  }

  async uploadOrderConfirmationWorkbook(input: {
    runId: string;
    fileName: string;
    filePath: string;
    orderNos: string[];
  }): Promise<OrderConfirmationUploadResult> {
    const before = await this.getOrderStatuses(input.orderNos);
    const pending = input.orderNos.filter((orderNo) => before[orderNo] !== "발주확정");
    const alreadyConfirmed = input.orderNos.filter(
      (orderNo) => before[orderNo] === "발주확정",
    );
    if (pending.length === 0) {
      return {
        status: "confirmed",
        confirmedOrderNos: alreadyConfirmed,
        unresolvedOrderNos: [],
        message: "선택한 발주가 이미 모두 확정되어 엑셀을 다시 업로드하지 않았습니다.",
      };
    }

    let submitClicked = false;
    try {
      const page = await this.session.open(SUPPLIER_CONFIRMATION_UPLOAD_URL);
      await page.waitForLoadState("domcontentloaded");
      const uploadButton = await requireUniqueVisible(
        page.locator(this.selectors.confirmationUploadButton),
        "Supplier Hub 발주확정 파일 업로드 버튼",
      );
      await uploadButton.click();
      const agreement = await locateFinalAgreementCheckbox(
        page,
        this.selectors.confirmationUploadAgreementCheckbox,
      );
      if (!(await agreement.isChecked())) await agreement.check();
      const uploadSurface = agreement.locator(
        "xpath=ancestor::*[.//input[@type='file']][1]",
      );
      const configuredFileInputs = page.locator(
        this.selectors.confirmationUploadFileInput,
      );
      const surfaceFileInputs = uploadSurface.locator('input[type="file"]');
      const fileInputs =
        (await configuredFileInputs.count()) === 1
          ? configuredFileInputs
          : surfaceFileInputs;
      if ((await fileInputs.count()) !== 1) {
        throw new FulfillmentAdapterBlockedError(
          `Supplier Hub 파일 추가 입력란을 하나로 식별하지 못했습니다. 후보: ${await fileInputs.count()}개`,
        );
      }
      await fileInputs.setInputFiles(input.filePath);
      const configuredSubmit = page.locator(
        this.selectors.confirmationUploadSubmitButton,
      );
      const submit =
        (await visibleCount(configuredSubmit)) === 1
          ? await requireUniqueVisible(configuredSubmit, "Supplier Hub 업로드하기 버튼")
          : await requireUniqueVisible(
              uploadSurface.getByRole("button", { name: /업로드\s*하기/ }),
              "Supplier Hub 업로드하기 버튼",
            );
      submitClicked = true;
      await submit.click({ timeout: 5_000 });
      if (this.selectors.confirmationUploadSuccess) {
        await page
          .locator(this.selectors.confirmationUploadSuccess)
          .first()
          .waitFor({ state: "visible", timeout: 10_000 })
          .catch(() => undefined);
      }
      await page.waitForTimeout(1_000);

      const after = await this.getOrderStatuses(pending);
      const newlyConfirmed = pending.filter((orderNo) => after[orderNo] === "발주확정");
      const unresolved = pending.filter((orderNo) => after[orderNo] !== "발주확정");
      const confirmedOrderNos = [...alreadyConfirmed, ...newlyConfirmed];
      return {
        status:
          unresolved.length === 0
            ? "confirmed"
            : confirmedOrderNos.length > 0
              ? "partial"
              : "unknown",
        confirmedOrderNos,
        unresolvedOrderNos: unresolved,
        message:
          unresolved.length === 0
            ? `발주 ${confirmedOrderNos.length}건이 발주확정 상태입니다.`
            : `발주 ${confirmedOrderNos.length}건은 확정됐고 ${unresolved.length}건은 상태가 불명확합니다.`,
      };
    } catch (error) {
      if (!submitClicked) throw error;
      return {
        status: "unknown",
        confirmedOrderNos: alreadyConfirmed,
        unresolvedOrderNos: pending,
        message: `발주서 업로드 요청 후 결과를 확정하지 못했습니다: ${errorMessage(error)}`,
      };
    }
  }

  async getOrderStatuses(orderNos: string[]): Promise<Record<string, string>> {
    const page = await this.session.open(this.privateLabelUrl);
    await this.requirePrivateLabelReady(page);
    const uniqueOrderNos = [...new Set(orderNos)];
    await this.searchOrders(page, uniqueOrderNos);
    const orders = await this.collectAllOrderPages(page);
    const result: Record<string, string> = {};
    for (const orderNo of uniqueOrderNos) {
      result[orderNo] = orders.find((order) => order.orderNo === orderNo)?.status ?? "not_found";
    }
    return result;
  }

  async downloadOrderFiles(
    runId: string,
    orders: FulfillmentOrder[],
  ): Promise<DownloadedOrderFile[]> {
    if (orders.length === 0) return [];
    if (orders.length > 100) {
      throw new FulfillmentAdapterBlockedError("한 번에 최대 100건까지 다운로드할 수 있습니다.");
    }

    const page = await this.session.open(this.privateLabelUrl);
    await this.requirePrivateLabelReady(page);
    const results: DownloadedOrderFile[] = [];

    for (const order of orders) {
      await this.searchOneOrder(page, order.orderNo);
      const row = await requireUniqueVisible(
        page.locator(this.selectors.orderRows).filter({ hasText: order.orderNo }),
        `발주 ${order.orderNo} 행`,
      );
      const checkbox = await requireUniqueVisible(
        row.locator(this.selectors.orderCheckbox),
        `발주 ${order.orderNo} 선택란`,
      );
      if (!(await checkbox.isChecked())) await checkbox.check();

      const button = await requireUniqueVisible(
        page.locator(this.selectors.orderFileDownloadButton),
        "Supplier Hub 발주서 다운로드 버튼",
      );
      const download = await this.captureDownload(
        page,
        button,
        this.selectors.orderFileDownloadConfirmButton,
      );
      const saved = await saveRawDownload(
        download,
        this.config.downloadsDir,
        ["orders", runId, order.orderNo],
        order.orderNo,
      );
      const printableFiles = await expandPrintableOrderFiles(saved);
      for (const printable of printableFiles) {
        let items: FulfillmentOrder["items"] | undefined;
        let center: CenterMaster | undefined;
        let sender: DownloadedOrderFile["sender"];
        if (extname(printable.filePath).toLowerCase() === ".xlsx") {
          try {
            const workbook = readShipmentWorkbookData(printable.filePath);
            const parsedOrder = workbook.orders.find(
              (parsed) => parsed.orderNo === order.orderNo,
            );
            items = parsedOrder?.items;
            center = parsedOrder?.centerMaster
              ? {
                  ...parsedOrder.centerMaster,
                  centerCode: order.centerCode,
                  centerName: order.centerName,
                }
              : undefined;
            sender = workbook.sender;
          } catch {
            // Parsing is best-effort data import, not an XLSX validation gate.
          }
        }
        results.push({
          orderNo: order.orderNo,
          fileName: printable.fileName,
          filePath: printable.filePath,
          items,
          center,
          sender,
        });
      }
    }

    return results;
  }

  async registerShipmentTracking(
    orderNo: string,
    slipNos: string[],
  ): Promise<ShipmentTrackingResult> {
    const uniqueSlipNos = [...new Set(slipNos.map((value) => value.trim()).filter(Boolean))];
    if (uniqueSlipNos.length === 0) {
      return {
        orderNo,
        slipNos: [],
        success: false,
        message: "등록할 송장번호가 없습니다.",
      };
    }

    let saveClicked = false;
    try {
      const { page, row, shipmentId } = await this.findShipment(orderNo);
      const beforeText = (await row.textContent()) ?? "";
      if (uniqueSlipNos.every((slipNo) => beforeText.includes(slipNo))) {
        return {
          orderNo,
          shipmentId,
          slipNos: uniqueSlipNos,
          success: true,
          message: "동일한 송장번호가 이미 쉽먼트에 등록되어 있습니다.",
        };
      }

      const trackingSelector = requiredConfig(
        this.selectors.trackingInputs,
        "Supplier Hub 송장번호 입력 셀렉터",
      );
      let inputs = row.locator(trackingSelector);
      let inputCount = await visibleCount(inputs);
      const addSelector = this.selectors.addTrackingInputButton;
      while (inputCount < uniqueSlipNos.length && addSelector) {
        const addButton = await requireUniqueVisible(
          row.locator(addSelector),
          "Supplier Hub 송장번호 추가 버튼",
        );
        await addButton.click();
        await page.waitForTimeout(150);
        inputs = row.locator(trackingSelector);
        inputCount = await visibleCount(inputs);
      }
      if (inputCount < uniqueSlipNos.length) {
        throw new FulfillmentAdapterBlockedError(
          `송장번호 입력란은 ${inputCount}개지만 등록할 번호는 ${uniqueSlipNos.length}개입니다.`,
        );
      }
      for (let index = 0; index < uniqueSlipNos.length; index += 1) {
        await inputs.nth(index).fill(uniqueSlipNos[index]);
      }

      const saveButton = await requireUniqueVisible(
        row.locator(
          requiredConfig(
            this.selectors.saveTrackingButton,
            "Supplier Hub 송장번호 저장 버튼 셀렉터",
          ),
        ),
        "Supplier Hub 송장번호 저장 버튼",
      );
      saveClicked = true;
      await saveButton.click();
      await page.waitForTimeout(700);

      const confirmed = await this.trackingSaveConfirmed(page, row, uniqueSlipNos);
      return {
        orderNo,
        shipmentId,
        slipNos: uniqueSlipNos,
        success: confirmed,
        message: confirmed
          ? "Supplier Hub 쉽먼트에 송장번호를 등록했습니다."
          : "저장 버튼은 눌렀지만 Supplier Hub 반영 여부를 확인하지 못했습니다. 자동으로 다시 등록하지 마세요.",
      };
    } catch (error) {
      return {
        orderNo,
        slipNos: uniqueSlipNos,
        success: false,
        message: saveClicked
          ? `저장 요청 후 결과를 확인하지 못했습니다. 자동으로 다시 등록하지 마세요. ${errorMessage(error)}`
          : errorMessage(error),
      };
    }
  }

  async getShipmentDocuments(
    orderNo: string,
    expectedShipmentId?: string,
  ): Promise<ShipmentDocumentResult> {
    const { page, row, shipmentId } = await this.findShipment(orderNo);
    if (expectedShipmentId && shipmentId !== expectedShipmentId) {
      throw new FulfillmentAdapterBlockedError(
        `쉽먼트 번호가 다릅니다. 예상 ${expectedShipmentId}, 화면 ${shipmentId}`,
      );
    }

    const documents: ShipmentDocumentResult["documents"] = [];
    for (const definition of [
      {
        type: "shipment_label" as const,
        selector: this.selectors.shipmentLabelDownloadButton,
        label: "쉽먼트 라벨",
      },
      {
        type: "shipment_statement" as const,
        selector: this.selectors.shipmentStatementDownloadButton,
        label: "쉽먼트 내역서",
      },
    ]) {
      const button = await requireUniqueVisible(
        row.locator(requiredConfig(definition.selector, `${definition.label} 셀렉터`)),
        `${definition.label} 다운로드 버튼`,
      );
      const download = await this.captureDownload(
        page,
        button,
        this.selectors.shipmentDownloadConfirmButton,
      );
      const saved = await saveRawDownload(
        download,
        this.config.downloadsDir,
        ["shipments", orderNo],
        `${orderNo}-${definition.type}`,
      );
      documents.push({
        type: definition.type,
        fileName: saved.fileName,
        filePath: saved.filePath,
      });
    }

    return { orderNo, shipmentId, documents };
  }

  async close(): Promise<void> {
    await this.session.close();
  }

  private async privateLabelConnection(page: Page): Promise<FulfillmentConnectionResult> {
    const url = page.url();
    const accessDenied = await page
      .locator("body")
      .evaluate((body) =>
        /Access Denied|You don't have permission to access/i.test(
          (body as HTMLElement).innerText,
        ),
      )
      .catch(() => false);
    if (accessDenied) {
      return {
        status: "blocked",
        message:
          "Supplier Hub 인증 콜백이 Access Denied로 차단되었습니다. 자동화 Chrome 연결 방식을 교정해야 합니다.",
        url,
      };
    }
    if (isLoginUrl(url)) {
      return {
        status: "login_required",
        message: "Supplier Hub 로그인이 필요합니다. 열린 전용 Chrome에서 직접 로그인하세요.",
        url,
      };
    }
    if (!url.includes("/po-web/cplb/po/list")) {
      return {
        status: "blocked",
        message: `Private Label 발주 주소가 아닌 화면으로 이동했습니다: ${url}`,
        url,
      };
    }
    if ((await visibleCount(page.locator(this.selectors.readyHeading))) === 1) {
      return {
        status: "ready",
        message: "Supplier Hub Private Label 발주 화면이 준비되었습니다.",
        url,
      };
    }
    return {
      status: "blocked",
      message: "Private Label 발주 화면을 확인하지 못했습니다. 셀렉터 교정이 필요합니다.",
      url,
    };
  }

  private async submitAutofilledLogin(page: Page): Promise<boolean> {
    if (!isLoginUrl(page.url())) return false;

    const loginButton = page.getByRole("button", {
      name: SUPPLIERHUB_LOGIN_BUTTON_NAME,
      exact: true,
    });
    await loginButton.waitFor({ state: "visible", timeout: 10_000 }).catch(() => undefined);
    if ((await visibleCount(loginButton)) !== 1) return false;

    await loginButton.click();
    await page
      .waitForURL((url) => !isLoginUrl(url.toString()), { timeout: 15_000 })
      .catch(() => undefined);
    await page.waitForLoadState("domcontentloaded", { timeout: 5_000 }).catch(() => undefined);
    return true;
  }

  private async requirePrivateLabelReady(page: Page): Promise<void> {
    await this.navigateDashboardToPrivateLabel(page);
    let connection = await this.privateLabelConnection(page);
    if (connection.status === "login_required" && this.semiAutomaticLogin) {
      const loginSubmitted = await this.submitAutofilledLogin(page);
      if (loginSubmitted) {
        await this.navigateDashboardToPrivateLabel(page, true);
        connection = await this.privateLabelConnection(page);
      }
    }
    if (connection.status !== "ready") {
      throw new FulfillmentAdapterBlockedError(connection.message);
    }
  }

  private async navigateDashboardToPrivateLabel(
    page: Page,
    forceAfterLogin = false,
  ): Promise<void> {
    const currentUrl = page.url();
    if (isLoginUrl(currentUrl) || currentUrl.includes("/po-web/cplb/po/list")) return;
    if (!forceAfterLogin && !isSupplierHubDashboardUrl(currentUrl)) return;
    await page.goto(this.privateLabelUrl, { waitUntil: "domcontentloaded" });
    await page
      .waitForLoadState("domcontentloaded", { timeout: 10_000 })
      .catch(() => undefined);
  }

  private async searchOneOrder(page: Page, orderNo: string): Promise<void> {
    await this.searchOrders(page, [orderNo]);
  }

  private async searchOrders(page: Page, orderNos: string[]): Promise<void> {
    const input = await requireUniqueVisible(
      page.locator(this.selectors.orderNumberInput),
      "Supplier Hub 발주번호 입력란",
    );
    await input.fill(orderNos.join(","));
    const search = await requireUniqueVisible(
      page.locator(this.selectors.orderSearchButton),
      "Supplier Hub 발주 검색 버튼",
    );
    await search.click();
    // Allow the request to start, then wait for the requested rows instead of
    // sleeping for a fixed interval on every search.
    await page.waitForTimeout(250);
    await page
      .locator(".ant-spin-spinning:visible")
      .first()
      .waitFor({ state: "hidden", timeout: 5_000 })
      .catch(() => undefined);
    await page
      .waitForFunction(
        ({ rowSelector, expectedOrderNos }) => {
          const text = [...document.querySelectorAll(rowSelector)]
            .map((row) => row.textContent ?? "")
            .join("\n");
          return expectedOrderNos.every((orderNo) => text.includes(orderNo));
        },
        { rowSelector: this.selectors.orderRows, expectedOrderNos: orderNos },
        { timeout: 5_000 },
      )
      .catch(() => undefined);
  }

  private async collectAllOrderPages(page: Page): Promise<FulfillmentOrder[]> {
    const collected = new Map<string, FulfillmentOrder>();
    for (let pageIndex = 0; pageIndex < 50; pageIndex += 1) {
      for (const order of await readSupplierOrders(page, this.selectors.orderRows)) {
        collected.set(order.orderNo, order);
      }

      const nextItem = page.locator(this.selectors.nextPageItem);
      if ((await nextItem.count()) !== 1) break;
      const classes = (await nextItem.getAttribute("class")) ?? "";
      const nextButton = nextItem.locator(this.selectors.nextPageButton);
      if (
        classes.includes("ant-pagination-disabled") ||
        (await nextButton.count()) !== 1 ||
        (await nextButton.isDisabled())
      ) {
        break;
      }
      await nextButton.click();
      await page.waitForTimeout(700);
    }
    return [...collected.values()];
  }

  private async findShipment(orderNo: string): Promise<{
    page: Page;
    row: Locator;
    shipmentId: string;
  }> {
    const shipmentUrl = requiredConfig(this.shipmentUrl, "Supplier Hub 쉽먼트 URL");
    const orderInputSelector = requiredConfig(
      this.selectors.shipmentOrderNumberInput,
      "Supplier Hub 쉽먼트 발주번호 입력 셀렉터",
    );
    const searchButtonSelector = requiredConfig(
      this.selectors.shipmentSearchButton,
      "Supplier Hub 쉽먼트 검색 버튼 셀렉터",
    );
    const rowsSelector = requiredConfig(
      this.selectors.shipmentRows,
      "Supplier Hub 쉽먼트 행 셀렉터",
    );
    const shipmentNumberSelector = requiredConfig(
      this.selectors.shipmentNumber,
      "Supplier Hub 쉽먼트 번호 셀렉터",
    );

    const page = await this.session.open(shipmentUrl);
    if (isLoginUrl(page.url())) {
      throw new FulfillmentAdapterBlockedError(
        "Supplier Hub 로그인이 필요합니다. 열린 전용 Chrome에서 직접 로그인하세요.",
      );
    }
    const input = await requireUniqueVisible(
      page.locator(orderInputSelector),
      "Supplier Hub 쉽먼트 발주번호 입력란",
    );
    await input.fill(orderNo);
    const search = await requireUniqueVisible(
      page.locator(searchButtonSelector),
      "Supplier Hub 쉽먼트 검색 버튼",
    );
    await search.click();
    await page.waitForTimeout(800);
    const row = await requireUniqueVisible(
      page.locator(rowsSelector).filter({ hasText: orderNo }),
      `발주 ${orderNo}의 쉽먼트 행`,
    );
    const shipmentNumber = await requireUniqueVisible(
      row.locator(shipmentNumberSelector),
      `발주 ${orderNo}의 쉽먼트 번호`,
    );
    const shipmentId = ((await shipmentNumber.textContent()) ?? "").trim();
    if (!shipmentId) {
      throw new FulfillmentAdapterBlockedError(`발주 ${orderNo}의 쉽먼트 번호가 비어 있습니다.`);
    }
    return { page, row, shipmentId };
  }

  private async captureDownload(
    page: Page,
    button: Locator,
    confirmSelector?: string,
  ): Promise<Download> {
    const acceptNativeConfirmation = (dialog: Dialog) => {
      if (dialog.type() === "confirm") void dialog.accept();
      else void dialog.dismiss();
    };
    page.once("dialog", acceptNativeConfirmation);
    const immediate = page
      .waitForEvent("download", { timeout: 10_000 })
      .catch(() => undefined);
    let directDownload: Download | undefined;
    try {
      await button.click();
      directDownload = await immediate;
    } finally {
      page.off("dialog", acceptNativeConfirmation);
    }
    if (directDownload) return directDownload;
    if (!confirmSelector) {
      throw new FulfillmentAdapterBlockedError(
        "다운로드가 시작되지 않았고 확인 버튼 셀렉터도 설정되지 않았습니다.",
      );
    }
    await page.locator(confirmSelector).first().waitFor({
      state: "visible",
      timeout: 5_000,
    });
    const confirm = await requireUniqueVisible(
      page.locator(confirmSelector),
      "다운로드 확인 버튼",
    );
    const pending = page.waitForEvent("download", { timeout: 30_000 });
    await confirm.click();
    return await pending;
  }

  private async trackingSaveConfirmed(
    page: Page,
    row: Locator,
    slipNos: string[],
  ): Promise<boolean> {
    if (this.selectors.trackingSaveSuccess) {
      const success = page.locator(this.selectors.trackingSaveSuccess);
      if ((await visibleCount(success)) > 0) return true;
    }
    const refreshedText = (await row.textContent()) ?? "";
    return slipNos.every((slipNo) => refreshedText.includes(slipNo));
  }
}

/**
 * Live Logen browser adapter.
 *
 * Login is always manual through the dedicated persistent profile. Destructive
 * selectors and verification markers are required configuration; without them
 * the affected carton is reported as blocked and no submit/print button is
 * clicked.
 */
export class LogenBrowserAdapter implements LogenPort, LogenBatchPort {
  private readonly session: PersistentChromeSession;
  private readonly homeUrl: string;
  private readonly selectors: LogenBrowserSelectors;
  private registrationPage?: Page;
  private registrationSurface?: Page | Frame;

  constructor(private readonly config: LogenBrowserConfig) {
    this.homeUrl = config.homeUrl ?? LOGEN_HOME_URL;
    this.selectors = {
      ...DEFAULT_LOGEN_BROWSER_SELECTORS,
      ...config.selectors,
      registrationFields: {
        ...DEFAULT_LOGEN_BROWSER_SELECTORS.registrationFields,
        ...config.selectors?.registrationFields,
      },
    };
    this.session = new PersistentChromeSession(
      config.profileDir,
      config.headless ?? false,
      config.chromeConnection ?? "playwright",
      config.chromeExecutablePath,
    );
  }

  getReadiness(action: LogenAction): LogenReadiness {
    try {
      if (action === "register") {
        requiredConfig(this.config.registrationUrl, "로젠 주문등록 URL");
        return {
          ready: true,
          message: "로젠 주문등록 채널이 준비되었습니다. 로그인은 11단계, 화면 이동은 12단계, 실제 입력은 13단계에서 확인합니다.",
        };
      }
      this.requireWaybillConfiguration();
      return { ready: true, message: "로젠 웹사이트 MCP 설정이 준비되었습니다." };
    } catch (error) {
      return { ready: false, message: errorMessage(error) };
    }
  }

  async open(): Promise<FulfillmentConnectionResult> {
    try {
      const page = await this.session.open(this.homeUrl);
      await page.bringToFront();
      return await this.connectionStatus(page);
    } catch (error) {
      return { status: "error", message: errorMessage(error) };
    }
  }

  async openRegistration(): Promise<FulfillmentConnectionResult> {
    try {
      this.clearRegistrationSurface();
      const page = await this.session.open(
        requiredConfig(this.config.registrationUrl, "로젠 주문등록 URL"),
      );
      await page.bringToFront();
      const loginResult = await this.clickLoginWhenCredentialsAreReady(page);
      if (loginResult) return loginResult;

      // The root page is only the login entry point. After a successful login
      // (or when the persistent profile is already authenticated), stage 11
      // must continue from the authenticated Logen main shell.
      const mainUrl = this.config.waybillUrl?.trim() || LOGEN_MAIN_URL;
      if (!sameOriginAndPath(page.url(), mainUrl)) {
        await page.goto(mainUrl, { waitUntil: "domcontentloaded" });
      }
      await page
        .locator(requiredConfig(this.selectors.readyMarker, "로젠 로그인 완료 표시 셀렉터"))
        .waitFor({ state: "visible", timeout: LOGEN_MAIN_READY_TIMEOUT_MS })
        .catch(() => undefined);
      await page.waitForTimeout(1_000);
      await page.bringToFront();
      const connection = await this.connectionStatus(page);
      if (connection.status !== "ready") return connection;
      return {
        status: "ready",
        message: "로젠 로그인 후 메인 화면으로 이동했습니다.",
        url: page.url(),
      };
    } catch (error) {
      return { status: "error", message: errorMessage(error) };
    }
  }

  async openWaybill(): Promise<FulfillmentConnectionResult> {
    try {
      const page = await this.session.open(
        requiredConfig(this.config.waybillUrl, "로젠 송장출력 URL"),
      );
      await page.bringToFront();
      return await this.connectionStatus(page);
    } catch (error) {
      return { status: "error", message: errorMessage(error) };
    }
  }

  async openSingleOrderRegistration(): Promise<FulfillmentConnectionResult> {
    try {
      const page = await this.session.open(
        this.config.waybillUrl?.trim() || LOGEN_MAIN_URL,
      );
      await page.bringToFront();
      await this.requireReady(page);
      const registrationSurface = await this.openRegistrationSurface(page);
      this.rememberRegistrationSurface(registrationSurface);
      await this.registrationPage?.bringToFront();
      return {
        status: "ready",
        message: "예약관리의 주문등록/출력(단건) 화면으로 이동했습니다.",
        url: page.url(),
      };
    } catch (error) {
      return {
        status: error instanceof FulfillmentAdapterBlockedError ? "blocked" : "error",
        message: errorMessage(error),
      };
    }
  }

  async registerOrders(
    jobs: ShippingJob[],
    sender: SenderProfile,
    centers: CenterMaster[],
  ): Promise<LogenRegistrationResult[]> {
    if (jobs.length === 0) return [];
    if (sender.customerCode.startsWith("DEMO")) {
      return jobs.map((job) => ({
        shippingJobId: job.id,
        fixTakeNo: job.fixTakeNo,
        success: false,
        message: "실연동 로젠 송하인 기준정보를 먼저 설정해야 합니다.",
      }));
    }
    if (centers.length !== 1) {
      return jobs.map((job) => ({
        shippingJobId: job.id,
        fixTakeNo: job.fixTakeNo,
        success: false,
        message:
          "로젠 브라우저 등록에는 한 발주의 센터 한 곳만 전달해야 합니다. 발주별로 나누어 다시 호출하세요.",
      }));
    }

    let registrationSurface: Page | Frame;
    try {
      registrationSurface = await this.requireRememberedRegistrationSurface();
      this.requireRegistrationConfiguration();
    } catch (error) {
      return jobs.map((job) => ({
        shippingJobId: job.id,
        fixTakeNo: job.fixTakeNo,
        success: false,
        status: "failed" as const,
        message: `주문등록 제출 전 중단: ${errorMessage(error)}`,
      }));
    }

    const center = centers[0];
    const results: LogenRegistrationResult[] = [];
    for (const job of jobs) {
      let registrationClicked = false;
      try {
        const noPrintFilter = await requireUniqueVisible(
          registrationSurface.locator(
            requiredConfig(
              this.selectors.waybillNoPrintFilter,
              "로젠 미출력 필터 셀렉터",
            ),
          ),
          "로젠 미출력 필터",
        );
        await this.selectRegistrationRadio(
          registrationSurface,
          noPrintFilter,
          "로젠 미출력 필터",
        );
        await registrationSurface.waitForTimeout(1_000);
        const beforeRows = await this.readSingleOrderRows(registrationSurface);

        const newButton = await requireUniqueVisible(
          registrationSurface.locator(
            requiredConfig(
              this.selectors.registrationNewButton,
              "로젠 신규(F3) 버튼 셀렉터",
            ),
          ),
          "로젠 신규(F3) 버튼",
        );
        await newButton.click();
        await registrationSurface.waitForTimeout(1_000);
        await this.fillRegistration(registrationSurface, job, sender, center);
        const submit = await requireUniqueVisible(
          registrationSurface.locator(
            requiredConfig(
              this.selectors.registrationSubmitButton,
              "로젠 주문등록 제출 버튼 셀렉터",
            ),
          ),
          "로젠 주문등록 제출 버튼",
        );
        registrationClicked = true;
        await submit.click();
        const successModal = await this.waitForRegistrationSuccess(
          registrationSurface,
        );
        const confirmation = await requireUniqueVisible(
          successModal.getByRole("button", { name: "확인", exact: true }),
          "로젠 주문등록 완료 확인 버튼",
        );
        await confirmation.click();

        const registeredRows = await this.waitForNewRegistrationRows(
          registrationSurface,
          beforeRows,
          center.centerName,
          job.shippedQuantity,
        );
        const registrationKeys = [
          ...new Set(
            registeredRows
              .map((row) => row.registrationKey.trim())
              .filter(Boolean),
          ),
        ];
        const registeredQuantity = registeredRows.reduce(
          (total, row) => total + row.orderQuantity,
          0,
        );
        if (
          registrationKeys.length > 0 &&
          registeredQuantity === job.shippedQuantity
        ) {
          results.push({
            shippingJobId: job.id,
            fixTakeNo: job.fixTakeNo,
            success: true,
            status: "registered",
            logenOrderNo: registrationKeys[0],
            registrationKeys,
            message: `로젠 주문을 저장했습니다. 예약행 ${registrationKeys.length}개를 확인했습니다.`,
          });
        } else {
          results.push({
            shippingJobId: job.id,
            fixTakeNo: job.fixTakeNo,
            success: false,
            status: "unknown",
            message:
              `저장은 완료됐지만 새 예약행을 확정하지 못했습니다. 키 후보 ${registrationKeys.length}개, 수량 ${registeredQuantity}/${job.shippedQuantity}. 자동으로 다시 등록하지 마세요.`,
          });
        }
      } catch (error) {
        results.push({
          shippingJobId: job.id,
          fixTakeNo: job.fixTakeNo,
          success: false,
          status: registrationClicked ? "unknown" : "failed",
          message: registrationClicked
            ? `등록 요청 후 결과를 확인하지 못했습니다. 자동으로 다시 등록하지 마세요. ${errorMessage(error)}`
            : `주문등록 제출 전 중단: ${errorMessage(error)}`,
        });
      }
    }
    return results;
  }

  async printWaybills(
    jobs: ShippingJob[],
    printerName: string,
    expectedCountByJob: Readonly<Record<string, number>> = {},
  ): Promise<LogenWaybillResult[]> {
    const now = new Date().toISOString();
    const batches: LogenBatch[] = jobs.map((job) => ({
      id: `legacy-${job.id}`,
      runId: job.runId,
      orderNo: job.orderNo,
      skuCode: job.skuCode,
      skuName: job.skuName,
      orderedQuantity: job.shippedQuantity,
      unitsPerCarton: job.unitsPerCarton,
      cartonCount: expectedCountByJob[job.id] ?? 1,
      fixTakeNo: job.fixTakeNo,
      status: "registered",
      logenOrderNo: job.fixTakeNo,
      createdAt: now,
      updatedAt: now,
    }));
    const results = await this.printBatchWaybills(batches, printerName, {
      integrationMethod: "website_mcp",
    });
    const byBatch = new Map(results.map((result) => [result.batchId, result]));
    return jobs.map((job) => {
      const result = byBatch.get(`legacy-${job.id}`);
      return {
        shippingJobId: job.id,
        fixTakeNo: job.fixTakeNo,
        slipNo: result?.slipNos[0],
        success: Boolean(result?.success),
        status: result?.status ?? "failed",
        message: result?.message ?? "로젠 송장 출력 결과가 없습니다.",
      };
    });
  }

  async registerBatches(
    batches: LogenBatch[],
    sender: SenderProfile,
    centersByOrder: Record<string, CenterMaster>,
  ): Promise<LogenBatchRegistrationResult[]> {
    const results: LogenBatchRegistrationResult[] = [];
    for (const batch of batches) {
      const center = centersByOrder[batch.orderNo];
      if (!center) {
        results.push({
          batchId: batch.id,
          fixTakeNo: batch.fixTakeNo,
          success: false,
          status: "failed",
          message: `발주 ${batch.orderNo}의 센터 기준정보가 없습니다.`,
        });
        continue;
      }
      const [result] = await this.registerOrders(
        [batchToShippingJob(batch)],
        sender,
        [center],
      );
      results.push({
        batchId: batch.id,
        fixTakeNo: batch.fixTakeNo,
        success: Boolean(result?.success),
        status: result?.success
          ? "registered"
          : result?.status === "unknown"
            ? "unknown"
            : "failed",
        logenOrderNo: result?.success ? result.logenOrderNo : undefined,
        registrationKeys: result?.success ? result.registrationKeys : undefined,
        message: result?.message ?? "로젠 배치 등록 결과가 없습니다.",
      });
    }
    return results;
  }

  async inspectBatchWaybills(
    batches: LogenBatch[],
    context: LogenExecutionContext = { integrationMethod: "website_mcp" },
  ): Promise<LogenBatchWaybillInspectionResult[]> {
    let registrationSurface: Page | Frame;
    try {
      registrationSurface = await this.requireRememberedRegistrationSurface();
      const search = await requireUniqueVisible(
        registrationSurface.locator(
          requiredConfig(
            this.selectors.registrationSearchButton,
            "로젠 조회(F2) 버튼 셀렉터",
          ),
        ),
        "로젠 조회(F2) 버튼",
      );
      await search.click();
      await registrationSurface.waitForTimeout(1_000);
    } catch (error) {
      return batches.map((batch) => ({
        batchId: batch.id,
        registrationKeys: batch.registrationKeys ??
          (batch.logenOrderNo ? [batch.logenOrderNo] : []),
        printState: "unknown" as const,
        success: false,
        message: errorMessage(error),
      }));
    }

    const results: LogenBatchWaybillInspectionResult[] = [];
    for (const batch of batches) {
      try {
        let registrationKeys = [
          ...new Set(
            (batch.registrationKeys?.length
              ? batch.registrationKeys
              : batch.logenOrderNo
                ? [batch.logenOrderNo]
                : [])
              .map((value) => value.trim())
              .filter(Boolean),
          ),
        ];
        if (registrationKeys.length !== batch.cartonCount) {
          await this.setRegistrationPrintFilter(registrationSurface, "unprinted");
          const recovered = await this.recoverUnprintedRegistrationRows(
            registrationSurface,
            batch,
            context.recipientNamesByBatchId?.[batch.id]?.trim(),
          );
          registrationKeys = recovered.map((row) => row.registrationKey);
        }
        const keySet = new Set(registrationKeys);
        const rows = (
          await this.readRegistrationRowsAcrossPrintStates(registrationSurface)
        ).filter((row) => keySet.has(row.registrationKey));
        const quantity = rows.reduce(
          (total, row) => total + row.orderQuantity,
          0,
        );
        const printedCount = rows.filter((row) => row.printCount >= 1).length;
        const printState =
          rows.length === 0
            ? "unknown"
            : printedCount === 0
              ? "unprinted"
              : printedCount === rows.length
                ? "printed"
                : "mixed";
        const success =
          registrationKeys.length === batch.cartonCount &&
          new Set(registrationKeys).size === batch.cartonCount &&
          rows.length === batch.cartonCount &&
          quantity === batch.cartonCount &&
          rows.every((row) => row.orderQuantity === 1);
        results.push({
          batchId: batch.id,
          registrationKeys,
          printState,
          success,
          message: success
            ? `예약행 ${registrationKeys.length}개와 출력 상태(${printState})를 확인했습니다.`
            : `예약행 출력 상태를 확정하지 못했습니다. 행 ${rows.length}개, 수량 ${quantity}/${batch.cartonCount}, 상태 ${printState}.`,
        });
      } catch (error) {
        results.push({
          batchId: batch.id,
          registrationKeys: batch.registrationKeys ??
            (batch.logenOrderNo ? [batch.logenOrderNo] : []),
          printState: "unknown",
          success: false,
          message: errorMessage(error),
        });
      }
    }
    return results;
  }

  async printBatchWaybills(
    batches: LogenBatch[],
    printerName: string,
    context: LogenExecutionContext = { integrationMethod: "website_mcp" },
  ): Promise<LogenBatchWaybillResult[]> {
    if (batches.length === 0) return [];
    if (!isLogenWaybillPrinter(printerName)) {
      return batches.map((batch) => ({
        batchId: batch.id,
        fixTakeNo: batch.fixTakeNo,
        slipNos: [],
        success: false,
        status: "failed" as const,
        message: `로젠 송장은 ${LOGEN_WAYBILL_PRINTER_NAME} 프린터만 사용할 수 있습니다.`,
      }));
    }

    let page: Page;
    let registrationSurface: Page | Frame;
    try {
      this.requireWaybillConfiguration();
      if (this.config.windowsPrintDialog) {
        const readiness = await this.config.windowsPrintDialog.health();
        if (!readiness.ready) {
          throw new FulfillmentAdapterBlockedError(readiness.message);
        }
      }
      registrationSurface = await this.requireRememberedRegistrationSurface();
      page = isFrameSurface(registrationSurface)
        ? registrationSurface.page()
        : registrationSurface;
      await page.bringToFront();
    } catch (error) {
      return batches.map((batch) => ({
        batchId: batch.id,
        fixTakeNo: batch.fixTakeNo,
        slipNos: [],
        success: false,
        status: "failed" as const,
        message: errorMessage(error),
      }));
    }

    const results: LogenBatchWaybillResult[] = [];
    for (const batch of batches) {
      let finalPrintClicked = false;
      let previousDefaultPrinter: string | undefined;
      let registrationKeys = [
        ...new Set(
          (batch.registrationKeys?.length
            ? batch.registrationKeys
            : batch.logenOrderNo
              ? [batch.logenOrderNo]
              : [])
            .map((value) => value.trim())
            .filter(Boolean),
        ),
      ];
      try {
        if (registrationKeys.length === 0) {
          const recipientName = context.recipientNamesByBatchId?.[batch.id]?.trim();
          const recovered = await this.recoverUnprintedRegistrationRows(
            registrationSurface,
            batch,
            recipientName,
          );
          registrationKeys = recovered.map((row) => row.registrationKey);
        }
        const registrationKeySet = new Set(registrationKeys);
        const matchingRows = (
          await this.readRegistrationRowsAcrossPrintStates(registrationSurface)
        ).filter((row) => registrationKeySet.has(row.registrationKey));
        this.assertPrintableRegistrationRows(
          batch,
          matchingRows,
          Boolean(context.forceReprint),
        );
        const reprint = matchingRows.every((row) => row.printCount >= 1);
        const filter = await requireUniqueVisible(
          registrationSurface.locator(
            requiredConfig(
              reprint
                ? this.selectors.waybillPrintedFilter
                : this.selectors.waybillNoPrintFilter,
              reprint ? "로젠 출력 필터 셀렉터" : "로젠 미출력 필터 셀렉터",
            ),
          ),
          reprint ? "로젠 출력 필터" : "로젠 미출력 필터",
        );
        await this.selectRegistrationRadio(
          registrationSurface,
          filter,
          reprint ? "로젠 출력 필터" : "로젠 미출력 필터",
        );
        await registrationSurface.waitForTimeout(1_000);

        const selectedRows = await this.selectRegistrationRows(
          registrationSurface,
          registrationKeys,
        );
        this.assertPrintableRegistrationRows(
          batch,
          selectedRows,
          Boolean(context.forceReprint),
        );
        await registrationSurface.waitForTimeout(100);

        const openPrint = await requireUniqueVisible(
          registrationSurface.locator(
            requiredConfig(
              this.selectors.waybillOpenPrintButton,
              "로젠 운송장출력 버튼 셀렉터",
            ),
          ),
          "로젠 운송장출력 버튼",
        );
        await openPrint.click();
        const finalPrint = await this.waitForFinalPrintButton(
          page,
          registrationSurface,
        );
        const popupNumberCandidates =
          await this.readPrintPopupNumberCandidates(finalPrint);
        const windowsPrintDialog = this.config.windowsPrintDialog;
        if (windowsPrintDialog) {
          const prepared =
            await windowsPrintDialog.prepareDefaultPrinter(
              batch.cartonCount,
            );
          if (!prepared.success || prepared.status !== "ready") {
            throw new Error(`Windows 기본 프린터 설정 실패: ${prepared.message}`);
          }
          previousDefaultPrinter = prepared.previousPrinterName?.trim();
          if (!previousDefaultPrinter) {
            throw new Error(
              "Windows 기본 프린터 설정 결과에 기존 프린터 정보가 없습니다.",
            );
          }
        }
        await page.waitForTimeout(1_500);
        finalPrintClicked = true;
        await finalPrint.click();
        await this.confirmLogenWebPrintPrompt(page);
        await this.dismissLogenWaybillLoadingPrompt(page);
        await page.waitForTimeout(200);

        let printConfirmed = false;
        if (windowsPrintDialog) {
          const configured = await waitForLogenPrintDialog({
            check: () => windowsPrintDialog.configure(batch.cartonCount),
            wait: (milliseconds) => page.waitForTimeout(milliseconds),
          });
          if (!configured.success || configured.status !== "ready") {
            throw new Error(`Windows 프린터 설정 실패: ${configured.message}`);
          }
          // Confirm performs the same exact-dialog, printer, count, and button
          // validation itself. Avoid a second PowerShell/UIA scan before click.
          const confirmed = await windowsPrintDialog.confirm(
            batch.cartonCount,
          );
          printConfirmed = confirmed.success && confirmed.status === "submitted";
          if (!printConfirmed) {
            throw new Error(`Windows 인쇄 제출 결과 불명확: ${confirmed.message}`);
          }
        } else {
          const successSelector = requiredConfig(
            this.selectors.waybillPrintSuccess,
            "로젠 송장 출력 확인 셀렉터",
          );
          await page.locator(successSelector).first().waitFor({
            state: "visible",
            timeout: 10_000,
          });
          printConfirmed = true;
        }

        const popupPreferred = popupNumberCandidates
          .map((candidate) => candidate.waybillNo ?? candidate.originalSlipNo)
          .filter((value): value is string => Boolean(value));
        const popupExact =
          popupNumberCandidates.length === batch.cartonCount &&
          popupPreferred.length === batch.cartonCount &&
          new Set(popupPreferred).size === batch.cartonCount;
        const numberCandidates = popupExact
          ? popupNumberCandidates
          : await this.waitForWaybillNumberCandidates(
              registrationSurface,
              registrationKeys,
              batch.cartonCount,
            );
        const slipNos = numberCandidates
          .map((candidate) => candidate.waybillNo ?? candidate.originalSlipNo)
          .filter((value): value is string => Boolean(value));
        const exact =
          printConfirmed &&
          numberCandidates.length === batch.cartonCount &&
          slipNos.length === batch.cartonCount &&
          new Set(slipNos).size === batch.cartonCount;
        results.push({
          batchId: batch.id,
          fixTakeNo: batch.fixTakeNo,
          slipNos,
          registrationKeys,
          numberCandidates,
          success: exact,
          status: exact ? "submitted" : "unknown",
          message: exact
            ? `로젠 송장 ${slipNos.length}장을 출력하고 원송장번호·운송장번호 후보를 조회했습니다.`
            : `출력은 제출됐지만 송장번호 후보 ${slipNos.length}개가 계획 카톤 ${batch.cartonCount}개와 일치하지 않습니다. 자동으로 다시 출력하지 마세요.`,
        });
      } catch (error) {
        results.push({
          batchId: batch.id,
          fixTakeNo: batch.fixTakeNo,
          slipNos: [],
          registrationKeys: registrationKeys.length > 0 ? registrationKeys : undefined,
          success: false,
          status: finalPrintClicked ? "unknown" : "failed",
          message: finalPrintClicked
            ? `출력 요청 후 결과를 확인하지 못했습니다. 자동으로 다시 출력하지 마세요. ${errorMessage(error)}`
            : errorMessage(error),
        });
      } finally {
        if (previousDefaultPrinter && this.config.windowsPrintDialog) {
          let restoreError: string | undefined;
          try {
            const restored =
              await this.config.windowsPrintDialog.restoreDefaultPrinter(
                previousDefaultPrinter,
                batch.cartonCount,
              );
            if (!restored.success || restored.status !== "ready") {
              restoreError = restored.message;
            }
          } catch (error) {
            restoreError = errorMessage(error);
          }

          if (restoreError) {
            const result = results.at(-1);
            if (result?.batchId === batch.id) {
              result.message += ` Windows 기본 프린터 복원 실패: ${restoreError}`;
            }
          }
        }
      }
    }
    return results;
  }

  async close(): Promise<void> {
    await this.session.close();
  }

  private async connectionStatus(page: Page): Promise<FulfillmentConnectionResult> {
    const url = page.url();
    if (isLoginUrl(url) || (await this.hasVisibleLoginForm(page))) {
      return {
        status: "login_required",
        message: "로젠 로그인이 필요합니다. 아이디와 비밀번호를 입력한 뒤 11단계를 다시 누르세요.",
        url,
      };
    }
    if (!this.selectors.readyMarker) {
      return {
        status: "blocked",
        message: "로젠 로그인 완료 표시 셀렉터를 먼저 교정해야 합니다.",
        url,
      };
    }
    if ((await visibleCount(page.locator(this.selectors.readyMarker))) === 1) {
      return {
        status: "ready",
        message: "로젠 기업전용시스템 로그인 세션이 준비되었습니다.",
        url,
      };
    }
    return {
      status: "blocked",
      message: "로젠 로그인 완료 화면을 확인하지 못했습니다.",
      url,
    };
  }

  private async hasVisibleLoginForm(page: Page): Promise<boolean> {
    const userId = page.locator('[id="user.id"]');
    const password = page.locator('[id="user.pw"]');
    const login = page.getByRole("link", { name: "로그인", exact: true });
    return (
      (await visibleCount(userId)) === 1 &&
      (await visibleCount(password)) === 1 &&
      (await visibleCount(login)) === 1
    );
  }

  private async clickLoginWhenCredentialsAreReady(
    page: Page,
  ): Promise<FulfillmentConnectionResult | undefined> {
    if (!(await this.hasVisibleLoginForm(page))) return undefined;
    await page.waitForTimeout(700);
    const userId = await requireUniqueVisible(
      page.locator('[id="user.id"]'),
      "로젠 아이디 입력란",
    );
    const password = await requireUniqueVisible(
      page.locator('[id="user.pw"]'),
      "로젠 비밀번호 입력란",
    );
    if (!(await userId.inputValue()).trim() || !(await password.inputValue())) {
      return {
        status: "login_required",
        message: "로젠 로그인 정보가 비어 있습니다. 열린 창에서 입력한 뒤 11단계를 다시 누르세요.",
        url: page.url(),
      };
    }

    const login = await requireUniqueVisible(
      page.getByRole("link", { name: "로그인", exact: true }),
      "로젠 로그인 버튼",
    );
    await login.click();
    const readyMarker = requiredConfig(
      this.selectors.readyMarker,
      "로젠 로그인 완료 표시 셀렉터",
    );
    const transition = await waitForLogenLoginTransition({
      isLoginFormVisible: () => this.hasVisibleLoginForm(page),
      isReadyMarkerVisible: async () =>
        (await visibleCount(page.locator(readyMarker))) === 1,
      wait: (milliseconds) => page.waitForTimeout(milliseconds),
    });
    if (transition === "timeout") {
      return {
        status: "blocked",
        message:
          "로젠 로그인 버튼을 눌렀지만 30초 안에 로그인 완료 화면으로 전환되지 않았습니다. 화면의 안내를 확인하세요.",
        url: page.url(),
      };
    }
    return undefined;
  }

  private async requireReady(page: Page): Promise<void> {
    const connection = await this.connectionStatus(page);
    if (connection.status !== "ready") {
      throw new FulfillmentAdapterBlockedError(connection.message);
    }
  }

  private async openConfiguredPage(url: string | undefined, name: string): Promise<Page> {
    return await this.session.open(requiredConfig(url, name));
  }

  private clearRegistrationSurface(): void {
    this.registrationPage = undefined;
    this.registrationSurface = undefined;
  }

  private rememberRegistrationSurface(surface: Page | Frame): void {
    this.registrationSurface = surface;
    this.registrationPage = isFrameSurface(surface) ? surface.page() : surface;
  }

  /**
   * Stage 13 must only reuse the screen opened by stage 12. It deliberately
   * does not navigate, check the login shell, or click the reservation menu.
   */
  private async requireRememberedRegistrationSurface(): Promise<Page | Frame> {
    const page = this.registrationPage;
    const surface = this.registrationSurface;
    if (!page || !surface || page.isClosed() || (isFrameSurface(surface) && surface.isDetached())) {
      this.clearRegistrationSurface();
      throw new FulfillmentAdapterBlockedError(
        "12단계에서 열어둔 로젠 주문등록/출력(단건) 화면이 없습니다. 11단계 로그인 후 12단계 화면 이동을 다시 실행하세요.",
      );
    }

    const newButtonSelector = requiredConfig(
      this.selectors.registrationNewButton,
      "로젠 신규(F3) 버튼 셀렉터",
    );
    const visibleNewButtons = await visibleCount(surface.locator(newButtonSelector)).catch(() => 0);
    if (visibleNewButtons !== 1) {
      this.clearRegistrationSurface();
      throw new FulfillmentAdapterBlockedError(
        `12단계에서 열어둔 주문등록 화면을 더 이상 확인할 수 없습니다. 신규(F3) 버튼 후보: ${visibleNewButtons}개. 12단계 화면 이동을 다시 실행하세요.`,
      );
    }

    await page.bringToFront();
    return surface;
  }

  private requireRegistrationConfiguration(): void {
    requiredConfig(this.config.registrationUrl, "로젠 주문등록 URL");
    requiredConfig(this.selectors.readyMarker, "로젠 로그인 완료 표시 셀렉터");
    requiredConfig(this.selectors.registrationMenuLink, "로젠 주문등록 메뉴 셀렉터");
    requiredConfig(this.selectors.registrationNewButton, "로젠 신규(F3) 버튼 셀렉터");
    requiredConfig(this.selectors.registrationSubmitButton, "로젠 주문등록 제출 버튼 셀렉터");
    requiredConfig(this.selectors.registrationSuccess, "로젠 주문등록 완료 창 셀렉터");
    requiredConfig(
      this.selectors.registrationRecipientBranch,
      "로젠 수하인 배송지점 셀렉터",
    );
    requiredConfig(this.selectors.waybillNoPrintFilter, "로젠 미출력 필터 셀렉터");
    requiredConfig(this.selectors.waybillSheetName, "로젠 단건 주문 IBSheet 이름");
    const fields = this.selectors.registrationFields ?? {};
    for (const field of [
      "quantity",
      "recipientName",
      "recipientPhone",
      "recipientAddress1",
      "totalFare",
    ] as const) {
      requiredConfig(fields[field], `로젠 주문등록 ${field} 셀렉터`);
    }
  }

  private requireWaybillConfiguration(): void {
    this.requireRegistrationConfiguration();
    requiredConfig(this.selectors.waybillNoPrintFilter, "로젠 미출력 필터 셀렉터");
    requiredConfig(this.selectors.waybillPrintedFilter, "로젠 출력 필터 셀렉터");
    requiredConfig(
      this.selectors.waybillOpenPrintButton,
      "로젠 운송장출력 버튼 셀렉터",
    );
    requiredConfig(
      this.selectors.waybillFinalPrintButton,
      "로젠 출력창 운송장출력 버튼 셀렉터",
    );
    if (!this.config.windowsPrintDialog) {
      requiredConfig(this.selectors.waybillPrintSuccess, "로젠 송장 출력 확인 셀렉터");
    }
  }

  private async openRegistrationSurface(page: Page): Promise<Page | Frame> {
    const existingSurface = await this.findOpenRegistrationSurface(page);
    if (existingSurface) return existingSurface;

    let menu = page.locator(
      requiredConfig(this.selectors.registrationMenuLink, "로젠 주문등록 메뉴 셀렉터"),
    );
    if ((await visibleCount(menu)) !== 1) {
      const reservationMenu = page.getByRole("link", {
        name: "예약관리",
        exact: true,
      });
      if ((await visibleCount(reservationMenu)) === 1) {
        await reservationMenu.click();
        await page.waitForTimeout(1_000);
        menu = page.locator(
          requiredConfig(
            this.selectors.registrationMenuLink,
            "로젠 주문등록 메뉴 셀렉터",
          ),
        );
      }
    }
    await menu
      .first()
      .waitFor({ state: "visible", timeout: 15_000 })
      .catch(() => undefined);
    if ((await visibleCount(menu)) !== 1) {
      throw new FulfillmentAdapterBlockedError(
        `로젠 주문등록 메뉴를 하나로 식별하지 못했습니다. 표시된 후보: ${await visibleCount(menu)}개`,
      );
    }
    await menu.click();

    const newButtonSelector = requiredConfig(
      this.selectors.registrationNewButton,
      "로젠 신규(F3) 버튼 셀렉터",
    );
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const openedSurface = await this.findOpenRegistrationSurface(page);
      if (openedSurface) return openedSurface;
      await page.waitForTimeout(250);
    }
    throw new FulfillmentAdapterBlockedError(
      "로젠 주문등록/출력(단건) 메뉴는 눌렀지만 입력 화면을 찾지 못했습니다.",
    );
  }

  private async findOpenRegistrationSurface(page: Page): Promise<Page | Frame | undefined> {
    const newButtonSelector = requiredConfig(
      this.selectors.registrationNewButton,
      "로젠 신규(F3) 버튼 셀렉터",
    );
    if ((await visibleCount(page.locator(newButtonSelector))) === 1) return page;
    for (const frame of page.frames()) {
      if (frame === page.mainFrame()) continue;
      const frameElement = await frame.frameElement().catch(() => undefined);
      if (!frameElement) continue;
      const isActive = await frameElement.evaluate(
        (element) => element.parentElement?.classList.contains("is-active") ?? false,
      );
      if (!isActive) continue;
      if ((await visibleCount(frame.locator(newButtonSelector))) === 1) return frame;
    }
    return undefined;
  }

  private async readSingleOrderRows(
    page: Page | Frame,
  ): Promise<LogenSingleOrderRow[]> {
    const sheetName = requiredConfig(
      this.selectors.waybillSheetName,
      "로젠 단건 주문 IBSheet 이름",
    );
    const rows = await page.evaluate(({ configuredSheetName }) => {
      type SheetRow = Record<string, unknown> & { id?: string | number };
      type SheetApi = {
        getDataRows(): SheetRow[];
        getRowValue?(row: SheetRow): Record<string, unknown>;
      };
      const scope = globalThis as unknown as Record<string, unknown>;
      const sheet = scope[configuredSheetName] as SheetApi | undefined;
      if (!sheet || typeof sheet.getDataRows !== "function") {
        throw new Error(`IBSheet '${configuredSheetName}'을(를) 찾지 못했습니다.`);
      }
      // Keep browser-side helpers as object methods. tsx otherwise rewrites
      // local function values to calls to its Node-only `__name` helper.
      const normalize = {
        text(value: unknown): string {
          if (value instanceof Date) return value.toISOString();
          return String(value ?? "").replace(/\s+/g, " ").trim();
        },
        numeric(value: unknown): number {
          const parsed = Number(normalize.text(value).replace(/[^0-9.-]/g, ""));
          return Number.isFinite(parsed) ? parsed : 0;
        },
        keyPart(value: unknown): string {
          if (value instanceof Date) return String(value.getTime());
          return normalize.text(value).replace(/[|\r\n]/g, "");
        },
      };
      return sheet.getDataRows().map((row, index) => {
        const value =
          (typeof sheet.getRowValue === "function" ? sheet.getRowValue(row) : row) ??
          row;
        const takeNo = normalize.keyPart(value.takeNo ?? row.takeNo);
        const fixTakeNo = normalize.keyPart(value.fixTakeNo ?? row.fixTakeNo);
        const takeDate = normalize.keyPart(value.takeDt ?? row.takeDt);
        const sequence = normalize.keyPart(value.seq ?? row.seq);
        const customerCode = normalize.keyPart(value.fixcustCd ?? row.fixcustCd);
        const registrationKey = takeNo
          ? `takeNo:${takeNo}`
          : fixTakeNo
            ? `fixTakeNo:${fixTakeNo}`
            : takeDate && sequence && customerCode
              ? `reservation:${takeDate}|${sequence}|${customerCode}`
              : "";
        return {
          rowId: normalize.text(row.id ?? value.id ?? index),
          registrationKey,
          takeNo,
          recipientName: normalize.text(value.rcvCustNm ?? row.rcvCustNm),
          orderQuantity: normalize.numeric(
            value.ordQty ?? value.qty ?? row.ordQty ?? row.qty,
          ),
          printCount: normalize.numeric(value.prtCnt ?? row.prtCnt),
          originalSlipText: normalize.text(
            value.orgSlipNo ?? value.orgnSlipNo ?? row.orgSlipNo ?? row.orgnSlipNo,
          ),
          waybillText: normalize.text(value.slipNo ?? row.slipNo),
        };
      });
    }, { configuredSheetName: sheetName });
    return rows.map((row) => ({
      rowId: row.rowId,
      registrationKey: row.registrationKey,
      takeNo: row.takeNo,
      recipientName: row.recipientName,
      orderQuantity: row.orderQuantity,
      printCount: row.printCount,
      originalSlipNos: extractLogenSlipNumbers(row.originalSlipText),
      waybillNos: extractLogenSlipNumbers(row.waybillText),
    }));
  }

  private async waitForRegistrationSuccess(
    page: Page | Frame,
  ): Promise<Locator> {
    const selector = requiredConfig(
      this.selectors.registrationSuccess,
      "로젠 주문등록 완료 창 셀렉터",
    );
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const modals = page.locator(selector);
      const visible: Locator[] = [];
      for (let index = 0; index < (await modals.count()); index += 1) {
        const modal = modals.nth(index);
        if (await modal.isVisible()) visible.push(modal);
      }
      if (visible.length > 1) {
        throw new FulfillmentAdapterBlockedError(
          `로젠 주문등록 결과 창이 ${visible.length}개 표시되어 결과를 확정하지 못했습니다.`,
        );
      }
      if (visible.length === 1) {
        const message = cleanCellText(await visible[0].innerText());
        if (!/(?:정상.*처리|처리.*정상|처리.*완료)/.test(message)) {
          throw new FulfillmentAdapterBlockedError(
            `로젠 주문등록이 완료되지 않았습니다: ${message || "결과 문구 없음"}`,
          );
        }
        return visible[0];
      }
      await page.waitForTimeout(250);
    }
    throw new FulfillmentAdapterBlockedError(
      "로젠 저장(F5) 후 완료 결과 창을 확인하지 못했습니다.",
    );
  }

  private async waitForNewRegistrationRows(
    page: Page | Frame,
    beforeRows: LogenSingleOrderRow[],
    recipientName: string,
    expectedQuantity: number,
  ): Promise<LogenSingleOrderRow[]> {
    const previousKeys = new Set(
      beforeRows.map((row) => row.registrationKey).filter(Boolean),
    );
    let latest: LogenSingleOrderRow[] = [];
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const rows = await this.readSingleOrderRows(page).catch(() => []);
      const added = rows.filter(
        (row) =>
          Boolean(row.registrationKey) &&
          !previousKeys.has(row.registrationKey) &&
          cleanCellText(row.recipientName) === cleanCellText(recipientName),
      );
      if (added.length > 0) latest = added;
      const quantity = added.reduce(
        (total, row) => total + row.orderQuantity,
        0,
      );
      if (added.length > 0 && quantity === expectedQuantity) return added;
      if (quantity > expectedQuantity) return added;
      await page.waitForTimeout(250);
    }
    if (latest.length > 0) return latest;
    throw new FulfillmentAdapterBlockedError(
      "저장 완료 후 새 로젠 예약행을 IBSheet에서 확인하지 못했습니다.",
    );
  }

  private async waitForStoredRecipient(
    page: Page | Frame,
    fields: Partial<Record<LogenOrderField, string>>,
  ): Promise<{ address: string; phone: string; branch: string }> {
    const address = await requireUniqueVisible(
      page.locator(
        requiredConfig(fields.recipientAddress1, "로젠 수하인 주소 셀렉터"),
      ),
      "로젠 수하인 주소 입력란",
    );
    const phone = await requireUniqueVisible(
      page.locator(
        requiredConfig(fields.recipientPhone, "로젠 수하인 전화번호 셀렉터"),
      ),
      "로젠 수하인 전화번호 입력란",
    );
    const branch = await requireUniqueVisible(
      page.locator(
        requiredConfig(
          this.selectors.registrationRecipientBranch,
          "로젠 수하인 배송지점 셀렉터",
        ),
      ),
      "로젠 수하인 배송지점 입력란",
    );
    let current = { address: "", phone: "", branch: "" };
    for (let attempt = 0; attempt < 20; attempt += 1) {
      current = {
        address: await address.inputValue(),
        phone: await phone.inputValue(),
        branch: await branch.inputValue(),
      };
      if (current.address.trim() && current.phone.trim() && current.branch.trim()) {
        return current;
      }
      await page.waitForTimeout(250);
    }
    return current;
  }

  private async fillRegistration(
    page: Page | Frame,
    job: ShippingJob,
    _sender: SenderProfile,
    center: CenterMaster,
  ): Promise<void> {
    const fields = this.selectors.registrationFields ?? {};
    const recipientName = await requireUniqueVisible(
      page.locator(
        requiredConfig(fields.recipientName, "로젠 주문등록 recipientName 셀렉터"),
      ),
      "로젠 수하인명 입력란",
    );
    await setControlValue(recipientName, center.centerName);
    await recipientName.press("Enter");
    const storedRecipient = await this.waitForStoredRecipient(page, fields);
    if (
      !storedRecipient.address.trim() ||
      !storedRecipient.phone.trim() ||
      !storedRecipient.branch.trim()
    ) {
      throw new FulfillmentAdapterBlockedError(
        `로젠에 '${center.centerName}' 센터의 저장된 수하인 주소·전화번호·배송지점이 없습니다. 저장된 센터 정보를 먼저 확인하세요.`,
      );
    }

    const values = {
      quantity: String(job.shippedQuantity),
      totalFare: String(job.shippedQuantity * LOGEN_WEBSITE_FARE_PER_CARTON),
    };
    for (const field of ["quantity", "totalFare"] as const) {
      const control = await requireUniqueVisible(
        page.locator(
          requiredConfig(fields[field], `로젠 주문등록 ${field} 셀렉터`),
        ),
        `로젠 주문등록 ${field} 입력란`,
      );
      await setControlValue(control, values[field]);
    }
    await page.waitForTimeout(1_000);
  }

  private async setRegistrationPrintFilter(
    page: Page | Frame,
    state: "unprinted" | "printed",
  ): Promise<void> {
    const selector = requiredConfig(
      state === "unprinted"
        ? this.selectors.waybillNoPrintFilter
        : this.selectors.waybillPrintedFilter,
      state === "unprinted"
        ? "로젠 미출력 필터 셀렉터"
        : "로젠 출력 필터 셀렉터",
    );
    const filter = await requireUniqueVisible(
      page.locator(selector),
      state === "unprinted" ? "로젠 미출력 필터" : "로젠 출력 필터",
    );
    await this.selectRegistrationRadio(
      page,
      filter,
      state === "unprinted" ? "로젠 미출력 필터" : "로젠 출력 필터",
    );
    await page.waitForTimeout(1_000);
  }

  private async selectRegistrationRadio(
    page: Page | Frame,
    control: Locator,
    description: string,
  ): Promise<void> {
    if (await control.isChecked()) return;

    const controlId = await control.getAttribute("id");
    const labels = controlId
      ? page.locator(`label[for=${JSON.stringify(controlId)}]`)
      : undefined;
    if (labels && (await visibleCount(labels)) === 1) {
      const label = await requireUniqueVisible(labels, `${description} 라벨`);
      await label.click();
    } else {
      // Some Logen radio inputs are intentionally covered by their styled
      // labels. If a unique label is unavailable, bypass hit testing while
      // preserving the input's native click/change handlers.
      await control.check({ force: true });
    }

    if (!(await control.isChecked())) {
      throw new FulfillmentAdapterBlockedError(
        `${description}을(를) 선택했지만 선택 상태가 반영되지 않았습니다.`,
      );
    }
  }

  private async readRegistrationRowsAcrossPrintStates(
    page: Page | Frame,
  ): Promise<LogenSingleOrderRow[]> {
    const rowsByIdentity = new Map<string, LogenSingleOrderRow>();
    for (const state of ["unprinted", "printed"] as const) {
      await this.setRegistrationPrintFilter(page, state);
      for (const row of await this.readSingleOrderRows(page)) {
        rowsByIdentity.set(`${row.registrationKey}|${row.rowId}`, row);
      }
    }
    await this.setRegistrationPrintFilter(page, "unprinted");
    return [...rowsByIdentity.values()];
  }

  private async recoverUnprintedRegistrationRows(
    page: Page | Frame,
    batch: LogenBatch,
    recipientName?: string,
  ): Promise<LogenSingleOrderRow[]> {
    if (!recipientName) {
      throw new FulfillmentAdapterBlockedError(
        `로젠 배치 ${batch.fixTakeNo}의 예약행 키와 수하인명이 없어 안전하게 복구할 수 없습니다. 13단계를 다시 등록하지 마세요.`,
      );
    }
    const expectedRecipient = cleanCellText(recipientName);
    const candidates = (await this.readSingleOrderRows(page)).filter(
      (row) =>
        Boolean(row.registrationKey) &&
        cleanCellText(row.recipientName) === expectedRecipient &&
        row.printCount === 0,
    );
    const uniqueKeys = new Set(candidates.map((row) => row.registrationKey));
    const quantity = candidates.reduce(
      (total, row) => total + row.orderQuantity,
      0,
    );
    const exact =
      candidates.length === batch.cartonCount &&
      uniqueKeys.size === candidates.length &&
      quantity === batch.cartonCount &&
      candidates.every((row) => row.orderQuantity === 1);
    if (!exact) {
      throw new FulfillmentAdapterBlockedError(
        `저장된 예약행 키를 복구하지 못했습니다. 수하인 '${recipientName}'의 미출력 후보 ${candidates.length}개, 수량 ${quantity}/${batch.cartonCount}. 13단계를 다시 등록하지 마세요.`,
      );
    }
    return candidates;
  }

  private assertPrintableRegistrationRows(
    batch: LogenBatch,
    rows: LogenSingleOrderRow[],
    forceReprint: boolean,
  ): void {
    if (rows.length === 0) {
      throw new FulfillmentAdapterBlockedError(
        `로젠 배치 '${batch.fixTakeNo}'의 저장된 예약행과 일치하는 주문을 찾지 못했습니다. 13단계를 다시 등록하지 말고 실행 기록을 확인하세요.`,
      );
    }
    const quantity = rows.reduce((total, row) => total + row.orderQuantity, 0);
    if (quantity !== batch.cartonCount) {
      throw new FulfillmentAdapterBlockedError(
        `로젠 예약행 수량 ${quantity}개가 계획 카톤 ${batch.cartonCount}개와 일치하지 않습니다.`,
      );
    }
    const registrationKeys = rows.map((row) => row.registrationKey).filter(Boolean);
    if (
      rows.length !== batch.cartonCount ||
      registrationKeys.length !== batch.cartonCount ||
      new Set(registrationKeys).size !== batch.cartonCount ||
      rows.some((row) => row.orderQuantity !== 1)
    ) {
      throw new FulfillmentAdapterBlockedError(
        `로젠 예약행 ${rows.length}개가 계획 카톤 ${batch.cartonCount}개와 일대일로 일치하지 않습니다.`,
      );
    }
    const printed = rows.filter((row) => row.printCount >= 1).length;
    if (printed > 0 && printed < rows.length) {
      throw new FulfillmentAdapterBlockedError(
        "같은 로젠 배치에 출력·미출력 행이 함께 있어 자동 출력을 중단했습니다.",
      );
    }
    if (printed > 0 && !forceReprint) {
      throw new FulfillmentAdapterBlockedError(
        "이미 출력된 로젠 예약행입니다. 명시적인 완료 재실행에서만 재출력할 수 있습니다.",
      );
    }
  }

  private async selectRegistrationRows(
    page: Page | Frame,
    registrationKeys: string[],
  ): Promise<LogenSingleOrderRow[]> {
    const sheetName = requiredConfig(
      this.selectors.waybillSheetName,
      "로젠 단건 주문 IBSheet 이름",
    );
    const selected = await page.evaluate(
      ({ configuredSheetName, expectedKeys }) => {
        type SheetRow = Record<string, unknown> & { id?: string | number };
        type SheetApi = {
          getDataRows(): SheetRow[];
          getRowValue?(row: SheetRow): Record<string, unknown>;
          setValue(input: {
            row: SheetRow;
            col: string;
            val: number;
            render: number;
          }): void;
        };
        const scope = globalThis as unknown as Record<string, unknown>;
        const sheet = scope[configuredSheetName] as SheetApi | undefined;
        if (
          !sheet ||
          typeof sheet.getDataRows !== "function" ||
          typeof sheet.setValue !== "function"
        ) {
          throw new Error(`IBSheet '${configuredSheetName}' 선택 API를 찾지 못했습니다.`);
        }
        const rowKey = {
          text(value: unknown): string {
            if (value instanceof Date) return value.toISOString();
            return String(value ?? "").replace(/\s+/g, " ").trim();
          },
          keyPart(value: unknown): string {
            if (value instanceof Date) return String(value.getTime());
            return rowKey.text(value).replace(/[|\r\n]/g, "");
          },
          forRow(row: SheetRow): string {
            const value =
              (typeof sheet.getRowValue === "function" ? sheet.getRowValue(row) : row) ??
              row;
            const takeNo = rowKey.keyPart(value.takeNo ?? row.takeNo);
            const fixTakeNo = rowKey.keyPart(value.fixTakeNo ?? row.fixTakeNo);
            const takeDate = rowKey.keyPart(value.takeDt ?? row.takeDt);
            const sequence = rowKey.keyPart(value.seq ?? row.seq);
            const customerCode = rowKey.keyPart(value.fixcustCd ?? row.fixcustCd);
            return takeNo
              ? `takeNo:${takeNo}`
              : fixTakeNo
                ? `fixTakeNo:${fixTakeNo}`
                : takeDate && sequence && customerCode
                  ? `reservation:${takeDate}|${sequence}|${customerCode}`
                  : "";
          },
        };
        const expectedKeySet = new Set(expectedKeys);
        let selectedCount = 0;
        for (const row of sheet.getDataRows()) {
          const isTarget = expectedKeySet.has(rowKey.forRow(row));
          sheet.setValue({
            row,
            col: "CheckData",
            val: isTarget ? 1 : 0,
            render: 1,
          });
          if (isTarget) selectedCount += 1;
        }
        return selectedCount;
      },
      { configuredSheetName: sheetName, expectedKeys: registrationKeys },
    );
    if (selected === 0) {
      throw new FulfillmentAdapterBlockedError(
        `로젠 예약행 ${registrationKeys.length}개의 출력 선택란을 찾지 못했습니다.`,
      );
    }
    const registrationKeySet = new Set(registrationKeys);
    return (await this.readSingleOrderRows(page)).filter(
      (row) => registrationKeySet.has(row.registrationKey),
    );
  }

  private async waitForFinalPrintButton(
    page: Page,
    registrationSurface: Page | Frame,
  ): Promise<Locator> {
    const selector = requiredConfig(
      this.selectors.waybillFinalPrintButton,
      "로젠 출력창 운송장출력 버튼 셀렉터",
    );
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const roots: Array<Page | Frame> = [registrationSurface];
      for (const candidatePage of page.context().pages()) {
        roots.push(candidatePage);
        for (const frame of candidatePage.frames()) {
          if (frame !== candidatePage.mainFrame()) roots.push(frame);
        }
      }
      const visible: Locator[] = [];
      const visited = new Set<Page | Frame>();
      for (const root of roots) {
        if (visited.has(root)) continue;
        visited.add(root);
        const candidates = root.locator(selector);
        for (let index = 0; index < (await candidates.count()); index += 1) {
          const candidate = candidates.nth(index);
          if (await candidate.isVisible()) visible.push(candidate);
        }
      }
      if (visible.length > 1) {
        throw new FulfillmentAdapterBlockedError(
          `로젠 출력창 운송장출력 버튼이 ${visible.length}개 표시되어 자동 클릭하지 않았습니다.`,
        );
      }
      if (visible.length === 1) return visible[0];
      await page.waitForTimeout(250);
    }
    throw new FulfillmentAdapterBlockedError(
      "로젠 운송장 발행 창의 최종 운송장출력 버튼을 찾지 못했습니다.",
    );
  }

  async confirmLogenWebPrintPrompt(page: Page): Promise<void> {
    const dialogSelector = requiredConfig(
      this.selectors.waybillWebConfirmDialog,
      "로젠 웹 출력 확인창 셀렉터",
    );
    const yesButtonSelector = requiredConfig(
      this.selectors.waybillWebConfirmYesButton,
      "로젠 웹 출력 확인 예 버튼 셀렉터",
    );

    for (let attempt = 0; attempt < 60; attempt += 1) {
      const roots: Array<Page | Frame> = [];
      for (const candidatePage of page.context().pages()) {
        roots.push(candidatePage);
        for (const frame of candidatePage.frames()) {
          if (frame !== candidatePage.mainFrame()) roots.push(frame);
        }
      }

      const matches: Array<{ dialog: Locator; button: Locator }> = [];
      const visited = new Set<Page | Frame>();
      for (const root of roots) {
        if (visited.has(root)) continue;
        visited.add(root);
        const dialogs = root.locator(dialogSelector);
        for (let dialogIndex = 0; dialogIndex < (await dialogs.count()); dialogIndex += 1) {
          const dialog = dialogs.nth(dialogIndex);
          if (!(await dialog.isVisible())) continue;
          const text = (await dialog.innerText()).replace(/\s+/g, " ").trim();
          if (!text.includes("MSG000") || !text.includes("출력하시겠습니까")) continue;

          const buttons = dialog.locator(yesButtonSelector);
          for (let buttonIndex = 0; buttonIndex < (await buttons.count()); buttonIndex += 1) {
            const button = buttons.nth(buttonIndex);
            if (!(await button.isVisible()) || !(await button.isEnabled())) continue;
            if ((await button.innerText()).trim() !== "예") continue;
            matches.push({ dialog, button });
          }
        }
      }

      if (matches.length > 1) {
        throw new FulfillmentAdapterBlockedError(
          `로젠 웹 출력 확인창의 예 버튼이 ${matches.length}개 표시되어 자동 클릭하지 않았습니다.`,
        );
      }
      if (matches.length === 1) {
        await matches[0].button.click();
        await matches[0].dialog.waitFor({ state: "hidden", timeout: 10_000 });
        return;
      }
      await page.waitForTimeout(250);
    }

    throw new FulfillmentAdapterBlockedError(
      "로젠 웹 출력 확인창(MSG000)의 예 버튼을 찾지 못했습니다.",
    );
  }

  async dismissLogenWaybillLoadingPrompt(page: Page): Promise<boolean> {
    const dialogSelector = requiredConfig(
      this.selectors.waybillWebConfirmDialog,
      "로젠 웹 운송장 로딩 알림 셀렉터",
    );
    const confirmButtonSelector = requiredConfig(
      this.selectors.waybillLoadingConfirmButton,
      "로젠 웹 운송장 로딩 확인 버튼 셀렉터",
    );
    // The loading alert is transient. Do not hold Windows/OZ printer setup for
    // ten seconds when the alert never appears or has already disappeared.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await page.waitForTimeout(200);
      const matches: Array<{ dialog: Locator; button: Locator }> = [];
      const visited = new Set<Page | Frame>();

      for (const candidatePage of page.context().pages()) {
        const roots: Array<Page | Frame> = [candidatePage];
        for (const frame of candidatePage.frames()) {
          if (frame !== candidatePage.mainFrame()) roots.push(frame);
        }
        for (const root of roots) {
          if (visited.has(root)) continue;
          visited.add(root);
          const dialogs = root.locator(dialogSelector);
          for (let dialogIndex = 0; dialogIndex < (await dialogs.count()); dialogIndex += 1) {
            const dialog = dialogs.nth(dialogIndex);
            if (!(await dialog.isVisible())) continue;
            const text = (await dialog.innerText()).replace(/\s+/g, " ").trim();
            if (!text.includes("운송장을 불러오는 중입니다")) continue;

            const buttons = dialog.locator(confirmButtonSelector);
            for (let buttonIndex = 0; buttonIndex < (await buttons.count()); buttonIndex += 1) {
              const button = buttons.nth(buttonIndex);
              if (!(await button.isVisible()) || !(await button.isEnabled())) continue;
              if ((await button.innerText()).trim() !== "확인") continue;
              matches.push({ dialog, button });
            }
          }
        }
      }

      if (matches.length > 1) {
        throw new FulfillmentAdapterBlockedError(
          `로젠 운송장 로딩 알림의 확인 버튼이 ${matches.length}개 표시되어 자동 클릭하지 않았습니다.`,
        );
      }
      if (matches.length === 0) continue;

      await matches[0].button.click();
      await matches[0].dialog.waitFor({ state: "hidden", timeout: 10_000 });
      return true;
    }
    return false;
  }

  private async waitForWaybillNumberCandidates(
    page: Page | Frame,
    registrationKeys: string[],
    expectedCount: number,
  ): Promise<Array<{
    cartonIndex: number;
    originalSlipNo?: string;
    waybillNo?: string;
  }>> {
    let latest: Array<{
      cartonIndex: number;
      originalSlipNo?: string;
      waybillNo?: string;
    }> = [];
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const registrationKeySet = new Set(registrationKeys);
      const rows = (await this.readSingleOrderRows(page).catch(() => [])).filter(
        (row) => registrationKeySet.has(row.registrationKey),
      );
      const candidates: Array<{
        cartonIndex: number;
        originalSlipNo?: string;
        waybillNo?: string;
      }> = [];
      for (const row of rows) {
        const count = Math.max(
          row.originalSlipNos.length,
          row.waybillNos.length,
        );
        for (let index = 0; index < count; index += 1) {
          candidates.push({
            cartonIndex: candidates.length + 1,
            originalSlipNo: row.originalSlipNos[index],
            waybillNo: row.waybillNos[index],
          });
        }
      }
      latest = candidates.filter(
        (candidate) => candidate.originalSlipNo || candidate.waybillNo,
      );
      const preferred = latest
        .map((candidate) => candidate.waybillNo ?? candidate.originalSlipNo)
        .filter((value): value is string => Boolean(value));
      if (
        latest.length === expectedCount &&
        preferred.length === expectedCount &&
        new Set(preferred).size === expectedCount
      ) {
        return latest;
      }
      await page.waitForTimeout(250);
    }
    return latest;
  }

  private async readPrintPopupNumberCandidates(
    finalPrintButton: Locator,
  ): Promise<Array<{
    cartonIndex: number;
    originalSlipNo?: string;
    waybillNo?: string;
  }>> {
    const rows = await finalPrintButton
      .evaluate(() => {
        let data: unknown;
        try {
          data = eval("strDsList");
        } catch {
          return [];
        }
        if (!Array.isArray(data)) return [];
        return data.map((item) => {
          const row = item as Record<string, unknown>;
          return {
            originalSlipText: String(
              row.orgnSlipNo ?? row.orgSlipNo ?? "",
            ),
            waybillText: String(row.slipNo ?? row.newSlipNo ?? ""),
          };
        });
      })
      .catch(() => []);
    const candidates: Array<{
      cartonIndex: number;
      originalSlipNo?: string;
      waybillNo?: string;
    }> = [];
    for (const row of rows) {
      const originalSlipNos = extractLogenSlipNumbers(row.originalSlipText);
      const waybillNos = extractLogenSlipNumbers(row.waybillText);
      const count = Math.max(originalSlipNos.length, waybillNos.length);
      for (let index = 0; index < count; index += 1) {
        candidates.push({
          cartonIndex: candidates.length + 1,
          originalSlipNo: originalSlipNos[index],
          waybillNo: waybillNos[index],
        });
      }
    }
    return candidates.filter(
      (candidate) => candidate.originalSlipNo || candidate.waybillNo,
    );
  }

}

function extractLogenSlipNumbers(raw: string): string[] {
  return (raw.match(/\b\d{3}[- ]?\d{4}[- ]?\d{4}\b/g) ?? []).map((value) =>
    value.replace(/[^0-9]/g, ""),
  );
}

export function shipmentDocumentPlacement(input: {
  fileName: string;
  documentType?: "shipment_label" | "shipment_statement";
}): "actual" | "full_page" {
  if (input.documentType === "shipment_label") return "actual";
  if (input.documentType === "shipment_statement") return "full_page";
  const name = input.fileName.toLowerCase();
  if (name.includes("label") || name.includes("라벨")) return "actual";
  if (name.includes("manifest") || name.includes("statement") || name.includes("내역서")) {
    return "full_page";
  }
  throw new FulfillmentAdapterBlockedError(
    `쉽먼트 문서 종류를 판별할 수 없습니다: ${input.fileName}`,
  );
}

/** Routes order and shipment documents to the fixed SINDOH Windows printer. */
export class WindowsFulfillmentPrinterAdapter implements FulfillmentPrinterPort {
  private readonly excelPrintScript: string;
  private readonly shipmentPrintScript: string;
  private readonly pythonExecutable: string;
  private readonly timeoutMs: number;

  constructor(config: WindowsFulfillmentPrinterConfig = {}) {
    this.excelPrintScript =
      config.excelPrintScript ?? join(MODULE_ROOT, "scripts", "print-xlsx.ps1");
    this.shipmentPrintScript =
      config.shipmentPrintScript ??
      join(MODULE_ROOT, "scripts", "print-shipment-documents.py");
    this.pythonExecutable = config.pythonExecutable?.trim() || "python";
    this.timeoutMs = config.timeoutMs ?? DEFAULT_PRINT_TIMEOUT_MS;
  }

  async print(input: {
    files: Array<{
      fileName: string;
      filePath: string;
      documentType?: "shipment_label" | "shipment_statement";
    }>;
    printerName: string;
    copies: number;
    kind: "order" | "shipment";
  }): Promise<PrintSubmission> {
    if (input.printerName !== SINDOH_PRINTER_NAME) {
      return {
        success: false,
        status: "failed",
        submittedFiles: [],
        message: `${input.kind} 문서는 ${SINDOH_PRINTER_NAME} 프린터로만 보낼 수 있습니다.`,
      };
    }
    if (process.platform !== "win32") {
      return {
        success: false,
        status: "failed",
        submittedFiles: [],
        message: "실제 프린터 제출은 Windows에서만 지원합니다.",
      };
    }
    if (!Number.isInteger(input.copies) || input.copies < 1 || input.copies > 5) {
      return {
        success: false,
        status: "failed",
        submittedFiles: [],
        message: "인쇄 부수는 1~5 사이의 정수여야 합니다.",
      };
    }
    if (input.files.length === 0) {
      return {
        success: false,
        status: "failed",
        submittedFiles: [],
        message: "인쇄할 파일이 없습니다.",
      };
    }

    let printStarted = false;
    const attemptedFiles: string[] = [];
    try {
      for (const file of input.files) {
        if (file.filePath.startsWith("demo://")) {
          throw new FulfillmentAdapterBlockedError("데모 파일은 실제 프린터로 보낼 수 없습니다.");
        }
        if (!isAbsolute(file.filePath)) {
          throw new FulfillmentAdapterBlockedError(
            `인쇄 파일은 절대 경로여야 합니다: ${file.fileName}`,
          );
        }
        const info = await stat(file.filePath);
        if (!info.isFile()) {
          throw new FulfillmentAdapterBlockedError(
            `인쇄 대상이 파일이 아닙니다: ${file.fileName}`,
          );
        }
      }

      const excelFiles = input.files.filter((file) =>
        [".xls", ".xlsx", ".xlsm"].includes(extname(file.filePath).toLowerCase()),
      );
      const shellFiles = input.files.filter(
        (file) => !excelFiles.includes(file),
      );
      const unsupported = shellFiles.filter(
        (file) => ![".pdf", ".xps"].includes(extname(file.filePath).toLowerCase()),
      );
      if (unsupported.length > 0) {
        throw new FulfillmentAdapterBlockedError(
          `인쇄할 수 없는 파일 형식입니다: ${unsupported.map((file) => file.fileName).join(", ")}`,
        );
      }
      const submittedFiles: string[] = [];

      if (excelFiles.length > 0) {
        await access(this.excelPrintScript);
        printStarted = true;
        attemptedFiles.push(...excelFiles.map((file) => file.fileName));
        const result = await runExcelPrintScript(
          this.excelPrintScript,
          {
            files: excelFiles.map((file) => file.filePath),
            printerName: input.printerName,
            copies: input.copies,
            layout: input.kind === "order" ? "landscape_fit_one_page" : "preserve",
          },
          this.timeoutMs,
        );
        if (!result.success) throw new Error(result.message);
        submittedFiles.push(...excelFiles.map((file) => file.fileName));
      }

      if (shellFiles.length > 0) {
        if (input.kind === "shipment") {
          await access(this.shipmentPrintScript);
          const shipmentFiles = shellFiles.map((file) => ({
            fileName: file.fileName,
            filePath: file.filePath,
            placement: shipmentDocumentPlacement(file),
          }));
          printStarted = true;
          attemptedFiles.push(...shipmentFiles.map((file) => file.fileName));
          const result = await runShipmentPrintScript(
            this.shipmentPrintScript,
            this.pythonExecutable,
            {
              files: shipmentFiles,
              printerName: input.printerName,
              copies: input.copies,
            },
            this.timeoutMs,
          );
          if (!result.success) throw new Error(result.message);
          submittedFiles.push(...result.submittedFiles);
        } else {
          printStarted = true;
          attemptedFiles.push(...shellFiles.map((file) => file.fileName));
          await runWindowsPrintTo(
            {
              files: shellFiles.map((file) => file.filePath),
              printerName: input.printerName,
              copies: input.copies,
            },
            this.timeoutMs,
          );
          submittedFiles.push(...shellFiles.map((file) => file.fileName));
        }
      }

      return {
        success: true,
        status: "submitted",
        submittedFiles,
        message: `${input.printerName}에 ${submittedFiles.length}개 파일의 인쇄 요청을 제출했습니다.`,
      };
    } catch (error) {
      return {
        success: false,
        status: printStarted ? "unknown" : "failed",
        submittedFiles: printStarted ? [...new Set(attemptedFiles)] : [],
        message: printStarted
          ? `인쇄 요청 후 결과를 확인하지 못했습니다. 자동으로 다시 출력하지 마세요. ${errorMessage(error)}`
          : errorMessage(error),
      };
    }
  }
}

/** A typed blocked error lets orchestration distinguish calibration gaps from remote failures. */
export class FulfillmentAdapterBlockedError extends Error {
  readonly code = "FULFILLMENT_ADAPTER_BLOCKED";

  constructor(message: string) {
    super(message);
    this.name = "FulfillmentAdapterBlockedError";
  }
}

class PersistentChromeSession {
  private context?: BrowserContext;
  private page?: Page;
  private cdpBrowser?: Browser;
  private cdpProcess?: ChildProcess;

  constructor(
    private readonly profileDir: string,
    private readonly headless: boolean,
    private readonly connectionMode: "playwright" | "cdp" = "playwright",
    private readonly chromeExecutablePath?: string,
  ) {}

  async open(url: string): Promise<Page> {
    const page = await this.getPage();
    if (!sameOriginAndPath(page.url(), url)) {
      await page.goto(url, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(500);
    }
    return page;
  }

  async close(): Promise<void> {
    if (this.cdpBrowser) {
      await this.cdpBrowser.close().catch(() => undefined);
    } else {
      await this.context?.close();
    }
    if (this.cdpProcess && this.cdpProcess.exitCode === null) {
      this.cdpProcess.kill();
    }
    this.context = undefined;
    this.page = undefined;
    this.cdpBrowser = undefined;
    this.cdpProcess = undefined;
  }

  private async getPage(): Promise<Page> {
    if (!this.context) {
      await mkdir(this.profileDir, { recursive: true });
      if (this.connectionMode === "cdp") {
        await this.connectToNormallyLaunchedChrome();
      } else {
        this.context = await chromium.launchPersistentContext(this.profileDir, {
          channel: "chrome",
          headless: this.headless,
          acceptDownloads: true,
          viewport: { width: 1440, height: 960 },
        });
      }
      const context = this.context;
      if (!context) throw new Error("Chrome 브라우저 컨텍스트를 만들지 못했습니다.");
      context.on("close", () => {
        this.context = undefined;
        this.page = undefined;
      });
    }
    const context = this.context;
    if (!context) throw new Error("Chrome 브라우저 컨텍스트가 종료되었습니다.");
    if (!this.page || this.page.isClosed()) {
      this.page = context.pages()[0] ?? (await context.newPage());
    }
    return this.page;
  }

  private async connectToNormallyLaunchedChrome(): Promise<void> {
    const executable = resolveChromeExecutable(this.chromeExecutablePath);
    const port = await reserveLoopbackPort();
    const args = [
      `--remote-debugging-port=${port}`,
      "--remote-debugging-address=127.0.0.1",
      `--user-data-dir=${this.profileDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-mode",
      "--disable-session-crashed-bubble",
      "--hide-crash-restore-bubble",
    ];
    if (this.headless) args.push("--headless=new");
    this.cdpProcess = spawn(executable, args, {
      detached: false,
      stdio: "ignore",
      windowsHide: this.headless,
    });

    let lastError: unknown;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      if (this.cdpProcess.exitCode !== null) {
        throw new Error(
          `일반 Chrome이 원격 디버깅 연결 전에 종료되었습니다. 종료 코드: ${this.cdpProcess.exitCode}`,
        );
      }
      try {
        this.cdpBrowser = await chromium.connectOverCDP(
          `http://127.0.0.1:${port}`,
        );
        this.context = this.cdpBrowser.contexts()[0];
        if (!this.context) throw new Error("Chrome 기본 컨텍스트를 찾을 수 없습니다.");
        this.cdpBrowser.on("disconnected", () => {
          this.context = undefined;
          this.page = undefined;
          this.cdpBrowser = undefined;
          this.cdpProcess = undefined;
        });
        return;
      } catch (error) {
        lastError = error;
        await delay(250);
      }
    }
    this.cdpProcess.kill();
    throw new Error(
      `일반 Chrome CDP 연결을 시작하지 못했습니다: ${errorMessage(lastError)}`,
    );
  }
}

function sameOriginAndPath(currentUrl: string, targetUrl: string): boolean {
  try {
    const current = new URL(currentUrl);
    const target = new URL(targetUrl);
    return current.origin === target.origin && current.pathname === target.pathname;
  } catch {
    return false;
  }
}

async function reserveLoopbackPort(): Promise<number> {
  return await new Promise<number>((resolvePort, reject) => {
    const server = createNetServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Chrome CDP용 로컬 포트를 확보하지 못했습니다."));
        return;
      }
      const port = address.port;
      server.close((error) => (error ? reject(error) : resolvePort(port)));
    });
  });
}

function resolveChromeExecutable(configured?: string): string {
  const candidates = [
    configured,
    process.env.PROGRAMFILES
      ? join(process.env.PROGRAMFILES, "Google", "Chrome", "Application", "chrome.exe")
      : undefined,
    process.env["PROGRAMFILES(X86)"]
      ? join(
          process.env["PROGRAMFILES(X86)"],
          "Google",
          "Chrome",
          "Application",
          "chrome.exe",
        )
      : undefined,
    process.env.LOCALAPPDATA
      ? join(process.env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe")
      : undefined,
  ].filter((value): value is string => Boolean(value?.trim()));
  const executable = candidates.find((candidate) => existsSync(candidate));
  if (!executable) {
    throw new Error(
      "Google Chrome 실행 파일을 찾지 못했습니다. SUPPLIERHUB_CHROME_EXECUTABLE을 설정하세요.",
    );
  }
  return executable;
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function readSupplierOrders(
  page: Page,
  rowsSelector: string,
): Promise<FulfillmentOrder[]> {
  const rows = page.locator(rowsSelector);
  const results: FulfillmentOrder[] = [];
  const count = await rows.count();
  for (let rowIndex = 0; rowIndex < count; rowIndex += 1) {
    const rawCells = await rows.nth(rowIndex).locator("td").allTextContents();
    const cells = rawCells.map(cleanCellText);
    const orderIndex = cells.findIndex((cell) => /^\d{8,}$/.test(cell));
    if (orderIndex < 0) continue;
    const valueAt = (offset: number) => cells[orderIndex + offset] ?? "";
    const centerText = valueAt(11);
    const centerMatch = centerText.match(/^(.*?)\s*\(([^()]+)\)\s*$/);
    const dateCandidates = cells.filter((cell) =>
      /^\d{4}-\d{2}-\d{2}(?:\s|$)/.test(cell),
    );
    results.push({
      orderNo: valueAt(0),
      status: valueAt(3),
      createdAt: valueAt(4).replace(" ", "T"),
      transportType: valueAt(6),
      centerCode: cleanCellText(centerMatch?.[2] ?? centerText),
      centerName: cleanCellText(centerMatch?.[1] ?? centerText),
      expectedInboundDate:
        [...dateCandidates]
          .reverse()
          .find((value) => /^\d{4}-\d{2}-\d{2}$/.test(value)) ?? "",
      // The list screen does not expose a stable SKU-code column. Order-file
      // ingestion/master data fills items later instead of fabricating codes.
      items: [],
    });
  }
  return results;
}

function cleanCellText(value: string | null | undefined): string {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

async function visibleCount(locator: Locator): Promise<number> {
  const count = await locator.count();
  let visible = 0;
  for (let index = 0; index < count; index += 1) {
    if (await locator.nth(index).isVisible()) visible += 1;
  }
  return visible;
}

async function requireUniqueVisible(locator: Locator, label: string): Promise<Locator> {
  const count = await locator.count();
  const visible: Locator[] = [];
  for (let index = 0; index < count; index += 1) {
    const candidate = locator.nth(index);
    if (await candidate.isVisible()) visible.push(candidate);
  }
  if (visible.length !== 1) {
    throw new FulfillmentAdapterBlockedError(
      `${label}을(를) 하나로 식별하지 못했습니다. 표시된 후보: ${visible.length}개`,
    );
  }
  return visible[0];
}

async function locateFinalAgreementCheckbox(
  page: Page,
  configuredSelector: string,
): Promise<Locator> {
  const headingCandidates = page.getByText(/8\.\s*최종\s*동의/);
  await headingCandidates
    .first()
    .waitFor({ state: "visible", timeout: 5_000 })
    .catch(() => undefined);

  const configured = page.locator(configuredSelector);
  if ((await visibleCount(configured)) === 1) {
    return requireUniqueVisible(configured, "Supplier Hub 8. 최종 동의 선택란");
  }

  const visibleHeadings: Locator[] = [];
  for (let index = 0; index < (await headingCandidates.count()); index += 1) {
    const candidate = headingCandidates.nth(index);
    if (await candidate.isVisible()) visibleHeadings.push(candidate);
  }
  for (const heading of visibleHeadings) {
    const nearestAgreementCheckbox = heading.locator(
      "xpath=ancestor::*[.//input[@type='checkbox']][1]//input[@type='checkbox']",
    );
    if ((await visibleCount(nearestAgreementCheckbox)) === 1) {
      return requireUniqueVisible(
        nearestAgreementCheckbox,
        "Supplier Hub 8. 최종 동의 선택란",
      );
    }
  }

  const agreementTextCheckbox = page
    .getByText(/안내문을\s*확인하고.*동의/)
    .locator("xpath=ancestor::*[.//input[@type='checkbox']][1]//input[@type='checkbox']");
  if ((await visibleCount(agreementTextCheckbox)) === 1) {
    return requireUniqueVisible(
      agreementTextCheckbox,
      "Supplier Hub 8. 최종 동의 선택란",
    );
  }

  throw new FulfillmentAdapterBlockedError(
    "Supplier Hub 8. 최종 동의 영역에서 선택란을 찾지 못했습니다.",
  );
}

function requiredConfig(value: string | undefined, label: string): string {
  if (!value?.trim()) {
    throw new FulfillmentAdapterBlockedError(`${label} 설정이 필요합니다.`);
  }
  return value;
}

async function setControlValue(locator: Locator, value: string): Promise<void> {
  const tagName = await locator.evaluate((element) => element.tagName.toLowerCase());
  if (tagName === "select") {
    const selected = await locator.selectOption({ label: value }).catch(() => []);
    if (selected.length === 0) {
      const byValue = await locator.selectOption(value).catch(() => []);
      if (byValue.length === 0) {
        throw new FulfillmentAdapterBlockedError(`선택 항목 '${value}'을(를) 찾지 못했습니다.`);
      }
    }
    return;
  }
  await locator.fill(value);
}

async function saveRawDownload(
  download: Download,
  downloadsRoot: string,
  pathSegments: string[],
  filePrefix: string,
): Promise<{ fileName: string; filePath: string }> {
  const root = resolve(downloadsRoot);
  const safeSegments = pathSegments.map(sanitizePathSegment);
  const targetDir = resolve(root, ...safeSegments);
  assertPathInside(root, targetDir);
  await mkdir(targetDir, { recursive: true });

  const suggested = sanitizeFileName(download.suggestedFilename() || "download.bin");
  const prefix = sanitizePathSegment(filePrefix);
  const fileName = suggested.includes(prefix) ? suggested : `${prefix}-${suggested}`;
  const filePath = resolve(targetDir, fileName);
  assertPathInside(targetDir, filePath);
  await download.saveAs(filePath);
  return { fileName, filePath };
}

async function expandPrintableOrderFiles(input: {
  fileName: string;
  filePath: string;
}): Promise<Array<{ fileName: string; filePath: string }>> {
  if (extname(input.filePath).toLowerCase() !== ".zip") return [input];

  const targetDir = dirname(input.filePath);
  const zip = new AdmZip(input.filePath);
  const extracted: Array<{ fileName: string; filePath: string }> = [];
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue;
    const normalized = entry.entryName.replaceAll("\\", "/");
    if (normalized.startsWith("/") || normalized.split("/").includes("..")) {
      throw new FulfillmentAdapterBlockedError("ZIP 내부 경로가 다운로드 폴더 밖을 가리킵니다.");
    }
    if (extname(normalized).toLowerCase() !== ".xlsx") continue;
    const fileName = sanitizeFileName(basename(normalized));
    const filePath = resolve(targetDir, fileName);
    assertPathInside(targetDir, filePath);
    await writeFile(filePath, entry.getData());
    extracted.push({ fileName, filePath });
  }
  return extracted.length > 0 ? extracted : [input];
}

function sanitizePathSegment(value: string): string {
  const safe = value
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
    .replace(/^\.+$/, "_")
    .trim()
    .slice(0, 120);
  return safe || "_";
}

function sanitizeFileName(value: string): string {
  return sanitizePathSegment(value).slice(0, 180);
}

function assertPathInside(basePath: string, targetPath: string): void {
  const relation = relative(resolve(basePath), resolve(targetPath));
  if (relation.startsWith("..") || isAbsolute(relation)) {
    throw new FulfillmentAdapterBlockedError("다운로드 경로가 허용된 폴더 밖을 가리킵니다.");
  }
}

function shortHash(value: string, length: number): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, length);
}

function numericHash(value: string, length: number): string {
  const hex = createHash("sha256").update(value, "utf8").digest("hex").slice(0, 16);
  const modulus = 10n ** BigInt(length);
  return (BigInt(`0x${hex}`) % modulus).toString().padStart(length, "0");
}

function batchToShippingJob(batch: LogenBatch): ShippingJob {
  return {
    id: batch.id,
    runId: batch.runId,
    orderNo: batch.orderNo,
    skuCode: batch.skuCode,
    skuName: batch.skuName,
    cartonIndex: 0,
    // The Logen registration screen's quantity is the number of labels/cartons.
    shippedQuantity: batch.cartonCount,
    unitsPerCarton: batch.unitsPerCarton,
    fixTakeNo: batch.fixTakeNo,
    status: batch.status === "registered" ? "registered" : "ready",
  };
}

function isFrameSurface(surface: Page | Frame): surface is Frame {
  return typeof (surface as Frame).page === "function";
}

function isLoginUrl(url: string): boolean {
  return /(?:\/|^)(?:login|auth|sign-in|signin|sso)(?:\/|\?|#|$)/i.test(url);
}

function isSupplierHubDashboardUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.hostname.toLowerCase() === "supplier.coupang.com" &&
      parsed.pathname.toLowerCase().startsWith("/dashboard/")
    );
  } catch {
    return false;
  }
}


function isLogenWaybillPrinter(printerName: string): boolean {
  return printerName.trim().endsWith(LOGEN_WAYBILL_PRINTER_NAME);
}

interface ExcelPrintManifest {
  files: string[];
  printerName: string;
  copies: number;
  layout?: "preserve" | "landscape_fit_one_page";
}

interface ShipmentPrintManifest {
  files: Array<{
    fileName: string;
    filePath: string;
    placement: "actual" | "full_page";
  }>;
  printerName: string;
  copies: number;
}

async function runExcelPrintScript(
  scriptPath: string,
  manifest: ExcelPrintManifest,
  timeoutMs: number,
): Promise<PrintSubmission> {
  const manifestBase64 = Buffer.from(JSON.stringify(manifest), "utf8").toString("base64");
  const output = await spawnPowerShell(
    [
      "-File",
      scriptPath,
      "-ManifestBase64",
      manifestBase64,
    ],
    timeoutMs,
  );
  const parsed = JSON.parse(lastOutputLine(output) || "{}") as PrintSubmission;
  if (typeof parsed.success !== "boolean" || !Array.isArray(parsed.submittedFiles)) {
    throw new Error("Excel 인쇄 스크립트가 올바른 결과를 반환하지 않았습니다.");
  }
  return parsed;
}

async function runShipmentPrintScript(
  scriptPath: string,
  pythonExecutable: string,
  manifest: ShipmentPrintManifest,
  timeoutMs: number,
): Promise<PrintSubmission> {
  const manifestBase64 = Buffer.from(JSON.stringify(manifest), "utf8").toString("base64");
  const output = await spawnExecutable(
    pythonExecutable,
    [scriptPath, "--manifest-base64", manifestBase64],
    timeoutMs,
  );
  const parsed = JSON.parse(lastOutputLine(output) || "{}") as PrintSubmission;
  if (typeof parsed.success !== "boolean" || !Array.isArray(parsed.submittedFiles)) {
    throw new Error("쉽먼트 PDF 인쇄 스크립트가 올바른 결과를 반환하지 않았습니다.");
  }
  return parsed;
}

async function runWindowsPrintTo(
  manifest: ExcelPrintManifest,
  timeoutMs: number,
): Promise<void> {
  const script = String.raw`
$ErrorActionPreference = 'Stop'
$manifestJson = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:CODEX_FULFILLMENT_PRINT_MANIFEST))
$manifest = $manifestJson | ConvertFrom-Json
$null = Get-Printer -Name ([string]$manifest.printerName) -ErrorAction Stop
foreach ($file in @($manifest.files)) {
  if (-not (Test-Path -LiteralPath ([string]$file) -PathType Leaf)) { throw "Print file not found" }
  for ($copy = 0; $copy -lt [int]$manifest.copies; $copy += 1) {
    $process = Start-Process -FilePath ([string]$file) -Verb PrintTo -ArgumentList @('"' + [string]$manifest.printerName + '"') -PassThru -WindowStyle Hidden
    if (-not $process.WaitForExit(60000)) { $process.Kill(); throw "PrintTo handler timed out" }
    if ($process.ExitCode -ne 0) { throw "PrintTo handler failed" }
  }
}
Write-Output '{"success":true}'
`;
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  const manifestBase64 = Buffer.from(JSON.stringify(manifest), "utf8").toString("base64");
  await spawnPowerShell(["-EncodedCommand", encoded], timeoutMs, {
    CODEX_FULFILLMENT_PRINT_MANIFEST: manifestBase64,
  });
}

function spawnPowerShell(
  args: string[],
  timeoutMs: number,
  extraEnv: Record<string, string> = {},
): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        ...args,
      ],
      {
        shell: false,
        windowsHide: true,
        env: { ...process.env, ...extraEnv },
      },
    );
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeout = setTimeout(() => {
      settled = true;
      child.kill();
      rejectPromise(new Error(`인쇄 프로세스가 ${Math.ceil(timeoutMs / 1000)}초 안에 끝나지 않았습니다.`));
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      rejectPromise(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (code !== 0) {
        rejectPromise(new Error(stderr.trim() || `PowerShell 종료 코드: ${code}`));
        return;
      }
      resolvePromise(stdout);
    });
  });
}

function spawnExecutable(
  executable: string,
  args: string[],
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(executable, args, {
      shell: false,
      windowsHide: true,
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeout = setTimeout(() => {
      settled = true;
      child.kill();
      rejectPromise(
        new Error(`인쇄 프로세스가 ${Math.ceil(timeoutMs / 1000)}초 안에 끝나지 않았습니다.`),
      );
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      rejectPromise(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (code !== 0) {
        rejectPromise(new Error(stderr.trim() || `Python 종료 코드: ${code}`));
        return;
      }
      resolvePromise(stdout);
    });
  });
}

function lastOutputLine(output: string): string {
  return output.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
