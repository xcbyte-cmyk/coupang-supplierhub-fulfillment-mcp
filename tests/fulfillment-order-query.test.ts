import { describe, expect, it } from "vitest";
import {
  fulfillmentOrderQueryLabel,
  normalizeFulfillmentOrderQuery,
} from "../src/fulfillment-order-query.js";

describe("fulfillment order query", () => {
  it("accepts a custom expected inbound date range", () => {
    const query = normalizeFulfillmentOrderQuery({
      lookAheadDays: 30,
      dateFrom: "2026-08-04",
      dateTo: "2026-08-07",
    });

    expect(query).toMatchObject({
      dateSearchType: "expected_inbound_date",
      dateFrom: "2026-08-04",
      dateTo: "2026-08-07",
    });
    expect(fulfillmentOrderQueryLabel(query)).toBe(
      "2026-08-04~2026-08-07 입고예정일",
    );
  });

  it("requires both valid dates in chronological order", () => {
    expect(() =>
      normalizeFulfillmentOrderQuery({
        lookAheadDays: 7,
        dateFrom: "2026-08-04",
      }),
    ).toThrow("시작일과 종료일을 모두");
    expect(() =>
      normalizeFulfillmentOrderQuery({
        lookAheadDays: 7,
        dateFrom: "2026-08-08",
        dateTo: "2026-08-07",
      }),
    ).toThrow("종료일보다 늦을 수 없습니다");
    expect(() =>
      normalizeFulfillmentOrderQuery({
        lookAheadDays: 7,
        dateFrom: "2026-02-30",
        dateTo: "2026-02-30",
      }),
    ).toThrow("올바른 날짜가 아닙니다");
  });

  it("defaults to expected inbound date and requires dates for order-date search", () => {
    expect(normalizeFulfillmentOrderQuery({ lookAheadDays: 7 }).dateSearchType).toBe(
      "expected_inbound_date",
    );
    expect(() =>
      normalizeFulfillmentOrderQuery({
        lookAheadDays: 30,
        dateSearchType: "order_date",
      }),
    ).toThrow("발주일 조회는 시작일과 종료일을 지정");
    expect(
      fulfillmentOrderQueryLabel(
        normalizeFulfillmentOrderQuery({
          lookAheadDays: 30,
          dateSearchType: "order_date",
          dateFrom: "2026-07-01",
          dateTo: "2026-07-31",
        }),
      ),
    ).toBe("2026-07-01~2026-07-31 발주일");
  });
});
