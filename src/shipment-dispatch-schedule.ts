import { eligibleShipDates } from "./fulfillment-planning.js";

export interface ShipmentDispatchScheduleInput {
  requestedShipDate?: string;
  requestedShipTime?: string;
  savedShipDate?: string;
  savedShipTime?: string;
  today: string;
  defaultShipTime?: string;
  expectedInboundDates: readonly string[];
}

export interface ShipmentDispatchSchedule {
  shipDate: string;
  shipTime: string;
  dateSource: "requested" | "saved" | "today";
  timeSource: "requested" | "saved" | "default";
}

/**
 * Resolves the dispatch schedule once for both workflow persistence and browser input.
 * Explicit operator input wins over saved Run state; only missing state falls back to today at 16:00.
 */
export function resolveShipmentDispatchSchedule(
  input: ShipmentDispatchScheduleInput,
): ShipmentDispatchSchedule {
  const requestedShipDate = optionalDate(input.requestedShipDate, "발송일");
  const savedShipDate = optionalDate(input.savedShipDate, "저장된 발송일");
  const today = requiredDate(input.today, "기준일");
  const requestedShipTime = optionalTime(input.requestedShipTime, "발송시간");
  const savedShipTime = optionalTime(input.savedShipTime, "저장된 발송시간");
  const defaultShipTime = requiredTime(input.defaultShipTime ?? "16:00", "기본 발송시간");

  const shipDate = requestedShipDate ?? savedShipDate ?? today;
  const shipTime = requestedShipTime ?? savedShipTime ?? defaultShipTime;
  const invalidInboundDate = input.expectedInboundDates.find(
    (expectedInboundDate) => !eligibleShipDates(expectedInboundDate).includes(shipDate),
  );
  if (invalidInboundDate) {
    throw new Error(
      `발송일 ${shipDate}은 입고예정일 ${invalidInboundDate}의 허용 출고일(EDD D-3~D-1)이 아닙니다.`,
    );
  }

  return {
    shipDate,
    shipTime,
    dateSource: requestedShipDate ? "requested" : savedShipDate ? "saved" : "today",
    timeSource: requestedShipTime ? "requested" : savedShipTime ? "saved" : "default",
  };
}

function optionalDate(value: string | undefined, label: string): string | undefined {
  return value?.trim() ? requiredDate(value, label) : undefined;
}

function requiredDate(value: string, label: string): string {
  const normalized = value.trim();
  const match = normalized.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) throw new Error(`${label}은 YYYY-MM-DD 형식이어야 합니다.`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const candidate = new Date(Date.UTC(year, month - 1, day));
  if (
    candidate.getUTCFullYear() !== year ||
    candidate.getUTCMonth() !== month - 1 ||
    candidate.getUTCDate() !== day
  ) {
    throw new Error(`${label}이 올바른 날짜가 아닙니다.`);
  }
  return normalized;
}

function optionalTime(value: string | undefined, label: string): string | undefined {
  return value?.trim() ? requiredTime(value, label) : undefined;
}

function requiredTime(value: string, label: string): string {
  const normalized = value.trim();
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(normalized)) {
    throw new Error(`${label}은 HH:mm 형식이어야 합니다.`);
  }
  return normalized;
}
