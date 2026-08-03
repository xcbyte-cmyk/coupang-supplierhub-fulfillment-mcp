import { describe, expect, it } from "vitest";
import { resolveShipmentDispatchSchedule } from "../src/shipment-dispatch-schedule.js";

const baseInput = {
  today: "2026-08-03",
  expectedInboundDates: ["2026-08-04"],
} as const;

describe("shipment dispatch schedule", () => {
  it("prefers explicit operator input over saved Run values", () => {
    expect(
      resolveShipmentDispatchSchedule({
        ...baseInput,
        requestedShipDate: "2026-08-02",
        requestedShipTime: "14:30",
        savedShipDate: "2026-08-03",
        savedShipTime: "15:00",
      }),
    ).toEqual({
      shipDate: "2026-08-02",
      shipTime: "14:30",
      dateSource: "requested",
      timeSource: "requested",
    });
  });

  it("reuses the saved Run schedule when operator input is absent", () => {
    expect(
      resolveShipmentDispatchSchedule({
        ...baseInput,
        savedShipDate: "2026-08-01",
        savedShipTime: "15:20",
      }),
    ).toMatchObject({
      shipDate: "2026-08-01",
      shipTime: "15:20",
      dateSource: "saved",
      timeSource: "saved",
    });
  });

  it("falls back to today at 16:00 only when no value is saved", () => {
    expect(resolveShipmentDispatchSchedule(baseInput)).toMatchObject({
      shipDate: "2026-08-03",
      shipTime: "16:00",
      dateSource: "today",
      timeSource: "default",
    });
  });

  it("rejects malformed time and dates outside the EDD D-3 through D-1 window", () => {
    expect(() =>
      resolveShipmentDispatchSchedule({
        ...baseInput,
        requestedShipTime: "25:00",
      }),
    ).toThrow("HH:mm");
    expect(() =>
      resolveShipmentDispatchSchedule({
        ...baseInput,
        requestedShipDate: "2026-07-31",
      }),
    ).toThrow("EDD D-3~D-1");
  });
});
