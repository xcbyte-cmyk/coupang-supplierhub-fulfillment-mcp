import { createHash } from "node:crypto";
import type {
  CoupangUploadJobStatus,
  FulfillmentCarton,
  FulfillmentOrder,
  LogenBatch,
  ShipmentGroup,
} from "./fulfillment-types.js";

export interface FulfillmentPlanInput {
  runId: string;
  orders: FulfillmentOrder[];
  now?: string;
}

export interface FulfillmentPlan {
  batches: LogenBatch[];
  cartons: FulfillmentCarton[];
  shipmentGroups: ShipmentGroup[];
}

/**
 * Build the deterministic PO+SKU -> carton -> one-shipment-per-PO plan.
 *
 * This is deliberately independent from XLSX structure and browser state. The
 * caller resolves master data before crossing this interface; this module only
 * applies the fulfillment rules and produces stable identifiers.
 */
export function planFulfillment(input: FulfillmentPlanInput): FulfillmentPlan {
  const at = input.now ?? new Date().toISOString();
  const batches: LogenBatch[] = [];
  const cartons: FulfillmentCarton[] = [];
  const runnableOrders = new Set<string>();

  for (const order of input.orders) {
    for (const item of order.items) {
      const orderedQuantity = positiveInteger(item.orderedQuantity) ?? 0;
      const unitsPerCarton = positiveInteger(item.unitsPerCarton) ?? 0;
      const divisible =
        orderedQuantity > 0 &&
        unitsPerCarton > 0 &&
        orderedQuantity % unitsPerCarton === 0;
      const cartonCount = divisible ? orderedQuantity / unitsPerCarton : 0;
      const batchId = deterministicId(
        "logen-batch",
        input.runId,
        order.orderNo,
        item.skuCode,
      );
      const batch: LogenBatch = {
        id: batchId,
        runId: input.runId,
        orderNo: order.orderNo,
        skuCode: item.skuCode,
        skuName: item.skuName,
        orderedQuantity,
        unitsPerCarton,
        cartonCount,
        fixTakeNo: createFixTakeNo(order.orderNo, item.skuCode),
        status: divisible ? "ready" : "blocked",
        waybillStatus: "not_started",
        message: divisible
          ? undefined
          : unitsPerCarton === 0
            ? "입수수량이 없습니다."
            : `주문수량 ${orderedQuantity}이 입수수량 ${unitsPerCarton}으로 나누어지지 않습니다.`,
        createdAt: at,
        updatedAt: at,
      };
      batches.push(batch);
      if (!divisible) continue;

      runnableOrders.add(order.orderNo);
      for (let cartonIndex = 1; cartonIndex <= cartonCount; cartonIndex += 1) {
        cartons.push({
          batchId,
          cartonIndex,
          quantity: unitsPerCarton,
          status: "ready",
          createdAt: at,
          updatedAt: at,
        });
      }
    }
  }

  const grouped = new Map<
    string,
    { orderNo: string; centerCode: string; expectedInboundDate: string }
  >();
  for (const order of input.orders) {
    if (!runnableOrders.has(order.orderNo)) continue;
    const key = `${order.orderNo}\u0000${order.centerCode}\u0000${order.expectedInboundDate}`;
    grouped.set(key, {
      orderNo: order.orderNo,
      centerCode: order.centerCode,
      expectedInboundDate: order.expectedInboundDate,
    });
  }

  const shipmentGroups: ShipmentGroup[] = [...grouped.values()].map((group) => ({
    id: `shipment-group-${sanitizeKey(group.orderNo)}-${shortHash(
      [
      input.runId,
      group.orderNo,
      group.centerCode,
      group.expectedInboundDate,
      ].join("|"),
    )}`,
    runId: input.runId,
    centerCode: group.centerCode,
    expectedInboundDate: group.expectedInboundDate,
    orderNos: [group.orderNo],
    status: "ready",
    createdAt: at,
    updatedAt: at,
  }));

  return { batches, cartons, shipmentGroups };
}

export function createFixTakeNo(orderNo: string, skuCode: string): string {
  const safeOrder = sanitizeKey(orderNo).slice(0, 60);
  const safeSku = sanitizeKey(skuCode).slice(0, 24);
  const hash = createHash("sha256")
    .update(`${orderNo}|${skuCode}`, "utf8")
    .digest("hex")
    .slice(0, 8);
  return `${safeOrder}-${safeSku}-${hash}`.slice(0, 100);
}

export function eligibleShipDates(edd: string): string[] {
  const parsed = parseIsoDate(edd);
  return [-3, -2, -1].map((offset) => addUtcDays(parsed, offset));
}

/** Select today only when Coupang accepts it; never backdate or future-date automatically. */
export function chooseAutomaticShipDate(edd: string, today: string): string | undefined {
  parseIsoDate(today);
  return eligibleShipDates(edd).includes(today) ? today : undefined;
}

export function assertStage11Ready(status: CoupangUploadJobStatus): void {
  if (status !== "confirmed") {
    throw new Error(
      `쉽먼트 일괄등록이 완료되지 않았습니다. 현재 업로드 상태: ${status}`,
    );
  }
}

function deterministicId(prefix: string, ...parts: string[]): string {
  return `${prefix}-${createHash("sha256")
    .update(parts.join("|"), "utf8")
    .digest("hex")
    .slice(0, 16)}`;
}

function shortHash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 16);
}

function positiveInteger(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : undefined;
}

function sanitizeKey(value: string): string {
  return (
    value.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") ||
    createHash("sha256").update(value, "utf8").digest("hex").slice(0, 8)
  );
}

function parseIsoDate(value: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`날짜는 YYYY-MM-DD 형식이어야 합니다: ${value}`);
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new Error(`유효하지 않은 날짜입니다: ${value}`);
  }
  return parsed;
}

function addUtcDays(date: Date, days: number): string {
  const next = new Date(date.valueOf());
  next.setUTCDate(next.getUTCDate() + days);
  return next.toISOString().slice(0, 10);
}
