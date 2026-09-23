import { describe, expect, it } from "vitest";
import {
  isSafePrePrintShipmentDocumentFailure,
  isSafePreSubmissionShipmentFailure,
} from "../src/fulfillment-workflow.js";

describe("shipment upload retry safety", () => {
  it("allows retry only for known failures before external submission", () => {
    expect(
      isSafePreSubmissionShipmentFailure(
        "실제 등록에 필요한 업로드 작업목록과 쉽먼트 매핑 셀렉터가 아직 교정되지 않았습니다. 준비 테스트만 실행할 수 있습니다.",
      ),
    ).toBe(true);
    expect(
      isSafePreSubmissionShipmentFailure(
        "업로드 요청 후 결과를 확인하지 못했습니다. 자동으로 다시 업로드하지 마세요.",
      ),
    ).toBe(false);
    expect(
      isSafePreSubmissionShipmentFailure("쿠팡 처리내역에서 실패로 확인했습니다."),
    ).toBe(false);
  });

  it("retries a shipment document lookup only when printing never started", () => {
    expect(
      isSafePrePrintShipmentDocumentFailure(
        "입고예정일과 일치하는 쉽먼트를 찾지 못했습니다.",
      ),
    ).toBe(true);
    expect(
      isSafePrePrintShipmentDocumentFailure(
        "인쇄 요청 시작 후 결과를 확인하지 못했습니다. 자동 재출력하지 마세요.",
      ),
    ).toBe(false);
  });
});
