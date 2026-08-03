import { describe, expect, it } from "vitest";

import { FulfillmentStore } from "../src/fulfillment-store.js";
import type { FulfillmentOrder, LogenBatch } from "../src/fulfillment-types.js";

const AT = "2026-08-03T00:00:00.000Z";

describe("Logen multiple reservation rows", () => {
  it("persists all website reservation keys in carton order", () => {
    const store = new FulfillmentStore(":memory:");
    try {
      const order: FulfillmentOrder = {
        orderNo: "137209097",
        centerCode: "FC-1",
        centerName: "동탄1",
        status: "발주확정",
        transportType: "쉽먼트",
        createdAt: AT,
        expectedInboundDate: "2026-08-03",
        items: [],
      };
      const scan = store.saveScan([order], 7, AT);
      store.compareAndRecordNewOrders(scan.id, AT);
      const run = store.createRun(scan.id, undefined, AT);
      const registrationKeys = [
        "reservation:1785682800000|15|99999999",
        "reservation:1785682800000|16|99999999",
      ];
      const batch: LogenBatch = {
        id: "batch-1",
        runId: run.id,
        orderNo: order.orderNo,
        skuCode: "44133530",
        skuName: "상품",
        orderedQuantity: 100,
        unitsPerCarton: 50,
        cartonCount: 2,
        fixTakeNo: "137209097-44133530",
        status: "registered",
        logenOrderNo: registrationKeys[0],
        registrationKeys,
        createdAt: AT,
        updatedAt: AT,
      };

      store.saveLogenBatches([batch]);

      expect(store.getLogenBatch(batch.id)?.registrationKeys).toEqual(
        registrationKeys,
      );
    } finally {
      store.close();
    }
  });
});
