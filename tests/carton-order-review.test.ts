import { afterEach, describe, expect, it, vi } from "vitest";
import { unlinkSync } from "node:fs";
import { cartonReviewFixture } from "./helpers/carton-review-fixture.js";
import { readCartonWorkbookEvidence } from "../src/xlsx-order-reader.js";
import { createOrderFileOpener } from "../src/confirmation-file-opener.js";
import { createFulfillmentToolHandlers } from "../src/server-tool-handlers.js";

const fixtures: ReturnType<typeof cartonReviewFixture>[] = [];
const fixture = (units: number | null = 50) => { const h = cartonReviewFixture(units); fixtures.push(h); return h; };
afterEach(() => { for (const h of fixtures.splice(0)) h.close(); });

describe("automatic PO carton review with manual exceptions", () => {
  it("reads explicit units and their sheet/cell, never treats total shipped quantity as pack size", async () => {
    const h = fixture();
    expect(readCartonWorkbookEvidence(h.bytes(), h.order.orderNo, "TEST-SKU")).toMatchObject({
      values: [{ unitsPerCarton: 50, location: "발주서!D2" }], notes: [{ location: "발주서!A3" }],
    });
    h.writeWorkbook(200, "출고수량");
    const plan = await h.workflow.previewLogenRegistration(h.input);
    expect(plan.rows[0]).toMatchObject({ fileUnitsPerCarton: null, unitsPerCarton: null, reviewNeedsReason: true });
  });

  it("automatically passes explicit pack sizes without check/save and records the source only on registration", async () => {
    const h = fixture();
    const submit = vi.spyOn(h.logen, "registerBatches");
    const automatic = await h.workflow.previewLogenRegistration(h.input);
    expect(automatic).toMatchObject({ ready: true, readOnly: true, pendingCartonCount: 4 });
    expect(automatic.rows[0]).toMatchObject({ cartonReviewMode: "automatic", cartonReviewConfirmed: true });
    expect(h.store.getCartonOrderReview(h.run.id, h.order.orderNo, "TEST-SKU")).toBeUndefined();
    expect((await h.workflow.registerLogenDeliveryOrder({ ...h.input, reviewToken: "forged" })).status).toBe("blocked");
    expect(submit).not.toHaveBeenCalled();
    expect((await h.workflow.registerLogenDeliveryOrder({ ...h.input, reviewToken: automatic.reviewToken })).status).toBe("completed");
    expect(h.store.getCartonOrderReview(h.run.id, h.order.orderNo, "TEST-SKU")).toMatchObject({ method: "automatic", unitsPerCarton: 50 });
    expect(submit).toHaveBeenCalledTimes(1);
    await h.workflow.registerLogenDeliveryOrder(h.input);
    expect(submit).toHaveBeenCalledTimes(1);
    expect(h.store.getProductMaster("TEST-SKU")).toMatchObject({ unitsPerCarton: 50, source: "order_file" });
    h.writeWorkbook(25);
    expect((await h.workflow.previewLogenRegistration(h.input)).rows[0]).toMatchObject({ cartonReviewMode: "registered", unitsPerCarton: 50 });
  });

  it("requires a reason for missing or conflicting pack sizes and saves this PO's chosen units", async () => {
    const h = fixture();
    h.store.upsertProductMaster({ skuCode: "TEST-SKU", skuName: "예시", unitsPerCarton: 40, source: "backend", updatedAt: "2026-09-15" });
    expect((await h.workflow.previewLogenRegistration(h.input)).rows[0]).toMatchObject({ unitsPerCarton: 50, masterUnitsPerCarton: 40 });
    expect((await h.workflow.registerLogenDeliveryOrder(h.input)).status).toBe("blocked");
    await expect(h.confirm()).rejects.toThrow("근거");
    expect((await h.confirm(50, "발주서 D2와 실물 50개입 확인")).ready).toBe(true);
    h.writeWorkbook(null);
    await expect(h.confirm(50)).rejects.toThrow("근거");
    expect((await h.confirm(50, "발주서 안내에 따라 박스 라벨 50개입 확인")).rows[0]).toMatchObject({ cartonReviewConfirmed: true, unitsPerCarton: 50 });
    expect(h.store.getProductMaster("TEST-SKU")?.unitsPerCarton).toBe(40);
  });

  it("recalculates changed files automatically, rejects stale tokens, and stops on conflicts or overrides", async () => {
    const h = fixture();
    const old = await h.workflow.previewLogenRegistration(h.input);
    h.writeWorkbook(25);
    expect((await h.workflow.previewLogenRegistration(h.input)).rows[0]).toMatchObject({ cartonReviewMode: "automatic", cartonReviewConfirmed: true, unitsPerCarton: 25, cartonCount: 8 });
    expect((await h.workflow.registerLogenDeliveryOrder({ ...h.input, reviewToken: old.reviewToken })).status).toBe("blocked");
    await expect(h.confirm(50, "old", old.rows[0].evidenceToken)).rejects.toThrow("변경");
    h.store.replaceOrderItems(h.order.orderNo, [{ ...h.order.items[0], orderedQuantity: 100 }]);
    expect((await h.workflow.previewLogenRegistration(h.input)).rows[0]).toMatchObject({ cartonReviewMode: "automatic", cartonCount: 4 });
    await h.confirm(25);
    h.store.upsertProductMaster({ skuCode: "TEST-SKU", skuName: "예시", unitsPerCarton: 50, source: "backend", updatedAt: "new" });
    expect((await h.workflow.previewLogenRegistration(h.input)).ready).toBe(false);
    await h.confirm(25, "발주서 25개입 확인, 기존 기준과 다름");
    expect((await h.workflow.previewLogenRegistration({ ...h.input, draftUnits: [{ skuCode: "TEST-SKU", unitsPerCarton: 50 }] })).ready).toBe(false);
    expect((await h.workflow.previewLogenRegistration({ ...h.input, dataSource: "backend" })).ready).toBe(false);
  });

  it("automatically passes matching stored units, but never rounds fractional carton counts", async () => {
    const h = fixture();
    h.store.upsertProductMaster({ skuCode: "TEST-SKU", skuName: "예시", unitsPerCarton: 50, source: "backend", updatedAt: "now" });
    expect((await h.workflow.previewLogenRegistration(h.input)).rows[0]).toMatchObject({ cartonReviewMode: "automatic", cartonCount: 4 });
    h.store.replaceOrderItems(h.order.orderNo, [{ ...h.order.items[0], orderedQuantity: 201 }]);
    expect((await h.workflow.previewLogenRegistration(h.input)).rows[0]).toMatchObject({ cartonReviewMode: "required", cartonCount: 0 });
    expect((await h.workflow.registerLogenDeliveryOrder(h.input)).status).toBe("blocked");
  });

  it("rejects incomplete acknowledgments, invalid quantities and missing files through HTTP handlers", async () => {
    const h = fixture(null);
    const handlers = createFulfillmentToolHandlers(h.workflow, "website_mcp");
    const plan = await h.workflow.previewLogenRegistration(h.input);
    const reviews = [{ orderNo: h.order.orderNo, skuCode: "TEST-SKU", unitsPerCarton: 50, evidenceToken: plan.rows[0].evidenceToken, note: "박스 라벨 확인" }];
    await expect(handlers.confirm_carton_order_review({ ...h.input, reviews, confirmed: false })).rejects.toThrow("확인");
    await expect(h.confirm(30, "박스 라벨 확인")).rejects.toThrow("나머지 없이");
    const saved = await handlers.confirm_carton_order_review({ ...h.input, reviews, confirmed: true });
    expect(saved).toMatchObject({ ready: true });
    unlinkSync(h.filePath);
    expect((await h.workflow.registerLogenDeliveryOrder(h.input)).status).toBe("blocked");
    await expect(h.confirm(50, "실물 확인")).rejects.toThrow("파일");
  });

  it("opens only the selected downloaded PO and never records a review on file open", async () => {
    const h = fixture();
    const openFile = vi.fn().mockResolvedValue(undefined);
    const opener = createOrderFileOpener({ getRun: runId => h.store.getRun(runId), openFile });
    await opener({ runId: h.run.id, orderNo: h.order.orderNo, expectedFilePath: h.filePath });
    expect(openFile).toHaveBeenCalledTimes(1);
    expect(h.store.getCartonOrderReview(h.run.id, h.order.orderNo, "TEST-SKU")).toBeUndefined();
    await expect(opener({ runId: h.run.id, orderNo: h.order.orderNo, expectedFilePath: "C:/unrelated.xlsx" })).rejects.toThrow();
    expect(openFile).toHaveBeenCalledTimes(1);
  });
});
