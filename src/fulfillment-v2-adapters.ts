import { createHash } from "node:crypto";
import type {
  ParcelUploadSubmission,
  ShipmentDocumentResult,
  SupplierHubShipmentPort,
  SupplierHubShipmentSummary,
  SupplierHubShipmentUploadInput,
} from "./fulfillment-types.js";
import type {
  BulkShipmentUploadResult,
  ShipmentFulfillmentPort,
  ShipmentPdfArtifact,
} from "./shipment-fulfillment-adapters.js";

type ShipmentDocuments = ShipmentDocumentResult["documents"];

/** Maps the calibrated browser module onto the integrated-v2 shipment seam. */
export class LiveSupplierHubShipmentAdapter implements SupplierHubShipmentPort {
  constructor(private readonly delegate: ShipmentFulfillmentPort) {}

  async uploadTrackingWorkbook(
    input: SupplierHubShipmentUploadInput,
  ): Promise<ParcelUploadSubmission> {
    const result = await this.delegate.uploadWorkbook({
      workbookPath: input.filePath,
      expectedInboundDate: input.expectedInboundDate,
      shipDate: input.shipDate,
      shipTime: input.shipTime,
      submit: input.submit,
    });
    return mapLiveUploadResult(result);
  }

  async listShipmentSummaries(
    expectedInboundDate: string,
    orderNos?: string[],
  ): Promise<SupplierHubShipmentSummary[]> {
    const shipments = await this.delegate.listShipments(expectedInboundDate, orderNos);
    return shipments.map((shipment) => {
      if (!shipment.orderNo) {
        throw new Error(
          `쉽먼트 ${shipment.shipmentId}에서 발주번호를 확인하지 못했습니다.`,
        );
      }
      return {
        shipmentId: shipment.shipmentId,
        orderNo: shipment.orderNo,
        centerCode: shipment.center,
        expectedInboundDate,
      };
    });
  }

  async getShipmentDocuments(input: {
    shipmentId: string;
    centerCode: string;
    expectedInboundDate: string;
    outputDir: string;
  }): Promise<ShipmentDocuments> {
    const result = await this.delegate.downloadShipmentPdfs({
      expectedInboundDate: input.expectedInboundDate,
      outputDir: input.outputDir,
      shipmentIds: [input.shipmentId],
    });
    if (result.status !== "completed") {
      const details = result.failures.map((failure) => failure.message).join("; ");
      throw new Error(
        details || result.message || `쉽먼트 ${input.shipmentId} 문서를 모두 받지 못했습니다.`,
      );
    }

    const requested = result.artifacts.filter(
      (artifact) => artifact.shipmentId === input.shipmentId,
    );
    const documents = mapLiveDocuments(requested);
    if (
      !documents.some((document) => document.type === "shipment_label") ||
      !documents.some((document) => document.type === "shipment_statement")
    ) {
      throw new Error(`쉽먼트 ${input.shipmentId}의 라벨 또는 내역서가 누락되었습니다.`);
    }
    return documents;
  }

  async close(): Promise<void> {
    await this.delegate.close();
  }
}

interface DemoShipmentRecord extends SupplierHubShipmentSummary {
  key: string;
}

export interface DemoUploadRecord {
  input: SupplierHubShipmentUploadInput;
  submission: ParcelUploadSubmission;
}

/** Deterministic in-memory adapter for demo mode and interface-level tests. */
export class DemoSupplierHubShipmentAdapter implements SupplierHubShipmentPort {
  private readonly shipments = new Map<string, DemoShipmentRecord>();
  private readonly uploads: DemoUploadRecord[] = [];

  async uploadTrackingWorkbook(
    input: SupplierHubShipmentUploadInput,
  ): Promise<ParcelUploadSubmission> {
    const groups = uniqueShipmentGroups(input.shipmentGroups);
    if (input.submit === false) {
      const submission: ParcelUploadSubmission = {
        status: "prepared",
        message: `데모 쉽먼트 ${groups.length}개 그룹의 업로드 준비를 확인했습니다. 실제 등록은 실행하지 않았습니다.`,
      };
      this.uploads.push({
        input: structuredClone(input),
        submission: structuredClone(submission),
      });
      return structuredClone(submission);
    }
    for (const group of groups) {
      const key = shipmentGroupKey(
        group.orderNo,
        group.centerCode,
        group.expectedInboundDate,
      );
      this.shipments.set(key, {
        key,
        shipmentId: `DEMO-SHP-${shortHash(key, 12)}`,
        orderNo: group.orderNo,
        centerCode: group.centerCode,
        expectedInboundDate: group.expectedInboundDate,
      });
    }

    const uploadNumber = `DEMO-UP-${shortHash(
      [
        input.fileName,
        input.filePath,
        input.expectedInboundDate,
        input.shipDate,
        input.shipTime,
        ...groups.map((group) =>
          shipmentGroupKey(
            group.orderNo,
            group.centerCode,
            group.expectedInboundDate,
          ),
        ),
      ].join("|"),
      12,
    )}`;
    const submission: ParcelUploadSubmission = {
      status: "confirmed",
      uploadNumber,
      message: `데모 쉽먼트 ${groups.length}개 그룹의 업로드를 확인했습니다.`,
    };
    this.uploads.push({
      input: structuredClone(input),
      submission: structuredClone(submission),
    });
    return structuredClone(submission);
  }

  async listShipmentSummaries(
    expectedInboundDate: string,
    orderNos?: string[],
  ): Promise<SupplierHubShipmentSummary[]> {
    const wanted = orderNos ? new Set(orderNos) : undefined;
    return [...this.shipments.values()]
      .filter(
        (shipment) =>
          shipment.expectedInboundDate === expectedInboundDate &&
          (!wanted || wanted.has(shipment.orderNo)),
      )
      .sort((a, b) =>
        a.orderNo.localeCompare(b.orderNo, "ko-KR") ||
        a.centerCode.localeCompare(b.centerCode, "ko-KR") ||
        a.shipmentId.localeCompare(b.shipmentId),
      )
      .map(({ shipmentId, orderNo, centerCode, expectedInboundDate: edd }) => ({
        shipmentId,
        orderNo,
        centerCode,
        expectedInboundDate: edd,
      }));
  }

  async getShipmentDocuments(input: {
    shipmentId: string;
    centerCode: string;
    expectedInboundDate: string;
    outputDir: string;
  }): Promise<ShipmentDocuments> {
    const record = [...this.shipments.values()].find(
      (shipment) =>
        shipment.shipmentId === input.shipmentId &&
        shipment.centerCode === input.centerCode &&
        shipment.expectedInboundDate === input.expectedInboundDate,
    );
    if (!record) return [];

    const safeCenter = sanitizeDemoPart(input.centerCode);
    const safeShipment = sanitizeDemoPart(input.shipmentId);
    return [
      {
        type: "shipment_label",
        fileName: `${safeCenter}_${safeShipment}_label.pdf`,
        filePath: `demo://shipments/${safeShipment}/${safeCenter}_${safeShipment}_label.pdf`,
      },
      {
        type: "shipment_statement",
        fileName: `${safeCenter}_${safeShipment}_manifest.pdf`,
        filePath: `demo://shipments/${safeShipment}/${safeCenter}_${safeShipment}_manifest.pdf`,
      },
    ];
  }

  getUploadRecords(): DemoUploadRecord[] {
    return structuredClone(this.uploads);
  }

  async close(): Promise<void> {}
}

/** A safe adapter used until live shipment selectors/endpoints are calibrated. */
export class BlockedSupplierHubShipmentAdapter implements SupplierHubShipmentPort {
  constructor(
    readonly blockedReason =
      "Supplier Hub 쉽먼트 실연동 설정이 완료되지 않아 작업을 차단했습니다.",
  ) {}

  async uploadTrackingWorkbook(
    _input: SupplierHubShipmentUploadInput,
  ): Promise<ParcelUploadSubmission> {
    return {
      status: "failed",
      message: `[blocked] ${this.blockedReason}`,
    };
  }

  async listShipmentSummaries(
    _expectedInboundDate: string,
    _orderNos?: string[],
  ): Promise<SupplierHubShipmentSummary[]> {
    return [];
  }

  async getShipmentDocuments(_input: {
    shipmentId: string;
    centerCode: string;
    expectedInboundDate: string;
    outputDir: string;
  }): Promise<ShipmentDocuments> {
    return [];
  }

  async close(): Promise<void> {}
}

export type SupplierHubShipmentMode = "demo" | "live" | "blocked";
export type SupplierHubShipmentModeReader = () =>
  | SupplierHubShipmentMode
  | Promise<SupplierHubShipmentMode>;

/** Selects the demo, live, or explicitly blocked adapter for each call. */
export class ModeRoutedSupplierHubShipmentAdapter
  implements SupplierHubShipmentPort
{
  constructor(
    private readonly getMode: SupplierHubShipmentModeReader,
    private readonly demo: SupplierHubShipmentPort,
    private readonly live: SupplierHubShipmentPort,
    private readonly blocked: SupplierHubShipmentPort =
      new BlockedSupplierHubShipmentAdapter(),
  ) {}

  async uploadTrackingWorkbook(
    input: SupplierHubShipmentUploadInput,
  ): Promise<ParcelUploadSubmission> {
    return (await this.target()).uploadTrackingWorkbook(input);
  }

  async listShipmentSummaries(
    expectedInboundDate: string,
    orderNos?: string[],
  ): Promise<SupplierHubShipmentSummary[]> {
    return (await this.target()).listShipmentSummaries(
      expectedInboundDate,
      orderNos,
    );
  }

  async getShipmentDocuments(input: {
    shipmentId: string;
    centerCode: string;
    expectedInboundDate: string;
    outputDir: string;
  }): Promise<ShipmentDocuments> {
    return (await this.target()).getShipmentDocuments(input);
  }

  async close(): Promise<void> {
    const unique = [...new Set([this.demo, this.live, this.blocked])];
    await Promise.all(unique.map((adapter) => adapter.close?.()));
  }

  private async target(): Promise<SupplierHubShipmentPort> {
    switch (await this.getMode()) {
      case "demo":
        return this.demo;
      case "live":
        return this.live;
      case "blocked":
        return this.blocked;
      default:
        return this.blocked;
    }
  }
}

function mapLiveUploadResult(
  result: BulkShipmentUploadResult,
): ParcelUploadSubmission {
  const status: ParcelUploadSubmission["status"] =
    result.status === "prepared"
      ? "prepared"
      : result.status === "completed"
      ? "confirmed"
      : result.status === "failed" || result.status === "blocked"
        ? "failed"
        : "unknown";
  return {
    status,
    uploadNumber: result.job?.jobId,
    message: result.message,
  };
}

function mapLiveDocuments(artifacts: ShipmentPdfArtifact[]): ShipmentDocuments {
  const documents = new Map<ShipmentDocuments[number]["type"], ShipmentDocuments[number]>();
  for (const artifact of artifacts) {
    const type =
      artifact.type === "label" ? "shipment_label" : "shipment_statement";
    documents.set(type, {
      type,
      fileName: artifact.fileName,
      filePath: artifact.filePath,
    });
  }
  return [...documents.values()];
}

function uniqueShipmentGroups(
  groups: Array<{
    orderNo: string;
    centerCode: string;
    expectedInboundDate: string;
  }>,
): Array<{ orderNo: string; centerCode: string; expectedInboundDate: string }> {
  const unique = new Map<
    string,
    { orderNo: string; centerCode: string; expectedInboundDate: string }
  >();
  for (const group of groups) {
    unique.set(
      shipmentGroupKey(
        group.orderNo,
        group.centerCode,
        group.expectedInboundDate,
      ),
      structuredClone(group),
    );
  }
  return [...unique.values()];
}

function shipmentGroupKey(
  orderNo: string,
  centerCode: string,
  expectedInboundDate: string,
): string {
  return `${orderNo.trim().normalize("NFC")}|${centerCode
    .trim()
    .normalize("NFC")}|${expectedInboundDate.trim()}`;
}

function shortHash(value: string, length: number): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, length);
}

function sanitizeDemoPart(value: string): string {
  const safe = value
    .normalize("NFC")
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
    .replace(/^\.+$/, "_")
    .trim()
    .slice(0, 100);
  return safe || "_";
}
