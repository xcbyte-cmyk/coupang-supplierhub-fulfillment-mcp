import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const html = readFileSync(
  fileURLToPath(new URL("../public/fulfillment.html", import.meta.url)),
  "utf8",
);

describe("fulfillment operating UI", () => {
  it("recovers the latest internal scan and run IDs without manual input", () => {
    expect(html).toContain("payload.latestScanId");
    expect(html).toContain("payload.latestRunId");
    expect(html).toContain("requiredId(scanId");
    expect(html).toContain("requiredId(runId");
  });

  it("shows stage-local running, completed, and failed feedback", () => {
    expect(html).toContain('class="stage-status"');
    expect(html).toContain('card?.classList.add("running")');
    expect(html).toContain('card?.classList.add("completed")');
    expect(html).toContain('card?.classList.add("failed")');
  });

  it("shows the separate Logen stages 11-14 and the sixteen-stage controls", () => {
    expect(html).toContain('[16, "쉽먼트 문서 출력", "print_supplierhub_shipment_documents"');
    expect(html).toContain('[11, "로젠 로그인 완료", "open_logen_login"');
    expect(html).toContain('[12, "주문등록/출력(단건) 이동", "open_logen_single_order_registration"');
    expect(html).toContain('[13, "신규(F3)·입력·저장(F5)", "register_logen_delivery_order"');
    expect(html).toContain('[14, "로젠 송장 출력", "print_logen_waybill"');
    expect(html).toContain('id="floatingFullRun"');
    expect(html).toContain("1~16단계를 진행합니다");
  });

  it("offers a custom expected inbound date range and keeps recovery controls visible", () => {
    expect(html).toContain('id="dateSearchType"');
    expect(html).toContain('<option value="expected_inbound_date" selected>입고예정일</option>');
    expect(html).toContain('<option value="order_date">발주일</option>');
    expect(html).toContain('id="dateFrom"');
    expect(html).toContain('id="dateTo"');
    expect(html).toContain("orderQueryInput()");
    expect(html).toContain("시작일만 고르면 종료일도 같은 날짜로 자동 설정됩니다");
    expect(html).toContain("고급 복구 옵션 · 이전 Scan ID / Run ID로 다시 연결");
    expect(html).toContain('id="stageRecordStage"');
    expect(html).toContain('id="resetStageRecord"');
    expect(html).toContain('postContextTool("reset_fulfillment_stage_record"');
    expect(html).toContain("선택 이력 바로 초기화");
    expect(html).toContain("quickReset: true");
    expect(html).toContain('data-stage-reset="${number}"');
    expect(html).toContain("등록키+이력 초기화");
    expect(html).toContain("clearLogenRegistration");
  });

  it("offers an expert-only guarded reset for the whole current Run", () => {
    expect(html).toContain('id="resetCurrentRunAll"');
    expect(html).toContain('id="resetCurrentRunDialog"');
    expect(html).toContain('id="resetCurrentRunConfirmation"');
    expect(html).toContain('id="resetCurrentRunChecked"');
    expect(html).toContain("resetCurrentRunConfirmation.value.trim() !== resetCurrentRunId");
    expect(html).toContain("|| !resetCurrentRunId");
    expect(html).toContain("현재 선택된 Run이 없습니다");
    expect(html).toContain('postContextTool("delete_fulfillment_run_record"');
    expect(html).toContain("쿠팡·로젠·프린터의 실제 처리 결과를 확인했고");
    expect(html).toContain("clearDeletedRunSelection()");
  });

  it("shows prepared stage-1 workbooks inside group 2 before stage 7 runs", () => {
    expect(html).toContain('id="preparedOrderFiles"');
    expect(html).toContain("02 실행 전 · 1번에서 준비한 파일 확인");
    expect(html).toContain("발주확정 엑셀을 먼저 열어보세요");
    expect(html).toContain('data-open-prepared-order="${planText(job.orderNo)}"');
    expect(html).toContain('postContextTool("open_order_confirmation_file"');
    expect(html).toContain("파일 열기만으로 7단계는 실행되지 않습니다");
    expect(html).toContain("documentsGroup.insertBefore(orderReviewCheckpoint");
    expect(html).toContain('document.querySelector(".beginner-current").insertBefore(orderReviewCheckpoint');
    expect(html).toContain('orderReviewCheckpoint.hidden = action.group !== "documents"');
  });

  it("does not add a fixed transition delay after stage 7", () => {
    const match = html.match(
      /const browserOrDeviceStage = \[([^\]]+)\]\.includes\(number\)/,
    );
    expect(match).not.toBeNull();
    const delayedStages = match![1].split(",").map((value) => Number(value.trim()));
    expect(delayedStages).not.toContain(7);
  });
});
