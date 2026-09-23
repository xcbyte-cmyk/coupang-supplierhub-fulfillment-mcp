import type {
  CenterMaster,
  LogenAction,
  LogenBatch,
  LogenBatchPort,
  LogenBatchRegistrationResult,
  LogenBatchWaybillResult,
  LogenExecutionContext,
  LogenPort,
  LogenReadiness,
  LogenRegistrationResult,
  LogenWaybillResult,
  SenderProfile,
  ShippingJob,
} from "./fulfillment-types.js";

const TEST_BASE_URL = "https://topenapi.ilogen.com/lrm02b-edi/edi";
const LIVE_BASE_URL = "https://openapi.ilogen.com/lrm02b-edi/edi";

export interface LogenApiInvoicePrintPort {
  print(input: {
    popupUrl: string;
    secretKey: string;
    printerName: string;
    batches: LogenBatch[];
  }): Promise<{ success: boolean; status: "submitted" | "failed" | "unknown"; message: string }>;
  close?(): Promise<void>;
}

export interface LogenOpenApiConfig {
  environment: "test" | "live";
  userId?: string;
  customerCode?: string;
  secretKey?: string;
  fetchImpl?: typeof fetch;
  invoicePrint?: LogenApiInvoicePrintPort;
  now?: () => Date;
}

/**
 * Official Logen Open API adapter.
 *
 * Order registration and invoice-number lookup use JSON APIs. Physical output
 * remains behind an explicit invoice-popup port because the official print API
 * returns an interactive popup rather than a printable binary.
 */
export class LogenOpenApiAdapter implements LogenPort, LogenBatchPort {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;
  private readonly baseUrl: string;

  constructor(private readonly config: LogenOpenApiConfig) {
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.now = config.now ?? (() => new Date());
    this.baseUrl = config.environment === "live" ? LIVE_BASE_URL : TEST_BASE_URL;
  }

  getReadiness(action: LogenAction, _context: LogenExecutionContext): LogenReadiness {
    const missing: string[] = [];
    if (!this.config.userId?.trim()) missing.push("LOGEN_API_USER_ID");
    if (!this.config.customerCode?.trim()) missing.push("LOGEN_CUSTOMER_CODE");
    if (!this.config.secretKey?.trim()) missing.push("LOGEN_API_SECRET_KEY");
    if (missing.length > 0) {
      return { ready: false, message: `필수 API 설정이 없습니다: ${missing.join(", ")}` };
    }
    if (action === "print" && !this.config.invoicePrint) {
      return {
        ready: false,
        message:
          "로젠 API는 송장 파일 대신 외부 출력 팝업을 제공합니다. 팝업 MCP 셀렉터 교정이 필요합니다.",
      };
    }
    return {
      ready: true,
      message: `로젠 ${this.config.environment === "live" ? "운영" : "개발"} API가 준비되었습니다.`,
    };
  }

  async registerBatches(
    batches: LogenBatch[],
    sender: SenderProfile,
    centersByOrder: Record<string, CenterMaster>,
  ): Promise<LogenBatchRegistrationResult[]> {
    this.assertReady("register");
    if (batches.length === 0) return [];
    const takeDt = dateInSeoul(this.now()).replaceAll("-", "");
    const response = await this.post("registerOrderData", {
      userId: this.userId(),
      data: batches.map((batch) => {
        const center = centersByOrder[batch.orderNo];
        if (!center) throw new Error(`발주 ${batch.orderNo}의 센터 수취 정보가 없습니다.`);
        return {
          custCd: this.customerCode(),
          takeDt,
          slipNo: "",
          fixTakeNo: batch.fixTakeNo,
          sndCustNm: sender.name,
          sndZipCd: sender.postalCode ?? "",
          sndCustAddr: sender.address,
          sndTelNo: sender.telephone,
          sndCellNo: sender.mobile ?? "",
          rcvCustNm: center.recipientName,
          rcvZipCd: center.postalCode ?? "",
          rcvCustAddr: center.address,
          rcvTelNo: center.telephone,
          rcvCellNo: center.mobile ?? "",
          fareTy: sender.fareType,
          boxTyCd: sender.boxTypeCode ?? "",
          qty: batch.cartonCount,
          dlvFare: sender.deliveryFare,
          extraFare: 0,
          goodsNm: batch.skuName,
          inQty: batch.unitsPerCarton,
        };
      }),
    });
    const byFixTakeNo = new Map(
      arrayOfRecords(response.data).map((item) => [String(item.fixTakeNo ?? ""), item]),
    );
    return batches.map((batch) => {
      const item = byFixTakeNo.get(batch.fixTakeNo);
      const success = String(item?.resultCd ?? "").toUpperCase() === "TRUE";
      return {
        batchId: batch.id,
        fixTakeNo: batch.fixTakeNo,
        success,
        status: success ? "registered" : "failed",
        logenOrderNo: success ? batch.fixTakeNo : undefined,
        message: success
          ? "로젠 Open API 주문등록이 완료되었습니다."
          : String(item?.resultMsg ?? response.sttsMsg ?? "로젠 Open API 주문등록에 실패했습니다."),
      };
    });
  }

  async printBatchWaybills(
    batches: LogenBatch[],
    printerName: string,
  ): Promise<LogenBatchWaybillResult[]> {
    this.assertReady("print");
    if (batches.length === 0) return [];
    const takeDt = dateInSeoul(this.now()).replaceAll("-", "");
    const popupUrl = new URL(`${this.baseUrl}/outSlipPrintPop`);
    popupUrl.searchParams.set("userId", this.userId());
    popupUrl.searchParams.set("custCd", this.customerCode());
    popupUrl.searchParams.set("takeDt", takeDt);
    const submitted = await this.config.invoicePrint!.print({
      popupUrl: popupUrl.toString(),
      secretKey: this.secretKey(),
      printerName,
      batches,
    });
    if (!submitted.success) {
      return batches.map((batch) => ({
        batchId: batch.id,
        fixTakeNo: batch.fixTakeNo,
        slipNos: [],
        success: false,
        status: submitted.status,
        message: submitted.message,
      }));
    }

    const queried = await this.post("inquirySlipNoMulti", {
      userId: this.userId(),
      data: batches.map((batch) => ({
        custCd: this.customerCode(),
        fixTakeNo: batch.fixTakeNo,
      })),
    });
    const byFixTakeNo = new Map(
      arrayOfRecords(queried.data).map((item) => [String(item.fixTakeNo ?? ""), item]),
    );
    return batches.map((batch) => {
      const item = byFixTakeNo.get(batch.fixTakeNo);
      const slipNos = arrayOfRecords(item?.data1)
        .filter((slip) => String(slip.delYn ?? "N").toUpperCase() !== "Y")
        .map((slip) => String(slip.slipNo ?? "").trim())
        .filter(Boolean);
      const success = slipNos.length > 0;
      return {
        batchId: batch.id,
        fixTakeNo: batch.fixTakeNo,
        slipNos,
        numberCandidates: slipNos.map((waybillNo, index) => ({
          cartonIndex: index + 1,
          waybillNo,
        })),
        success,
        status: success ? "submitted" : "unknown",
        message: success
          ? `로젠 API에서 송장번호 ${slipNos.length}개를 조회했습니다.`
          : String(item?.resultMsg ?? queried.sttsMsg ?? "출력 송장번호를 아직 조회하지 못했습니다."),
      };
    });
  }

  /**
   * Resolve Logen's interactive test-print surface without returning the
   * configured secret key to the dashboard. The caller must redirect the
   * browser immediately; persisting this URL would expose the key in local
   * application state.
   */
  async getTestInvoicePrintPopupUrl(): Promise<string> {
    if (this.config.environment !== "test") {
      throw new Error("개발계 로젠 시험 출력 팝업은 TEST 환경에서만 열 수 있습니다.");
    }
    this.assertReady("register");
    const popupUrl = new URL(`${this.baseUrl}/outSlipPrintPop`);
    popupUrl.searchParams.set("userId", this.userId());
    popupUrl.searchParams.set("custCd", this.customerCode());
    popupUrl.searchParams.set("takeDt", dateInSeoul(this.now()).replaceAll("-", ""));
    const response = await this.fetchImpl(popupUrl, {
      headers: { secretKey: this.secretKey() },
    });
    if (!response.ok) {
      throw new Error(`로젠 개발계 출력 팝업 준비가 HTTP ${response.status}로 실패했습니다.`);
    }
    const html = await response.text();
    const match = html.match(/window\.open\(\s*["']([^"']+)["']/i);
    if (!match?.[1]) throw new Error("로젠 개발계 출력 팝업 주소를 확인하지 못했습니다.");
    const resolved = new URL(match[1], popupUrl);
    if (resolved.protocol !== "https:" || resolved.hostname !== "topenapi.ilogen.com") {
      throw new Error("로젠 개발계 출력 팝업 주소가 예상한 개발계 도메인이 아닙니다.");
    }
    return resolved.toString();
  }

  async registerOrders(
    jobs: ShippingJob[],
    sender: SenderProfile,
    centers: CenterMaster[],
  ): Promise<LogenRegistrationResult[]> {
    const center = centers[0];
    const batches = jobs.map((job) => jobToBatch(job));
    const results = await this.registerBatches(
      batches,
      sender,
      Object.fromEntries([...new Set(jobs.map((job) => job.orderNo))].map((orderNo) => [orderNo, center])),
    );
    return results.map((result, index) => ({
      shippingJobId: jobs[index].id,
      fixTakeNo: result.fixTakeNo,
      success: result.success,
      message: result.message,
    }));
  }

  async printWaybills(
    jobs: ShippingJob[],
    printerName: string,
  ): Promise<LogenWaybillResult[]> {
    const results = await this.printBatchWaybills(jobs.map(jobToBatch), printerName);
    return results.map((result, index) => ({
      shippingJobId: jobs[index].id,
      fixTakeNo: result.fixTakeNo,
      slipNo: result.slipNos[0],
      success: result.success,
      status: result.status,
      message: result.message,
    }));
  }

  async close(): Promise<void> {
    await this.config.invoicePrint?.close?.();
  }

  private async post(path: string, payload: unknown): Promise<Record<string, unknown>> {
    const response = await this.fetchImpl(`${this.baseUrl}/${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        secretKey: this.secretKey(),
      },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      throw new Error(`로젠 Open API ${path} 호출이 HTTP ${response.status}로 실패했습니다.`);
    }
    const parsed = (await response.json()) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`로젠 Open API ${path} 응답이 JSON 객체가 아닙니다.`);
    }
    return parsed as Record<string, unknown>;
  }

  private assertReady(action: LogenAction): void {
    const readiness = this.getReadiness(action, { integrationMethod: "api" });
    if (!readiness.ready) throw new Error(readiness.message);
  }

  private userId(): string {
    return this.config.userId!.trim();
  }

  private customerCode(): string {
    return this.config.customerCode!.trim();
  }

  private secretKey(): string {
    return this.config.secretKey!.trim();
  }
}

function arrayOfRecords(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter(
        (item): item is Record<string, unknown> =>
          Boolean(item) && typeof item === "object" && !Array.isArray(item),
      )
    : [];
}

function dateInSeoul(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = new Map(parts.map((part) => [part.type, part.value]));
  return `${values.get("year")}-${values.get("month")}-${values.get("day")}`;
}

function jobToBatch(job: ShippingJob): LogenBatch {
  const at = new Date().toISOString();
  return {
    id: job.id,
    runId: job.runId,
    orderNo: job.orderNo,
    skuCode: job.skuCode,
    skuName: job.skuName,
    orderedQuantity: job.shippedQuantity,
    unitsPerCarton: job.unitsPerCarton,
    cartonCount: 1,
    fixTakeNo: job.fixTakeNo,
    status: "ready",
    createdAt: at,
    updatedAt: at,
  };
}
