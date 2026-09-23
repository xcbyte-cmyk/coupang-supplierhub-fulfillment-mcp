import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { extname } from "node:path";
import type { FulfillmentArtifact, FulfillmentOrderItem, ProductMaster } from "./fulfillment-types.js";
import { extractCartonEvidence, parseCartonWorkbook, type CartonWorkbookEvidence, type CartonWorkbookSheet } from "./xlsx-order-reader.js";

export interface CartonOrderReview {
  runId: string;
  orderNo: string;
  skuCode: string;
  evidenceToken: string;
  unitsPerCarton: number;
  note: string;
  confirmedAt: string;
  method?: "manual" | "automatic";
}

export interface ConfirmCartonOrderReviewInput {
  runId: string;
  dataSource: "auto" | "backend" | "order_file";
  confirmed: boolean;
  reviews: Array<Pick<CartonOrderReview, "orderNo" | "skuCode" | "evidenceToken" | "unitsPerCarton" | "note">>;
}

interface OrderFileSnapshot {
  fingerprint: string;
  readable: boolean;
  sheets?: CartonWorkbookSheet[];
}

/** Per-call cache so one preview reads, hashes and unzips each order file only once. */
export type OrderFileCache = Map<string, OrderFileSnapshot>;

function readOrderFile(filePath: string): OrderFileSnapshot {
  let bytes: Buffer;
  try {
    bytes = readFileSync(filePath);
  } catch {
    return { fingerprint: "unavailable", readable: false };
  }
  const fingerprint = createHash("sha256").update(bytes).digest("hex");
  if (extname(filePath).toLowerCase() !== ".xlsx") return { fingerprint, readable: true };
  try {
    return { fingerprint, readable: true, sheets: parseCartonWorkbook(bytes) };
  } catch {
    // A corrupt workbook is still reviewable by hand because its bytes exist.
    return { fingerprint, readable: true };
  }
}

/** Always inspect the current bytes; an old item snapshot is not proof of the current PO's pack size. */
export function inspectCartonOrderFiles(
  artifacts: FulfillmentArtifact[], orderNo: string, skuCode: string, cache: OrderFileCache = new Map(),
) {
  const files = artifacts.filter(file => file.orderNo === orderNo && file.type === "order_file" && file.status === "downloaded")
    .sort((a, b) => a.id.localeCompare(b.id)).map(file => {
      const key = file.filePath ?? "";
      let snapshot = cache.get(key);
      if (!snapshot) {
        snapshot = file.filePath ? readOrderFile(file.filePath) : { fingerprint: "unavailable", readable: false };
        cache.set(key, snapshot);
      }
      const { fingerprint, readable } = snapshot;
      let entries: CartonWorkbookEvidence = { values: [], notes: [] };
      let message = "발주서 파일을 찾을 수 없습니다. 8단계에서 파일을 준비하세요.";
      if (readable) {
        message = "자동으로 읽지 못한 양식입니다. 파일을 열어 포장 기준과 확인 근거를 입력하세요.";
        if (snapshot.sheets) {
          entries = extractCartonEvidence(snapshot.sheets, orderNo, skuCode);
          message = entries.values.length ? "발주서에 명시된 입수수량을 찾았습니다." : "명시된 입수수량을 찾지 못했습니다. 포장 안내를 확인하고 근거를 입력하세요.";
        }
      }
      return { id: file.id, fileName: file.fileName, filePath: file.filePath, fingerprint, readable, ...entries, message };
    });
  const values = files.flatMap(file => file.values.map(value => ({ ...value, fileName: file.fileName })));
  const unique = [...new Set(values.map(value => value.unitsPerCarton))];
  return {
    files, values, unitsPerCarton: unique.length === 1 ? unique[0] : null,
    conflicting: unique.length > 1,
    available: files.length > 0 && files.every(file => file.readable),
  };
}

export function cartonEvidenceToken(input: {
  runId: string; orderNo: string; item: FulfillmentOrderItem; master?: ProductMaster;
  dataSource: string; evidence: ReturnType<typeof inspectCartonOrderFiles>;
}) {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

/** Deterministic auto-check. Ambiguous files and operator overrides remain exceptions. */
export function automaticCartonReview(input: {
  evidence: ReturnType<typeof inspectCartonOrderFiles>;
  masterUnits?: number;
  units?: number;
  quantity: number;
}): { eligible: boolean; reason: string } {
  const { evidence, masterUnits, units, quantity } = input;
  if (!evidence.available) return { eligible: false, reason: "발주서 파일을 먼저 준비하세요." };
  if (evidence.conflicting) return { eligible: false, reason: "발주서의 입수수량 값이 서로 다릅니다." };
  if (!evidence.unitsPerCarton || evidence.files.some(file => !file.values.length)) {
    return { eligible: false, reason: "발주서에서 명확한 입수수량을 찾지 못했습니다." };
  }
  if (masterUnits !== undefined && masterUnits !== evidence.unitsPerCarton) {
    return { eligible: false, reason: `발주서 ${evidence.unitsPerCarton}개입과 저장값 ${masterUnits}개입이 다릅니다.` };
  }
  if (units !== evidence.unitsPerCarton) return { eligible: false, reason: "이번 적용값이 발주서의 입수수량과 다릅니다." };
  if (!Number.isSafeInteger(quantity) || quantity <= 0 || quantity % units !== 0) {
    return { eligible: false, reason: "발주수량이 입수수량으로 나누어지지 않습니다." };
  }
  return { eligible: true, reason: `발주서 ${units}개입${masterUnits === undefined ? " · 저장값 없음" : " · 저장값 일치"} · ${quantity}개 ÷ ${units}개입 = ${quantity / units}카톤 자동 확인` };
}
