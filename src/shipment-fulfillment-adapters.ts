import { spawn } from "node:child_process";
import { SingleFlight, rowSignature, waitForChangedRows, waitForTableIdle, waitForVisibleCandidates } from "./browser-readiness.js";
import { arrangeBrowserPage } from "./workspace-window-layout.js";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve } from "node:path";
import {
  chromium,
  type BrowserContext,
  type Locator,
  type Page,
} from "playwright-core";

export const LOGEN_CARRIER_LABEL = "로젠택배";
export const LOGEN_CARRIER_CODE = "D000002";
export const ALLLIVE_PRINTER_SUFFIX = "AllLive OLIVE-308B";
const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_POLL_TIMEOUT_MS = 120_000;

export type DateOnly = `${number}-${number}-${number}`;
export type ShipmentUploadStatus =
  | "prepared"
  | "completed"
  | "failed"
  | "processing"
  | "blocked"
  | "unknown";
export type ShipmentJobStatus = "completed" | "failed" | "processing" | "unknown";
export type ShipmentPdfType = "label" | "manifest";

export interface ShipmentUploadJob {
  fileName: string;
  status: ShipmentJobStatus;
  rawStatus: string;
  jobId?: string;
  createdAt?: string;
  message?: string;
}

export interface BulkShipmentUploadInput {
  workbookPath: string;
  expectedInboundDate: string | Date;
  shipDate?: string | Date;
  shipTime?: string;
  /** false이면 Summarize와 제출 버튼 활성화까지만 확인한다. */
  submit?: boolean;
}

export interface BulkShipmentUploadResult {
  status: ShipmentUploadStatus;
  fileName: string;
  expectedInboundDate: DateOnly;
  shipDate: DateOnly;
  shipTime: string;
  carrierLabel: typeof LOGEN_CARRIER_LABEL;
  carrierCode: typeof LOGEN_CARRIER_CODE;
  job?: ShipmentUploadJob;
  message: string;
}

export interface ShipmentReference {
  shipmentId: string;
  center: string;
  orderNo?: string;
}

export interface ShipmentPdfArtifact extends ShipmentReference {
  type: ShipmentPdfType;
  fileName: string;
  filePath: string;
}

export interface ShipmentPdfFailure extends ShipmentReference {
  type: ShipmentPdfType;
  message: string;
}

export interface ShipmentPdfDownloadInput {
  expectedInboundDate: string | Date;
  outputDir: string;
  orderNos?: string[];
  shipmentIds?: string[];
}

export interface ShipmentPdfDownloadResult {
  status: "completed" | "partial" | "failed" | "blocked";
  expectedInboundDate: DateOnly;
  shipments: ShipmentReference[];
  artifacts: ShipmentPdfArtifact[];
  failures: ShipmentPdfFailure[];
  message: string;
}

export interface AuthenticatedPdfRequest {
  type: ShipmentPdfType;
  urlTemplate: string;
  method?: "GET" | "POST";
  bodyTemplate?: string;
  contentType?: string;
}

export interface ShipmentFulfillmentSelectors {
  uploadReadyMarker: string;
  shipDateInput: string;
  shipTimeInput: string;
  carrierVisibleInput: string;
  carrierVisibleOption?: string;
  carrierHiddenInput: string;
  workbookInput: string;
  summarizeButton?: string;
  summarizeReadyMarker?: string;
  uploadSubmitButton: string;
  uploadSubmitConfirmation?: string;
  jobsReadyMarker: string;
  jobsRows: string;
  jobsFileName: string;
  jobsStatus: string;
  jobsId?: string;
  jobsCreatedAt?: string;
  jobsMessage?: string;
  jobsNewestFirst?: boolean;
  shipmentReadyMarker: string;
  inboundDateInput?: string;
  inboundDateFromInput?: string;
  inboundDateToInput?: string;
  shipmentSearchButton: string;
  shipmentRows: string;
  shipmentId: string;
  shipmentCenter: string;
  shipmentOrderNo?: string;
  shipmentExpectedInboundDate?: string;
  shipmentNextPageItem?: string;
  shipmentNextPageButton?: string;
}

export interface ShipmentFulfillmentBrowserConfig {
  profileDir: string;
  uploadUrl: string;
  jobsUrl?: string;
  shipmentListUrl: string;
  selectors: ShipmentFulfillmentSelectors;
  pdfRequests: readonly [AuthenticatedPdfRequest, AuthenticatedPdfRequest];
  headless?: boolean;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
  dateInputFormat?: "yyyy-MM-dd" | "yyyyMMdd";
  /** 실제 제출 후 jobs 조회와 쉽먼트 매핑까지 교정됐을 때만 true. */
  submissionReady?: boolean;
}

export interface ShipmentFulfillmentPort {
  uploadWorkbook(input: BulkShipmentUploadInput): Promise<BulkShipmentUploadResult>;
  inspectUploadJob(fileName: string): Promise<ShipmentUploadJob | undefined>;
  listShipments(
    expectedInboundDate: string | Date,
    orderNos?: string[],
  ): Promise<ShipmentReference[]>;
  downloadShipmentPdfs(
    input: ShipmentPdfDownloadInput,
  ): Promise<ShipmentPdfDownloadResult>;
  close(): Promise<void>;
}

/** Calendar dates EDD-3, EDD-2, and EDD-1, in ascending order. */
export function allowedShipDates(expectedInboundDate: string | Date): readonly [
  DateOnly,
  DateOnly,
  DateOnly,
] {
  const edd = parseDateOnly(expectedInboundDate, "입고예정일");
  return [addCalendarDays(edd, -3), addCalendarDays(edd, -2), addCalendarDays(edd, -1)];
}

/**
 * Chooses today when it is in the allowed EDD-3..EDD-1 window; otherwise it
 * clamps to the nearest edge of that window. Calendar days are used.
 */
export function chooseAutomaticShipDate(
  expectedInboundDate: string | Date,
  today: string | Date = new Date(),
): DateOnly {
  const allowed = allowedShipDates(expectedInboundDate);
  const current = parseDateOnly(today, "기준일");
  if (current < allowed[0]) return allowed[0];
  if (current > allowed[2]) return allowed[2];
  return current;
}

/** Resolve the exact installed printer name while preserving UNC host prefixes. */
export function resolveInstalledPrinterNameBySuffix(
  installedNames: readonly string[],
  suffix = ALLLIVE_PRINTER_SUFFIX,
): string {
  const normalizedSuffix = normalizePrinterName(suffix);
  if (!normalizedSuffix) throw new Error("프린터 접미사가 비어 있습니다.");

  const matches = [...new Set(installedNames.map((name) => name.trim()).filter(Boolean))]
    .filter((name) => normalizePrinterName(name).endsWith(normalizedSuffix));
  const exact = matches.filter((name) => normalizePrinterName(name) === normalizedSuffix);
  if (exact.length === 1) return exact[0];
  const shared = matches.filter((name) => /^\\\\/.test(name));
  if (shared.length === 1) return shared[0];
  if (matches.length === 1) return matches[0];
  if (matches.length === 0) {
    throw new Error(`설치된 프린터 중 '${suffix}'로 끝나는 이름을 찾지 못했습니다.`);
  }
  throw new Error(
    `설치된 프린터 이름이 '${suffix}' 접미사로 여러 개 일치합니다: ${matches.join(", ")}`,
  );
}

/** Discover Windows printers and return the exact shared AllLive printer name. */
export async function discoverInstalledPrinterNameBySuffix(
  suffix = ALLLIVE_PRINTER_SUFFIX,
): Promise<string> {
  if (process.platform !== "win32") {
    throw new Error("Windows 프린터 검색은 Windows에서만 지원합니다.");
  }
  const script =
    "@(Get-Printer | Select-Object -ExpandProperty Name) | ConvertTo-Json -Compress";
  const stdout = await runPowerShell(script, 20_000);
  const parsed = JSON.parse(lastOutputLine(stdout) || "[]") as string | string[];
  return resolveInstalledPrinterNameBySuffix(
    Array.isArray(parsed) ? parsed : [parsed],
    suffix,
  );
}

/**
 * Deep browser module for the Supplier Hub parcel-shipment workflow.
 * Credentials remain exclusively inside the persistent browser profile.
 */
export class SupplierHubShipmentFulfillmentAdapter
  implements ShipmentFulfillmentPort
{
  private readonly session: PersistentBrowserSession;
  private readonly pollIntervalMs: number;
  private readonly pollTimeoutMs: number;

  constructor(private readonly config: ShipmentFulfillmentBrowserConfig) {
    this.session = new PersistentBrowserSession(
      config.profileDir,
      config.headless ?? false,
    );
    this.pollIntervalMs = clampInteger(
      config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
      250,
      30_000,
      "작업 폴링 간격",
    );
    this.pollTimeoutMs = clampInteger(
      config.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS,
      1_000,
      30 * 60_000,
      "작업 폴링 제한시간",
    );
    const requestTypes = new Set(config.pdfRequests.map((request) => request.type));
    if (!requestTypes.has("label") || !requestTypes.has("manifest")) {
      throw new Error("PDF 요청 설정에는 label과 manifest가 각각 하나씩 필요합니다.");
    }
  }

  async uploadWorkbook(
    input: BulkShipmentUploadInput,
  ): Promise<BulkShipmentUploadResult> {
    const shipTime = normalizeShipTime(input.shipTime ?? "16:00");
    if (input.submit !== false && this.config.submissionReady !== true) {
      return {
        status: "blocked",
        fileName: basename(input.workbookPath),
        expectedInboundDate: parseDateOnly(input.expectedInboundDate, "입고예정일"),
        shipDate: input.shipDate
          ? parseDateOnly(input.shipDate, "출고일")
          : chooseAutomaticShipDate(input.expectedInboundDate),
        shipTime,
        carrierLabel: LOGEN_CARRIER_LABEL,
        carrierCode: LOGEN_CARRIER_CODE,
        message:
          "실제 등록에 필요한 업로드 작업목록과 쉽먼트 매핑 셀렉터가 아직 교정되지 않았습니다. 준비 테스트만 실행할 수 있습니다.",
      };
    }
    const expectedInboundDate = parseDateOnly(
      input.expectedInboundDate,
      "입고예정일",
    );
    const shipDate = input.shipDate
      ? parseDateOnly(input.shipDate, "출고일")
      : chooseAutomaticShipDate(expectedInboundDate);
    const allowed = allowedShipDates(expectedInboundDate);
    const fileName = basename(input.workbookPath);
    const common = {
      fileName,
      expectedInboundDate,
      shipDate,
      shipTime,
      carrierLabel: LOGEN_CARRIER_LABEL,
      carrierCode: LOGEN_CARRIER_CODE,
    } as const;

    if (!allowed.includes(shipDate)) {
      return {
        ...common,
        status: "blocked",
        message: `출고일은 입고예정일 기준 ${allowed.join(", ")} 중 하나여야 합니다.`,
      };
    }

    let submitClicked = false;
    try {
      await requireXlsxFile(input.workbookPath);
      const baseline =
        input.submit === false
          ? undefined
          : await this.readLatestSameFileJob(fileName, false);
      const page = await this.openShipmentRoute(this.config.uploadUrl);
      await this.requireAuthenticatedPage(
        page,
        this.config.selectors.uploadReadyMarker,
        this.config.selectors.workbookInput,
        "쉽먼트 일괄업로드",
      );

      await this.setDateControl(
        page,
        this.config.selectors.shipDateInput,
        shipDate,
        "출고일",
      );
      await this.setTextControl(
        page,
        this.config.selectors.shipTimeInput,
        shipTime,
        "발송시간",
      );
      await this.synchronizeLogenCarrier(page);
      const fileInput = await requireUniqueAttached(
        page.locator(this.config.selectors.workbookInput),
        "쉽먼트 XLSX 입력란",
      );
      await fileInput.setInputFiles(input.workbookPath);

      if (this.config.selectors.summarizeButton) {
        const summarize = await requireUniqueVisible(
          page.locator(this.config.selectors.summarizeButton),
          "Summarize 버튼",
        );
        await summarize.click();
      }
      if (this.config.selectors.summarizeReadyMarker) {
        await page.locator(this.config.selectors.summarizeReadyMarker).first().waitFor({
          state: "visible",
          timeout: 15_000,
        });
      }

      await page.locator(this.config.selectors.uploadSubmitButton).first().waitFor({
        state: "visible",
        timeout: 15_000,
      });
      const submit = await requireUniqueVisible(
        page.locator(this.config.selectors.uploadSubmitButton),
        "쉽먼트 일괄업로드 확인 버튼",
      );
      if (await submit.isDisabled()) {
        throw new ShipmentAdapterBlockedError(
          "Summarize 이후 일괄업로드 확인 버튼이 활성화되지 않았습니다.",
        );
      }
      if (input.submit === false) {
        return {
          ...common,
          status: "prepared",
          message:
            `발송일 ${shipDate} ${shipTime}로 쉽먼트 XLSX를 첨부하고 요약 화면과 업로드 버튼 활성화를 확인했습니다. 실제 업로드는 실행하지 않았습니다.`,
        };
      }
      submitClicked = true;
      await submit.click();
      if (this.config.selectors.uploadSubmitConfirmation) {
        await page
          .locator(this.config.selectors.uploadSubmitConfirmation)
          .first()
          .waitFor({ state: "visible", timeout: 15_000 });
      }

      const job = await this.pollLatestSameFileJob(fileName, baseline);
      if (!job) {
        return {
          ...common,
          status: "unknown",
          message:
            "업로드 버튼은 눌렀지만 동일 파일의 신규 작업을 jobs 목록에서 찾지 못했습니다. 자동으로 다시 업로드하지 마세요.",
        };
      }
      if (job.status === "completed") {
        return {
          ...common,
          status: "completed",
          job,
          message: "쉽먼트 일괄업로드 작업이 완료되었습니다.",
        };
      }
      if (job.status === "failed") {
        return {
          ...common,
          status: "failed",
          job,
          message: job.message || "쉽먼트 일괄업로드 작업이 실패했습니다.",
        };
      }
      return {
        ...common,
        status: job.status === "processing" ? "processing" : "unknown",
        job,
        message:
          job.status === "processing"
            ? "폴링 제한시간까지 쉽먼트 일괄업로드 작업이 처리 중입니다."
            : "쉽먼트 일괄업로드 작업 상태를 판정하지 못했습니다.",
      };
    } catch (error) {
      return {
        ...common,
        status: submitClicked
          ? "unknown"
          : error instanceof ShipmentAdapterBlockedError
            ? "blocked"
            : "failed",
        message: submitClicked
          ? `업로드 요청 후 결과를 확인하지 못했습니다. 자동으로 다시 업로드하지 마세요. ${errorMessage(error)}`
          : errorMessage(error),
      };
    }
  }

  async inspectUploadJob(fileName: string): Promise<ShipmentUploadJob | undefined> {
    return await this.readLatestSameFileJob(fileName, true);
  }

  async downloadShipmentPdfs(
    input: ShipmentPdfDownloadInput,
  ): Promise<ShipmentPdfDownloadResult> {
    const expectedInboundDate = parseDateOnly(
      input.expectedInboundDate,
      "입고예정일",
    );
    try {
      const info = await stat(resolve(input.outputDir)).catch(() => undefined);
      if (info && !info.isDirectory()) {
        throw new ShipmentAdapterBlockedError("PDF 저장 경로가 폴더가 아닙니다.");
      }
      await mkdir(resolve(input.outputDir), { recursive: true });
      const page = await this.openShipmentRoute(this.config.shipmentListUrl);
      await this.requireAuthenticatedPage(
        page,
        this.config.selectors.shipmentReadyMarker,
        this.config.selectors.shipmentSearchButton,
        "쉽먼트 목록",
      );
      await this.applyInboundDateSearch(page, expectedInboundDate);
      let shipments = await this.collectShipmentReferences(page, input.orderNos);
      if (input.shipmentIds?.length) {
        const requested = new Set(input.shipmentIds);
        shipments = shipments.filter((shipment) => requested.has(shipment.shipmentId));
      }
      if (shipments.length === 0) {
        return {
          status: "blocked",
          expectedInboundDate,
          shipments: [],
          artifacts: [],
          failures: [],
          message: "입고예정일과 일치하는 쉽먼트를 찾지 못했습니다.",
        };
      }

      const artifacts: ShipmentPdfArtifact[] = [];
      const failures: ShipmentPdfFailure[] = [];
      for (const shipment of shipments) {
        for (const request of this.config.pdfRequests) {
          try {
            const artifact = await this.fetchAndSavePdf(
              page,
              request,
              shipment,
              resolve(input.outputDir),
            );
            artifacts.push(artifact);
          } catch (error) {
            failures.push({
              ...shipment,
              type: request.type,
              message: errorMessage(error),
            });
          }
        }
      }

      const status =
        failures.length === 0
          ? "completed"
          : artifacts.length > 0
            ? "partial"
            : "failed";
      return {
        status,
        expectedInboundDate,
        shipments,
        artifacts,
        failures,
        message:
          status === "completed"
            ? `쉽먼트 ${shipments.length}건의 라벨·내역서 PDF를 저장했습니다.`
            : `PDF ${artifacts.length}개 저장, ${failures.length}개 실패`,
      };
    } catch (error) {
      return {
        status:
          error instanceof ShipmentAdapterBlockedError ? "blocked" : "failed",
        expectedInboundDate,
        shipments: [],
        artifacts: [],
        failures: [],
        message: errorMessage(error),
      };
    }
  }

  async listShipments(
    expectedInboundDateInput: string | Date,
    orderNos?: string[],
  ): Promise<ShipmentReference[]> {
    const expectedInboundDate = parseDateOnly(
      expectedInboundDateInput,
      "입고예정일",
    );
    const page = await this.openShipmentRoute(this.config.shipmentListUrl);
    await this.requireAuthenticatedPage(
      page,
      this.config.selectors.shipmentReadyMarker,
      this.config.selectors.shipmentSearchButton,
      "쉽먼트 목록",
    );
    await this.applyInboundDateSearch(page, expectedInboundDate);
    return await this.collectShipmentReferences(page, orderNos);
  }

  async close(): Promise<void> {
    await this.session.close();
  }

  private async synchronizeLogenCarrier(page: Page): Promise<void> {
    const visible = await requireUniqueVisible(
      page.locator(this.config.selectors.carrierVisibleInput),
      "택배사 표시 입력란",
    );
    if (this.config.selectors.carrierVisibleOption) {
      await visible.click();
      if (await visible.isEditable().catch(() => false)) {
        await visible.fill(LOGEN_CARRIER_LABEL);
      }
      const option = await requireUniqueVisible(
        page.locator(this.config.selectors.carrierVisibleOption),
        "로젠택배 표시 선택지",
      );
      await option.click();
    } else {
      await setVisibleControlValue(visible, LOGEN_CARRIER_LABEL);
    }

    const hidden = await requireUniqueAttached(
      page.locator(this.config.selectors.carrierHiddenInput),
      "택배사 코드 hidden 입력란",
    );
    await hidden.evaluate((element, value) => {
      if (element instanceof HTMLSelectElement) {
        const setter = Object.getOwnPropertyDescriptor(
          HTMLSelectElement.prototype,
          "value",
        )?.set;
        setter?.call(element, value);
      } else if (element instanceof HTMLInputElement) {
        const setter = Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          "value",
        )?.set;
        setter?.call(element, value);
      } else {
        throw new Error("Carrier code target is not an input or select element");
      }
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
    }, LOGEN_CARRIER_CODE);

    const visibleValue = await readVisibleControlValue(visible);
    const hiddenValue = await hidden.inputValue();
    if (!visibleValue.includes(LOGEN_CARRIER_LABEL) || hiddenValue !== LOGEN_CARRIER_CODE) {
      throw new ShipmentAdapterBlockedError(
        `택배사 표시값(${visibleValue})과 코드값(${hiddenValue})이 동기화되지 않았습니다.`,
      );
    }
  }

  private async setDateControl(
    page: Page,
    selector: string,
    date: DateOnly,
    label: string,
  ): Promise<void> {
    const input = await requireUniqueVisible(page.locator(selector), `${label} 입력란`);
    const formatted =
      this.config.dateInputFormat === "yyyyMMdd" ? date.replaceAll("-", "") : date;
    await input.fill(formatted);
    await input.dispatchEvent("change");
    if ((await input.inputValue()) !== formatted) {
      throw new ShipmentAdapterBlockedError(`${label} 입력값을 확인하지 못했습니다.`);
    }
  }

  private async setTextControl(
    page: Page,
    selector: string,
    value: string,
    label: string,
  ): Promise<void> {
    const input = await requireUniqueVisible(page.locator(selector), `${label} 입력란`);
    await input.fill(value);
    await input.dispatchEvent("input");
    await input.dispatchEvent("change");
    if ((await input.inputValue()).trim() !== value) {
      throw new ShipmentAdapterBlockedError(`${label} 입력값을 확인하지 못했습니다.`);
    }
  }

  private async readLatestSameFileJob(
    fileName: string,
    requirePage: boolean,
  ): Promise<ShipmentUploadJob | undefined> {
    try {
      const page = await this.openShipmentRoute(
        this.config.jobsUrl ?? this.config.uploadUrl,
      );
      await this.requireAuthenticatedPage(
        page,
        this.config.selectors.jobsReadyMarker,
        this.config.selectors.jobsRows,
        "쉽먼트 jobs 목록",
      );
      return latestSameFileJob(await this.readJobs(page), fileName);
    } catch (error) {
      if (requirePage) throw error;
      return undefined;
    }
  }

  private async pollLatestSameFileJob(
    fileName: string,
    baseline: ShipmentUploadJob | undefined,
  ): Promise<ShipmentUploadJob | undefined> {
    const startedAt = Date.now();
    let observed: ShipmentUploadJob | undefined;
    while (Date.now() - startedAt <= this.pollTimeoutMs) {
      const candidate = await this.readLatestSameFileJob(fileName, true);
      if (candidate && (observed || isDifferentJob(candidate, baseline))) {
        if (!observed || sameObservedJob(candidate, observed)) observed = candidate;
        if (observed.status === "completed" || observed.status === "failed") {
          return observed;
        }
      }
      await new Promise<void>((resolvePromise) =>
        setTimeout(resolvePromise, this.pollIntervalMs),
      );
    }
    return observed;
  }

  /**
   * Supplier Hub initializes parcel-shipment routes from the shipment list.
   * Opening a bulk route directly from a dashboard session can redirect back
   * to the dashboard, so prime the list before every upload/jobs route.
   */
  private async openShipmentRoute(targetUrl: string): Promise<Page> {
    const page = await this.session.open(this.config.shipmentListUrl);
    if (
      !isLoginUrl(page.url()) &&
      (await visibleCount(
        page.locator(this.config.selectors.shipmentReadyMarker),
      )) === 0
    ) {
      const directShipmentLink = page.locator('a[href^="/ibs/asn/active"]');
      if ((await visibleCount(directShipmentLink)) === 0) {
        const logisticsMenu = page.locator(
          'a[href="/logistics"], button:has-text("물류")',
        );
        const visibleMenus = await waitForVisibleCandidates(logisticsMenu, 5_000);
        if (visibleMenus[0]) await visibleMenus[0].click();
      }
      await waitForVisibleCandidates(directShipmentLink, 10_000);
      const shipmentLink = await requireUniqueVisible(
        directShipmentLink,
        "물류 메뉴의 쉽먼트 링크",
      );
      await shipmentLink.click();
      await waitForVisibleCandidates(
        page.locator(this.config.selectors.shipmentReadyMarker),
        15_000,
      );
    }
    await this.requireAuthenticatedPage(
      page,
      this.config.selectors.shipmentReadyMarker,
      this.config.selectors.shipmentSearchButton,
      "쉽먼트 목록",
    );
    if (!sameOriginAndPath(page.url(), targetUrl)) {
      await page.goto(targetUrl, { waitUntil: "domcontentloaded" });
    }
    return page;
  }

  private async readJobs(page: Page): Promise<ShipmentUploadJob[]> {
    const selectors = this.config.selectors;
    return await page.locator(selectors.jobsRows).evaluateAll(
      (rows, input) => {
        const text = (element: Element | null) =>
          String(element?.textContent ?? "").replace(/\s+/g, " ").trim();
        return rows.map((row) => ({
          fileName: text(row.querySelector(input.fileName)),
          rawStatus: text(row.querySelector(input.status)),
          jobId: input.id ? text(row.querySelector(input.id)) || undefined : undefined,
          createdAt: input.createdAt
            ? text(row.querySelector(input.createdAt)) || undefined
            : undefined,
          message: input.message
            ? text(row.querySelector(input.message)) || undefined
            : undefined,
        }));
      },
      {
        fileName: selectors.jobsFileName,
        status: selectors.jobsStatus,
        id: selectors.jobsId,
        createdAt: selectors.jobsCreatedAt,
        message: selectors.jobsMessage,
      },
    ).then((jobs) => {
      const normalized = jobs.map((job) => ({
        ...job,
        status: normalizeJobStatus(job.rawStatus),
      }));
      return selectors.jobsNewestFirst === false ? normalized.reverse() : normalized;
    });
  }

  private async applyInboundDateSearch(page: Page, date: DateOnly): Promise<void> {
    const selectors = this.config.selectors;
    if (selectors.inboundDateInput) {
      await this.setDateControl(page, selectors.inboundDateInput, date, "입고예정일");
    } else if (selectors.inboundDateFromInput && selectors.inboundDateToInput) {
      await this.setDateControl(page, selectors.inboundDateFromInput, date, "입고예정일 시작");
      await this.setDateControl(page, selectors.inboundDateToInput, date, "입고예정일 종료");
    } else {
      throw new ShipmentAdapterBlockedError(
        "입고예정일 단일 입력란 또는 시작·종료 입력란 셀렉터가 필요합니다.",
      );
    }
    const search = await requireUniqueVisible(
      page.locator(selectors.shipmentSearchButton),
      "쉽먼트 검색 버튼",
    );
    const rows = page.locator(selectors.shipmentRows);
    const previous = await rowSignature(rows);
    await search.click();
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      await waitForTableIdle(page);
      const current = await rowSignature(rows);
      const dates = selectors.shipmentExpectedInboundDate
        ? await rows.locator(selectors.shipmentExpectedInboundDate).allTextContents()
        : [];
      const normalizedDates = dates.map((value) => value.trim()).filter(Boolean);
      const settledForDate =
        normalizedDates.length > 0 &&
        normalizedDates.every((value) => value === date);
      if (settledForDate || (current !== previous && current !== "[]")) {
        await page.waitForTimeout(250);
        await waitForTableIdle(page);
        return;
      }
      await page.waitForTimeout(100);
    }
    throw new ShipmentAdapterBlockedError(
      `입고예정일 ${date} 검색 결과의 갱신을 확인하지 못했습니다.`,
    );
  }

  private async collectShipmentReferences(
    page: Page,
    orderNos?: string[],
  ): Promise<ShipmentReference[]> {
    const wanted = orderNos
      ? new Set(orderNos.map((orderNo) => orderNo.trim()).filter(Boolean))
      : undefined;
    if (wanted && !this.config.selectors.shipmentOrderNo) {
      throw new ShipmentAdapterBlockedError(
        "발주번호 필터를 사용하려면 쉽먼트 발주번호 셀렉터가 필요합니다.",
      );
    }

    const collected = new Map<string, ShipmentReference>();
    for (let pageIndex = 0; pageIndex < 50; pageIndex += 1) {
      const pageItems = await this.readShipmentPage(page);
      for (const shipment of pageItems) {
        if (wanted && (!shipment.orderNo || !wanted.has(shipment.orderNo))) continue;
        if (shipment.shipmentId && shipment.center) {
          collected.set(shipment.shipmentId, shipment);
        }
      }

      const nextItemSelector = this.config.selectors.shipmentNextPageItem;
      const nextButtonSelector = this.config.selectors.shipmentNextPageButton;
      if (!nextItemSelector || !nextButtonSelector) break;
      const nextItem = page.locator(nextItemSelector);
      if ((await nextItem.count()) !== 1) break;
      const classes = (await nextItem.getAttribute("class")) ?? "";
      const nextButton = nextItem.locator(nextButtonSelector);
      if (
        classes.includes("disabled") ||
        (await nextButton.count()) !== 1 ||
        (await nextButton.isDisabled())
      ) {
        break;
      }
      const rows = page.locator(this.config.selectors.shipmentRows);
      const previous = await rowSignature(rows);
      await nextButton.click();
      await waitForChangedRows(page, rows, previous);
    }
    return [...collected.values()];
  }

  private async readShipmentPage(page: Page): Promise<ShipmentReference[]> {
    const selectors = this.config.selectors;
    return await page.locator(selectors.shipmentRows).evaluateAll(
      (rows, input) => {
        const text = (element: Element | null) =>
          String(element?.textContent ?? "").replace(/\s+/g, " ").trim();
        return rows.map((row) => ({
          shipmentId: text(row.querySelector(input.shipmentId)),
          center: text(row.querySelector(input.center)),
          orderNo: input.orderNo
            ? text(row.querySelector(input.orderNo)) || undefined
            : undefined,
        }));
      },
      {
        shipmentId: selectors.shipmentId,
        center: selectors.shipmentCenter,
        orderNo: selectors.shipmentOrderNo,
      },
    );
  }

  private async fetchAndSavePdf(
    page: Page,
    request: AuthenticatedPdfRequest,
    shipment: ShipmentReference,
    outputDir: string,
  ): Promise<ShipmentPdfArtifact> {
    const values = {
      shipmentId: shipment.shipmentId,
      center: shipment.center,
      orderNo: shipment.orderNo ?? "",
    };
    const url = expandTemplate(request.urlTemplate, values, true);
    assertSameOrigin(page.url(), url);
    const body = request.bodyTemplate
      ? expandTemplate(request.bodyTemplate, values, false)
      : undefined;
    const fetched = await page.evaluate(
      async (input) => {
        const response = await fetch(input.url, {
          method: input.method,
          credentials: "include",
          headers: input.contentType
            ? { "Content-Type": input.contentType }
            : undefined,
          body: input.body,
        });
        const bytes = new Uint8Array(await response.arrayBuffer());
        let binary = "";
        const chunkSize = 0x8000;
        for (let offset = 0; offset < bytes.length; offset += chunkSize) {
          binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
        }
        return {
          ok: response.ok,
          status: response.status,
          contentType: response.headers.get("content-type") ?? "",
          base64: btoa(binary),
        };
      },
      {
        url,
        method: request.method ?? "GET",
        contentType: request.contentType,
        body,
      },
    );
    if (!fetched.ok) {
      throw new Error(`${request.type} PDF 요청이 HTTP ${fetched.status}로 실패했습니다.`);
    }
    const data = Buffer.from(fetched.base64, "base64");
    const appearsPdf =
      fetched.contentType.toLowerCase().includes("application/pdf") ||
      data.subarray(0, 5).toString("ascii") === "%PDF-";
    if (!appearsPdf || data.length === 0) {
      throw new Error(`${request.type} 응답이 PDF가 아닙니다.`);
    }

    const center = sanitizeFilePart(shipment.center);
    const shipmentId = sanitizeFilePart(shipment.shipmentId);
    const suffix = request.type === "label" ? "Label" : "내역서";
    const fileName = `${shipmentId}_${center}_${suffix}.pdf`;
    const filePath = resolve(outputDir, fileName);
    assertPathInside(outputDir, filePath);
    await writeFile(filePath, data);
    return { ...shipment, type: request.type, fileName, filePath };
  }

  private async requireAuthenticatedPage(
    page: Page,
    readyMarker: string | undefined,
    fallbackMarker: string,
    label: string,
  ): Promise<void> {
    const marker = readyMarker ?? fallbackMarker;
    if (!isLoginUrl(page.url())) await waitForVisibleCandidates(page.locator(marker), 15_000);
    if (isLoginUrl(page.url())) {
      throw new ShipmentAdapterBlockedError(
        `Supplier Hub 로그인이 필요합니다. 열린 전용 Chrome에서 로그인한 뒤 ${label}을 다시 실행하세요.`,
      );
    }
    const count = await visibleCount(page.locator(marker));
    if (count === 0) {
      const candidates = await page.locator("input, select, button").evaluateAll((elements) =>
        elements.slice(0, 30).map((element) => ({
          tag: element.tagName.toLowerCase(),
          id: element.id || undefined,
          name: element.getAttribute("name") || undefined,
          type: element.getAttribute("type") || undefined,
          aria: element.getAttribute("aria-label") || undefined,
          text: String(element.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 60) || undefined,
        })),
      );
      throw new ShipmentAdapterBlockedError(
        `${label} 화면을 확인하지 못했습니다. 현재 URL: ${page.url()}. ` +
          `입력 후보: ${JSON.stringify(candidates)}. 셀렉터 교정이 필요합니다.`,
      );
    }
  }
}

export class ShipmentAdapterBlockedError extends Error {
  readonly code = "SHIPMENT_ADAPTER_BLOCKED";

  constructor(message: string) {
    super(message);
    this.name = "ShipmentAdapterBlockedError";
  }
}

class PersistentBrowserSession {
  private readonly pageInitialization = new SingleFlight<Page>();
  private context?: BrowserContext;
  private page?: Page;

  constructor(
    private readonly profileDir: string,
    private readonly headless: boolean,
  ) {}

  async open(url: string): Promise<Page> {
    const page = await this.getPage();
    try {
      await page.goto(url, { waitUntil: "domcontentloaded" });
    } catch (error) {
      if (!String(error).includes("net::ERR_ABORTED")) throw error;
      await page.waitForLoadState("domcontentloaded", { timeout: 5_000 }).catch(() => undefined);
      if (!sameOriginAndPath(page.url(), url)) {
        await page.goto(url, { waitUntil: "domcontentloaded" });
      }
    }
    if (!this.headless) await arrangeBrowserPage(page).catch(() => undefined);
    return page;
  }

  async close(): Promise<void> {
    await this.context?.close();
    this.context = undefined;
    this.page = undefined;
  }

  private async getPage(): Promise<Page> {
    return this.pageInitialization.run(() => this.initializePage());
  }

  private async initializePage(): Promise<Page> {
    if (!this.context) {
      await mkdir(this.profileDir, { recursive: true });
      this.context = await chromium.launchPersistentContext(this.profileDir, {
        channel: "chrome",
        headless: this.headless,
        acceptDownloads: true,
        viewport: null,
      });
      this.context.on("close", () => {
        this.context = undefined;
        this.page = undefined;
      });
    }
    if (!this.page || this.page.isClosed()) {
      this.page = this.context.pages()[0] ?? (await this.context.newPage());
    }
    return this.page;
  }
}

function parseDateOnly(value: string | Date, label: string): DateOnly {
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) throw new Error(`${label}이 올바른 날짜가 아닙니다.`);
    return formatDateParts(value.getFullYear(), value.getMonth() + 1, value.getDate());
  }
  const match = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) throw new Error(`${label}은 YYYY-MM-DD 형식이어야 합니다.`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const candidate = new Date(Date.UTC(year, month - 1, day));
  if (
    candidate.getUTCFullYear() !== year ||
    candidate.getUTCMonth() !== month - 1 ||
    candidate.getUTCDate() !== day
  ) {
    throw new Error(`${label}이 올바른 날짜가 아닙니다.`);
  }
  return formatDateParts(year, month, day);
}

function normalizeShipTime(value: string): string {
  const normalized = value.trim();
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(normalized)) {
    throw new Error("발송시간은 HH:mm 형식이어야 합니다.");
  }
  return normalized;
}

function addCalendarDays(value: DateOnly, days: number): DateOnly {
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return formatDateParts(
    date.getUTCFullYear(),
    date.getUTCMonth() + 1,
    date.getUTCDate(),
  );
}

function formatDateParts(year: number, month: number, day: number): DateOnly {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}` as DateOnly;
}

async function requireXlsxFile(filePath: string): Promise<void> {
  if (!isAbsolute(filePath)) {
    throw new ShipmentAdapterBlockedError("업로드 XLSX는 절대 경로여야 합니다.");
  }
  if (!filePath.toLowerCase().endsWith(".xlsx")) {
    throw new ShipmentAdapterBlockedError("일괄업로드 파일 확장자는 .xlsx여야 합니다.");
  }
  const info = await stat(filePath);
  if (!info.isFile()) {
    throw new ShipmentAdapterBlockedError("일괄업로드 경로가 파일이 아닙니다.");
  }
}

function normalizeJobStatus(rawStatus: string): ShipmentJobStatus {
  const normalized = rawStatus.replace(/\s+/g, " ").trim().toLowerCase();
  if (/완료|성공|complete|completed|success|succeeded/.test(normalized)) {
    return "completed";
  }
  if (/실패|오류|에러|fail|failed|error|rejected/.test(normalized)) {
    return "failed";
  }
  if (/처리\s*중|진행\s*중|대기|업로드\s*중|processing|running|pending|queued|uploading/.test(normalized)) {
    return "processing";
  }
  return "unknown";
}

function latestSameFileJob(
  jobs: ShipmentUploadJob[],
  fileName: string,
): ShipmentUploadJob | undefined {
  const target = normalizeFileName(fileName);
  const matches = jobs.filter((job) => normalizeFileName(job.fileName) === target);
  return matches.sort(compareJobsNewestFirst)[0];
}

function compareJobsNewestFirst(a: ShipmentUploadJob, b: ShipmentUploadJob): number {
  const aTime = parseJobTime(a.createdAt);
  const bTime = parseJobTime(b.createdAt);
  if (aTime !== undefined && bTime !== undefined && aTime !== bTime) return bTime - aTime;
  return 0;
}

function parseJobTime(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value.replace(" ", "T"));
  return Number.isFinite(parsed) ? parsed : undefined;
}

function isDifferentJob(
  candidate: ShipmentUploadJob,
  baseline: ShipmentUploadJob | undefined,
): boolean {
  if (!baseline) return true;
  if (candidate.jobId && baseline.jobId) return candidate.jobId !== baseline.jobId;
  if (candidate.createdAt && baseline.createdAt) {
    return candidate.createdAt !== baseline.createdAt;
  }
  return (
    candidate.rawStatus !== baseline.rawStatus ||
    candidate.message !== baseline.message
  );
}

function sameObservedJob(
  candidate: ShipmentUploadJob,
  observed: ShipmentUploadJob,
): boolean {
  if (candidate.jobId && observed.jobId) return candidate.jobId === observed.jobId;
  if (candidate.createdAt && observed.createdAt) {
    return candidate.createdAt === observed.createdAt;
  }
  return normalizeFileName(candidate.fileName) === normalizeFileName(observed.fileName);
}

function normalizeFileName(value: string): string {
  return basename(value.trim()).normalize("NFC").toLocaleLowerCase("ko-KR");
}

async function requireUniqueVisible(locator: Locator, label: string): Promise<Locator> {
  const visible = await waitForVisibleCandidates(locator);
  if (visible.length !== 1) {
    throw new ShipmentAdapterBlockedError(
      `${label}을(를) 하나로 식별하지 못했습니다. 표시된 후보: ${visible.length}개`,
    );
  }
  return visible[0];
}

async function requireUniqueAttached(locator: Locator, label: string): Promise<Locator> {
  const count = await locator.count();
  if (count !== 1) {
    throw new ShipmentAdapterBlockedError(
      `${label}을(를) 하나로 식별하지 못했습니다. 후보: ${count}개`,
    );
  }
  return locator.first();
}

async function visibleCount(locator: Locator): Promise<number> {
  const count = await locator.count();
  let visible = 0;
  for (let index = 0; index < count; index += 1) {
    if (await locator.nth(index).isVisible()) visible += 1;
  }
  return visible;
}

async function setVisibleControlValue(locator: Locator, value: string): Promise<void> {
  const tagName = await locator.evaluate((element) => element.tagName.toLowerCase());
  if (tagName === "select") {
    const byLabel = await locator.selectOption({ label: value }).catch(() => []);
    if (byLabel.length === 0) {
      throw new ShipmentAdapterBlockedError(`택배사 선택 항목 '${value}'을(를) 찾지 못했습니다.`);
    }
    return;
  }
  if (tagName === "input" || tagName === "textarea") {
    await locator.fill(value);
    await locator.dispatchEvent("change");
    return;
  }
  throw new ShipmentAdapterBlockedError(
    "택배사 표시 셀렉터는 select 또는 입력 요소를 가리켜야 합니다.",
  );
}

async function readVisibleControlValue(locator: Locator): Promise<string> {
  const tagName = await locator.evaluate((element) => element.tagName.toLowerCase());
  if (tagName === "select") {
    return await locator.evaluate((element) => {
      const select = element as HTMLSelectElement;
      return select.selectedOptions[0]?.textContent?.trim() ?? "";
    });
  }
  if (tagName === "input" || tagName === "textarea") {
    return (await locator.inputValue()).trim();
  }
  return String(await locator.textContent()).replace(/\s+/g, " ").trim();
}

function expandTemplate(
  template: string,
  values: Record<string, string>,
  encode: boolean,
): string {
  return template.replace(/\{(shipmentId|center|orderNo)\}/g, (_match, key: string) => {
    const value = values[key] ?? "";
    return encode ? encodeURIComponent(value) : escapeJsonString(value);
  });
}

function escapeJsonString(value: string): string {
  return JSON.stringify(value).slice(1, -1);
}

function assertSameOrigin(pageUrl: string, requestUrl: string): void {
  const pageOrigin = new URL(pageUrl).origin;
  const requestOrigin = new URL(requestUrl, pageUrl).origin;
  if (pageOrigin !== requestOrigin) {
    throw new ShipmentAdapterBlockedError(
      "인증된 PDF 요청 URL은 현재 Supplier Hub 페이지와 같은 origin이어야 합니다.",
    );
  }
}

function sanitizeFilePart(value: string): string {
  const safe = value
    .normalize("NFC")
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
    .replace(/^\.+$/, "_")
    .trim()
    .slice(0, 100);
  return safe || "_";
}

function assertPathInside(basePath: string, targetPath: string): void {
  const relation = relative(resolve(basePath), resolve(targetPath));
  if (relation.startsWith("..") || isAbsolute(relation)) {
    throw new ShipmentAdapterBlockedError("PDF 저장 경로가 허용된 폴더 밖을 가리킵니다.");
  }
}

function normalizePrinterName(value: string): string {
  return value
    .normalize("NFC")
    .replaceAll("/", "\\")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase("en-US");
}

function clampInteger(value: number, min: number, max: number, label: string): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${label}은 ${min}~${max}ms 사이의 정수여야 합니다.`);
  }
  return value;
}

function isLoginUrl(url: string): boolean {
  return /(?:\/|^)(?:login|auth|sign-in|signin|sso)(?:\/|\?|#|$)/i.test(url);
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

function runPowerShell(script: string, timeoutMs: number): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    const encoded = Buffer.from(script, "utf16le").toString("base64");
    const child = spawn(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-EncodedCommand",
        encoded,
      ],
      { shell: false, windowsHide: true },
    );
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeout = setTimeout(() => {
      settled = true;
      child.kill();
      rejectPromise(new Error("Windows 프린터 검색 시간이 초과되었습니다."));
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

function lastOutputLine(value: string): string {
  return value.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
