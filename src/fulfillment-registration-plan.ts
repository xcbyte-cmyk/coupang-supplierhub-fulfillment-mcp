import type { FulfillmentDataSource, FulfillmentOrderItem, LogenBatch, ProductMaster } from "./fulfillment-types.js";

export function resolveCartonUnits(
  item: FulfillmentOrderItem,
  master: ProductMaster | undefined,
  dataSource: FulfillmentDataSource,
  allowDemo: boolean,
  refreshMaster = false,
): { units?: number; source: "backend" | "order_file" | "missing" } {
  const usableMaster = master?.source === "demo" && !allowDemo ? undefined : master;
  const backend = positiveCartonUnits(usableMaster?.unitsPerCarton);
  const file = positiveCartonUnits(item.unitsPerCarton);
  if (file && (refreshMaster || dataSource === "order_file")) return { units: file, source: "order_file" };
  if (dataSource !== "order_file" && backend) return { units: backend, source: "backend" };
  if (dataSource !== "backend" && file) return { units: file, source: "order_file" };
  return { source: "missing" };
}

export function positiveCartonUnits(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : undefined;
}

export function canReplanLogenBatch(batch: LogenBatch | undefined): boolean {
  if (!batch) return true;
  if (batch.logenOrderNo || batch.registrationKeys?.length || batch.registrationRecordedAt ||
      (batch.waybillStatus && batch.waybillStatus !== "not_started")) return false;
  if (["ready", "blocked"].includes(batch.status)) return true;
  return batch.status === "failed" && [
    "주문등록 제출 전 중단:", "로젠 로그인 완료 화면을 확인하지 못했습니다.",
    "로젠 로그인이 필요합니다.", "로젠 주문등록 URL", "셀렉터 설정이 필요합니다.",
  ].some(marker => batch.message?.includes(marker));
}

/** A suggestion is never used as an effective unit count or saved automatically. */
export function suggestCartonUnits(item: FulfillmentOrderItem, masters: ProductMaster[]) {
  const tokens = (name: string) => new Set(name.toUpperCase().split(/[\s_\-·/()]+/).filter(
    token => token.length > 1 && !["코멧", "FREE", "BPA"].includes(token),
  ));
  const wanted = tokens(item.skuName);
  if (wanted.size < 3) return undefined;
  const candidates = masters.filter(master => master.skuCode !== item.skuCode && master.source !== "demo")
    .map(master => ({ master, overlap: [...tokens(master.skuName)].filter(token => wanted.has(token)).length }))
    .filter(({ master, overlap }) => overlap >= 3 && overlap / wanted.size >= 0.6 &&
      positiveCartonUnits(master.unitsPerCarton) && item.orderedQuantity % master.unitsPerCarton === 0)
    .sort((left, right) => right.overlap - left.overlap || left.master.skuCode.localeCompare(right.master.skuCode));
  const best = candidates[0];
  if (!best) return undefined;
  const strongest = candidates.filter(candidate => candidate.overlap === best.overlap);
  if (new Set(strongest.map(candidate => candidate.master.unitsPerCarton)).size !== 1) return undefined;
  return {
    unitsPerCarton: best.master.unitsPerCarton,
    referenceSkuCode: best.master.skuCode,
    referenceSkuName: best.master.skuName,
    message: `유사 품목 ${best.master.skuCode}의 ${best.master.unitsPerCarton}개입 기준에서 추론한 후보입니다. 실제 포장 기준을 확인한 뒤 저장하세요.`,
  };
}
