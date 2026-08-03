import type { FulfillmentOrderQuery } from "./fulfillment-types.js";

export function normalizeFulfillmentOrderQuery(
  query: FulfillmentOrderQuery,
): FulfillmentOrderQuery {
  const dateSearchType = query.dateSearchType ?? "expected_inbound_date";
  const from = query.dateFrom?.trim() || undefined;
  const to = query.dateTo?.trim() || undefined;
  if ((from && !to) || (!from && to)) {
    throw new Error("입고예정일 시작일과 종료일을 모두 지정해야 합니다.");
  }
  if (from && to) {
    const label = dateSearchType === "order_date" ? "발주일" : "입고예정일";
    assertDateOnly(from, `${label} 시작일`);
    assertDateOnly(to, `${label} 종료일`);
    if (from > to) throw new Error(`${label} 시작일은 종료일보다 늦을 수 없습니다.`);
  }
  if (dateSearchType === "order_date" && (!from || !to)) {
    throw new Error("발주일 조회는 시작일과 종료일을 지정해야 합니다.");
  }
  return {
    lookAheadDays: query.lookAheadDays,
    dateSearchType,
    dateFrom: from,
    dateTo: to,
  };
}

export function fulfillmentOrderQueryLabel(query: FulfillmentOrderQuery): string {
  const label = query.dateSearchType === "order_date" ? "발주일" : "입고예정일";
  return query.dateFrom && query.dateTo
    ? `${query.dateFrom}~${query.dateTo} ${label}`
    : `다음 ${query.lookAheadDays}일`;
}

function assertDateOnly(value: string, label: string): void {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new Error(`${label}은 YYYY-MM-DD 형식이어야 합니다.`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    throw new Error(`${label}이 올바른 날짜가 아닙니다.`);
  }
}
