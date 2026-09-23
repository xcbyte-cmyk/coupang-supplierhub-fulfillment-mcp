const api = createWorkflowApi();
const isBeginner = document.body.dataset.experience === "beginner";
const navigationFields = ["runId", "scanId", "lookAheadDays", "dateSearchType", "dateFrom", "dateTo", "targetOrderNos", "dataSource", "logenMethod", "shipmentShipDate", "shipmentShipTime"];
const pageSelection = new URLSearchParams(location.search);
let freshStart = pageSelection.get("fresh") === "1";
for (const id of navigationFields) if (pageSelection.has(id)) document.getElementById(id).value = pageSelection.get(id);
let beginnerAction;
let selectionNotice = false;
let stockContextKey;
const definitions = [
  [1, "Supplier Hub 접속", "open_supplierhub", false, "Supplier Hub Agent"],
  [2, "발주 목록 조회", "list_private_label_orders", false, "Supplier Hub Agent"],
  [3, "발주 상태 분류", "compare_new_orders", false, "Fulfillment Coordinator"],
  [4, "처리 발주 선택", "select_orders_for_fulfillment", false, "Fulfillment Coordinator"],
  [5, "확정 양식 다운로드", "download_order_confirmation_template", false, "Supplier Hub Agent"],
  [6, "확정수량 작성", "prepare_order_confirmation_workbook", false, "Fulfillment Coordinator"],
  [7, "업로드·발주확정", "upload_and_confirm_private_label_orders", false, "Supplier Hub Agent"],
  [8, "발주서 다운로드", "download_order_files", false, "Supplier Hub Agent"],
  [9, "발주서 인쇄", "print_order_files", false, "Fulfillment Coordinator"],
  [10, "인쇄 결과 기록", "record_print_result", false, "Fulfillment Coordinator"],
  [11, "로젠 로그인 완료", "open_logen_login", true, "Logen Agent"],
  [12, "주문등록/출력(단건) 이동", "open_logen_single_order_registration", true, "Logen Agent"],
  [13, "신규(F3)·입력·저장(F5)", "register_logen_delivery_order", true, "Logen Agent"],
  [14, "로젠 송장 출력", "print_logen_waybill", true, "Logen Agent"],
  [15, "쉽먼트 일괄등록", "register_supplierhub_shipment_tracking", true, "Supplier Hub Agent"],
  [16, "쉽먼트 문서 출력", "print_supplierhub_shipment_documents", true, "Supplier Hub Agent"]
];
const workflowGroups = [
  { id: "prepare", number: "01", name: "발주 준비", from: 1, through: 6 },
  { id: "documents", number: "02", name: "확정과 발주서", from: 7, through: 10,
    description: "업로드·발주확정 → 발주서 다운로드 → 발주서 인쇄 → 인쇄 결과 기록",
    note: "발주확정 전 검토를 거친 뒤 진행합니다. 묶음이 끝나면 발주서 출력물을 확인하고 로젠 배송을 시작하세요." },
  { id: "logen", number: "03", name: "로젠 배송", from: 11, through: 14,
    description: "로젠 로그인 완료 → 주문등록 화면 이동 → 배송 주문등록 → 송장 출력",
    note: "13단계 등록 전에는 카톤·수취 정보를 검토합니다. 송장 출력 후 번호 확인이 필요하면 이 묶음에서 멈춥니다." },
  { id: "inbound", number: "04", name: "입고 마무리", from: 15, through: 16,
    description: "쉽먼트 일괄등록 → 쉽먼트 문서 출력",
    note: "확인된 송장번호로 쉽먼트를 등록하고 문서를 출력합니다. 일괄등록 결과가 부분 완료이면 문서 출력 전 멈춥니다." },
];
const checklistLabels = { 11: "로젠 로그인", 12: "주문등록 화면 이동", 13: "로젠 배송 주문등록", 16: "쉽먼트 문서 출력" };
const flow = document.querySelector("#flow");
const result = document.querySelector("#result");
const summary = document.querySelector("#summary");
const scanId = document.querySelector("#scanId");
const runId = document.querySelector("#runId");
const recentScanId = document.querySelector("#recentScanId");
const recentRunId = document.querySelector("#recentRunId");
const stageRecordStage = document.querySelector("#stageRecordStage");
const contextStatus = document.querySelector("#contextStatus");
const recordWorkflow = document.querySelector("#recordWorkflow");
const recordingStatus = document.querySelector("#recordingStatus");
const runPreparation = document.querySelector("#runPreparation");
const preparationFlow = document.querySelector("#preparationFlow");
const remainingFlow = document.querySelector("#remainingFlow");
const orderReviewDialog = document.querySelector("#orderConfirmationReviewDialog");
let orderReviewReady = false;
const dateSearchType = document.querySelector("#dateSearchType");
const dateFrom = document.querySelector("#dateFrom");
const dateTo = document.querySelector("#dateTo");
const targetOrderNos = document.querySelector("#targetOrderNos");
const shipmentShipDate = document.querySelector("#shipmentShipDate");
const shipmentShipTime = document.querySelector("#shipmentShipTime");
const orderPrinterName = document.querySelector("#orderPrinterName");
const waybillPrinterName = document.querySelector("#waybillPrinterName");
const logenTestPrintPopup = document.querySelector("#logenTestPrintPopup");
const openLogenTestPrintPopup = document.querySelector("#openLogenTestPrintPopup");
const shipmentPrinterName = document.querySelector("#shipmentPrinterName");
const waybillDialog = document.querySelector("#waybillConfirmationDialog");
const waybillForm = document.querySelector("#waybillConfirmationForm");
const waybillRows = document.querySelector("#waybillConfirmationRows");
const waybillError = document.querySelector("#waybillConfirmationError");
let waybillConfirmationContext = [];
openLogenTestPrintPopup.addEventListener("click", () => {
  const popup = window.open("/api/fulfillment/logen-test-print-popup", "_blank");
  if (!popup) {
    summary.textContent = "출력 팝업이 차단되었습니다. 이 주소의 팝업을 허용한 뒤 다시 누르세요.";
    return;
  }
  summary.textContent = "로젠 개발계 출력 팝업을 열었습니다. Microsoft Print to PDF를 선택해 시험 PDF 1장을 저장하세요.";
});
let workflowRecorder;
let workflowRecordingStream;
let workflowRecordingChunks = [];
let workflowRecordingStartedAt;
let workflowRecordingTimer;
let workflowRecordingDownloadUrl;
let workflowRecordingSurface = "화면";
let preparationPlan;
let preparationSequence = 0;
let preparationBusy = false;
let runReadRevision = 0;
let contextsRequestSequence = 0;
function setPreparationBusy(value) {
  if (preparationBusy !== value) runReadRevision++;
  preparationBusy = value;
}
const floatingPanel = document.querySelector("#floatingWorkPanel");
// Keep workflow state and execution in the original page. The always-on-top
// window mirrors controls, so opening it never creates a second runner.
let detachedToolsWindow;
let detachedToolsObserver;
let detachedToolsOpening = false;
async function openDetachedTools() {
  if (detachedToolsWindow && !detachedToolsWindow.closed) {
    detachedToolsWindow.close();
    return;
  }
  if (detachedToolsOpening) return;
  const status = document.querySelector("#detachedToolsStatus");
  if (!window.documentPictureInPicture) {
    status.textContent = "작은 항상 위 창은 데스크톱 Chrome에서 지원합니다. 이 주소를 Chrome에서 열어 사용하세요. 현재 작업 도구는 그대로 사용할 수 있습니다.";
    return;
  }
  detachedToolsOpening = true;
  try {
    const pip = await window.documentPictureInPicture.requestWindow({ width: 360, height: 600 });
    detachedToolsWindow = pip;
    pip.document.title = "발주·배송 작업 도구";
    pip.document.documentElement.lang = "ko";
    for (const style of document.querySelectorAll("style")) pip.document.head.append(style.cloneNode(true));
    const style = pip.document.createElement("style");
    style.textContent = `body { margin:0; padding:8px; background:#f4f8fc; }
      #floatingWorkPanel, #floatingWorkPanel.is-collapsed { position:static!important; width:100%!important; max-height:none; box-shadow:none; }
      #floatingDragHandle { cursor:default; } #resetFloatingPanel, #detachFloatingTools { display:none; }
      #floatingPanelBody { overflow:auto; } .pip-status { font-size:12px; margin:8px; }
      .pip-return { width:100%; margin:0 0 8px; }`;
    pip.document.head.append(style);
    const back = pip.document.createElement("button");
    back.className = "pip-return";
    back.textContent = "업무 화면으로 돌아가기";
    back.addEventListener("click", () => { window.focus(); pip.close(); });
    const host = pip.document.createElement("div");
    const compactStatus = pip.document.createElement("p");
    compactStatus.className = "pip-status";
    compactStatus.setAttribute("aria-live", "polite");
    pip.document.body.append(back, host, compactStatus);
    // Update existing nodes to preserve keyboard focus during monitoring.
    const mirror = floatingPanel.cloneNode(true);
    mirror.classList.remove("in-review");
    host.append(mirror);
    let compact = false;
    function render() {
      for (const source of floatingPanel.querySelectorAll("[id]")) {
        const target = mirror.querySelector(`#${source.id}`);
        if (!target) continue;
        if (!source.children.length) target.textContent = source.textContent;
        for (const attr of ["disabled", "hidden", "aria-pressed", "value", "max"]) {
          if (source.hasAttribute(attr)) target.setAttribute(attr, source.getAttribute(attr));
          else target.removeAttribute(attr);
        }
      }
      mirror.classList.toggle("is-collapsed", compact);
      mirror.querySelector("#floatingPanelBody").hidden = compact;
      const collapse = mirror.querySelector("#collapseFloatingPanel");
      collapse.textContent = compact ? "펼치기" : "접기";
      collapse.setAttribute("aria-expanded", String(!compact));
      compactStatus.textContent = document.querySelector("dialog[open]")
        ? "업무 화면에서 검토 내용을 확인하세요."
        : document.querySelector("#floatingStage").textContent;
    }
    mirror.addEventListener("click", event => {
      const button = event.target.closest("button");
      if (!button || button.disabled) return;
      if (button.id === "collapseFloatingPanel") {
        compact = !compact;
        render();
        pip.resizeTo(360, compact ? 190 : 600);
        return;
      }
      if (button.id === "floatingDragHandle") return;
      const source = document.getElementById(button.id);
      if (source && !source.disabled) source.click();
      render();
    });
    detachedToolsObserver = new MutationObserver(render);
    detachedToolsObserver.observe(floatingPanel, { subtree:true, childList:true, characterData:true, attributes:true });
    document.body.classList.add("work-tools-detached");
    document.querySelector("#detachWorkTools").textContent = "작업 도구 본문으로 복귀";
    status.textContent = "작업 도구가 항상 위 작은 창으로 열렸습니다. 기존 Chrome 창은 최대화해 사용하세요. 검토는 업무 화면에서 진행합니다.";
    render();
    pip.addEventListener("pagehide", () => {
      detachedToolsObserver?.disconnect();
      detachedToolsObserver = undefined;
      detachedToolsWindow = undefined;
      document.body.classList.remove("work-tools-detached");
      document.querySelector("#detachWorkTools").textContent = "작업 도구 작은 창으로";
      status.textContent = "작업 도구를 본문으로 되돌렸습니다.";
    }, { once:true });
  } catch {
    detachedToolsWindow?.close();
    status.textContent = "작은 창을 열지 못했습니다. Chrome에서 버튼을 다시 눌러 주세요.";
  } finally { detachedToolsOpening = false; }
}
document.querySelector("#detachWorkTools").addEventListener("click", openDetachedTools);
document.querySelector("#detachFloatingTools").addEventListener("click", openDetachedTools);
addEventListener("pagehide", () => detachedToolsWindow?.close());
const floatingBody = document.querySelector("#floatingPanelBody");
const floatingFullRun = document.querySelector("#floatingFullRun");
const pauseWorkflow = document.querySelector("#pauseWorkflow");
const floatingSettingsKey = isBeginner ? "supplierhub-floating-tools-beginner-v1" : "supplierhub-floating-tools-v1";
let floatingSettings = { collapsed: isBeginner && innerWidth < 1180, monitoring: true, x: null, y: null };
try {
  const saved = JSON.parse(localStorage.getItem(floatingSettingsKey) || "null");
  if (saved && typeof saved === "object") floatingSettings = {
    collapsed: saved.collapsed === true, monitoring: saved.monitoring !== false,
    x: Number.isFinite(saved.x) ? saved.x : null, y: Number.isFinite(saved.y) ? saved.y : null,
  };
} catch { /* Keep usable defaults when browser storage is unavailable. */ }
let monitoringBusy = false;
let monitoringError = "";
let monitoringCheckedAt = "";
let monitoredRun;
let dashboardReady = false;
let activeRange;
let pauseRequested = false;
let floatingDrag;
const unitDrafts = new Map();
const cartonReviewNotes = new Map();
const cartonReviewChecks = new Map();
const unitsConfirmation = document.querySelector("#confirmCartonUnits");
const preparationMessage = document.querySelector("#preparationMessage");
const registrationDialog = document.querySelector("#registrationPreviewDialog");
const unitSourceLabels = { backend: "저장된 상품정보", order_file: "발주서 명시값", automatic: "발주서 자동 확인값", missing: "입수수량 누락", draft: "입력값 · 확인 전", reviewed: "이번 발주 확인값", registered: "기존 등록값" };
const registrationLabels = { not_started: "미등록", ready: "등록 대기", blocked: "보완 후 재개", failed: "실패", unknown: "결과 확인 필요", registered: "등록 완료", waybills_printed: "송장 출력 완료", completed: "완료" };

function planText(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
}
function preparationInput() {
  return { runId: requiredId(runId, "Run ID", 4), dataSource: document.querySelector("#dataSource").value, logenMethod: document.querySelector("#logenMethod").value };
}
function draftRows() {
  return [...unitDrafts].map(([skuCode, value]) => {
    const unitsPerCarton = Number(value);
    if (!Number.isSafeInteger(unitsPerCarton) || unitsPerCarton <= 0) throw new Error(`${skuCode}: 입수수량을 양의 정수로 입력하세요.`);
    return { skuCode, unitsPerCarton };
  });
}
function showPlanIssues(target, issues) {
  target.replaceChildren(...issues.map(message => { const item = document.createElement("li"); item.textContent = message; return item; }));
}
function syncPreparationControls() {
  syncGroupProgress();
  document.querySelector("#openOrderReview").disabled = preparationBusy || !runId.value;
  const available = Boolean(runId.value && preparationPlan?.runId === runId.value);
  document.querySelector("#refreshPreparation").disabled = preparationBusy || !runId.value;
  document.querySelector("#calculatePreparation").disabled = preparationBusy || !available;
  document.querySelector("#previewRegistration").disabled = preparationBusy || !available || Boolean(unitDrafts.size) || !preparationPlan?.rows.every(row => row.cartonReviewConfirmed);
  document.querySelector("#saveCartonUnits").disabled = preparationBusy || !available || !unitDrafts.size || !unitsConfirmation.checked;
  unitsConfirmation.disabled = preparationBusy || !available || !unitDrafts.size;
  for (const button of document.querySelectorAll("[data-save-carton-review]")) {
    const key = button.dataset.saveCartonReview;
    const row = preparationPlan?.rows.find(row => cartonRowKey(row) === key);
    const value = Number(unitDrafts.get(row?.skuCode) ?? row?.unitsPerCarton);
    button.disabled = preparationBusy || !row?.editable || !row.fileEvidence?.available ||
      !Number.isSafeInteger(value) || value <= 0 || row.orderedQuantity % value !== 0 ||
      cartonReviewChecks.get(key) !== cartonCheckKey(row, value);
  }
}
function cartonRowKey(row) { return JSON.stringify([runId.value, row.orderNo, row.skuCode]); }
function cartonCheckKey(row, units) { return JSON.stringify([row.evidenceToken, units, cartonReviewNotes.get(cartonRowKey(row)) ?? row.cartonReview?.note ?? ""]); }
function renderPreparation(plan) {
  document.querySelector("#preparationTable").hidden = !plan?.rows.length;
  document.querySelector("#preparationSummary").textContent = plan
    ? `${plan.runId} · 자동 확인 ${plan.rows.filter(row => row.cartonReviewMode === "automatic").length}건 · 직접 확인 ${plan.rows.filter(row => row.cartonReviewMode === "manual").length}건 · 예외 ${plan.rows.filter(row => !row.cartonReviewConfirmed).length}건 · 신규 ${plan.pendingCartonCount}카톤 · ${plan.ready ? "등록 미리보기로 진행" : "아래 예외·보완 항목 확인"}`
    : "실행을 선택하면 발주서를 자동으로 읽고 대조합니다.";
  document.querySelector("#preparationRows").innerHTML = (plan?.rows ?? []).map(row => {
    const value = unitDrafts.has(row.skuCode) ? unitDrafts.get(row.skuCode) : row.unitsPerCarton ?? "";
    const units = Number(value);
    const cartons = Number.isSafeInteger(units) && units > 0 && row.orderedQuantity % units === 0 ? row.orderedQuantity / units : "계산 필요";
    const key = cartonRowKey(row);
    const evidence = row.fileEvidence;
    const note = cartonReviewNotes.get(key) ?? row.cartonReview?.note ?? "";
    const confirmed = row.cartonReviewConfirmed && !unitDrafts.has(row.skuCode);
    const automaticallyChecked = confirmed && row.cartonReviewMode === "automatic";
    const fileValue = row.fileUnitsPerCarton;
    const mismatch = fileValue && row.masterUnitsPerCarton && fileValue !== row.masterUnitsPerCarton;
    return `<tr><td class="product-cell"><strong>${planText(row.orderNo)} / ${planText(row.skuCode)}</strong><small>${planText(row.skuName)}</small></td>
      <td>${row.orderedQuantity}개</td>
      <td class="carton-evidence"><strong>${fileValue ? `${fileValue}개입` : evidence?.conflicting ? "파일 값 불일치" : "명시값 없음"}</strong>
        ${(evidence?.values ?? []).map(item => `<small>${planText(item.fileName)} · ${planText(item.location)}<br>${planText(item.label)}: ${item.unitsPerCarton}개입</small>`).join("")}
        ${(evidence?.files ?? []).map(file => `<button type="button" class="secondary-action" data-open-carton-file="${planText(row.orderNo)}" data-file-path="${planText(file.filePath)}" ${file.readable ? "" : "disabled"}>발주서 열기</button><small>${planText(file.fileName)} · ${planText(file.message)}</small>`).join("") || "<small>8단계에서 발주서를 준비하세요.</small>"}
        ${(evidence?.files ?? []).some(file => file.notes.length) ? `<details><summary>발주서 포장 안내 보기</summary>${evidence.files.flatMap(file => file.notes.map(item => `<p>${planText(file.fileName)} · ${planText(item.location)}<br>${planText(item.text)}</p>`)).join("")}</details>` : ""}</td>
      <td>${row.masterUnitsPerCarton ? `${row.masterUnitsPerCarton}개입` : "없음"}${mismatch ? '<small class="carton-warning">발주서와 불일치</small>' : ""}</td>
      <td class="units-cell"><input type="number" min="1" step="1" aria-label="${planText(row.orderNo)} ${planText(row.skuCode)} 입수수량" data-units-sku="${planText(row.skuCode)}" value="${planText(value)}" ${row.editable ? "" : "disabled"} /> 개입
      <small>${unitDrafts.has(row.skuCode) ? "입력값 · 저장 전" : unitSourceLabels[row.source]}</small>
      ${row.suggestion ? `<button type="button" class="secondary-action" data-candidate-sku="${planText(row.skuCode)}" data-candidate-units="${row.suggestion.unitsPerCarton}">추정 후보 ${row.suggestion.unitsPerCarton}개 입력</button><small>${planText(row.suggestion.message)}</small>` : ""}</td>
      <td data-cartons-sku="${planText(row.skuCode)}" data-order-quantity="${row.orderedQuantity}">${cartons}${typeof cartons === "number" ? "카톤" : ""}</td>
      <td data-carton-review-status="${planText(row.skuCode)}" class="${confirmed ? 'carton-confirmed' : 'carton-warning'}">${automaticallyChecked ? "자동 확인 완료" : confirmed ? row.editable ? "직접 확인 완료" : "기존 등록 유지" : "예외 · 보완 필요"}<small>${planText(row.centerName)}</small></td></tr>
      ${row.editable ? `<tr class="carton-review-row"><td colspan="7">
        <p>${planText(automaticallyChecked ? row.autoReview.reason : confirmed ? "확인한 예외 수량을 이번 발주에 적용합니다." : row.autoReview?.reason ?? "입수수량을 확인하세요.")}</p>
        <details data-carton-exception="${planText(row.skuCode)}" ${confirmed ? "" : "open"}><summary>${confirmed ? "필요할 때만 수량 직접 수정" : "이 품목만 보완하기"}</summary><div class="carton-review-fields">
        <label>확인 근거 ${row.reviewNeedsReason ? "(필수)" : "(선택)"}<textarea maxlength="1000" data-carton-review-note="${planText(key)}" placeholder="예: 발주서 포장 안내에 따라 실물 박스 라벨에서 50개입 확인. 저장값과 다른 이유도 기록하세요.">${planText(note)}</textarea></label>
        <div><label class="plan-confirm"><input type="checkbox" data-carton-review-check="${planText(key)}" ${cartonReviewChecks.get(key) === cartonCheckKey(row, units) ? "checked" : ""} />발주서의 포장 기준과 이번 적용 수량을 확인했습니다.</label>
        <button type="button" data-save-carton-review="${planText(key)}">예외 확인 저장</button>
        <small>${automaticallyChecked ? "자동 확인된 품목은 수동 저장할 필요가 없습니다." : confirmed ? `${planText(row.cartonReview?.confirmedAt ?? "")} · ${row.unitsPerCarton}개입 적용` : "누락·불일치 값은 실제 포장 기준을 확인하고 근거를 입력하세요."}</small></div></div></details></td></tr>` : ""}`;
  }).join("");
  showPlanIssues(document.querySelector("#preparationIssues"), plan?.issues ?? []);
  syncPreparationControls();
}
async function refreshPreparation(resetDrafts = false) {
  const sequence = ++preparationSequence;
  if (resetDrafts || preparationPlan?.runId !== runId.value) { unitDrafts.clear(); cartonReviewNotes.clear(); cartonReviewChecks.clear(); unitsConfirmation.checked = false; }
  if (!runId.value) { preparationPlan = undefined; renderPreparation(); renderOrderReviewSummary(); return; }
  try {
    const input = preparationInput();
    const plan = await postContextTool("preview_logen_registration", input);
    if (sequence !== preparationSequence || runId.value !== input.runId) return;
    preparationPlan = plan;
    renderPreparation(plan);
  } catch (error) {
    if (sequence !== preparationSequence) return;
    preparationPlan = undefined;
    renderPreparation();
    preparationMessage.textContent = error.message;
  }
}
function setUnitDraft(skuCode, value) {
  const row = preparationPlan?.rows.find(item => item.skuCode === skuCode);
  if (!row?.editable) return;
  if (String(row.unitsPerCarton ?? "") === value) unitDrafts.delete(skuCode);
  else unitDrafts.set(skuCode, value);
  unitsConfirmation.checked = false;
  for (const item of preparationPlan?.rows ?? []) if (item.skuCode === skuCode) {
    cartonReviewChecks.delete(cartonRowKey(item));
    for (const checkbox of document.querySelectorAll("[data-carton-review-check]")) if (checkbox.dataset.cartonReviewCheck === cartonRowKey(item)) checkbox.checked = false;
  }
  for (const cell of document.querySelectorAll("[data-carton-review-status]")) if (cell.dataset.cartonReviewStatus === skuCode) {
    cell.textContent = "수량 변경 · 다시 확인"; cell.className = "carton-warning";
  }
  for (const details of document.querySelectorAll("[data-carton-exception]")) if (details.dataset.cartonException === skuCode) details.open = true;
  document.querySelector("#preparationSummary").textContent = "적용 수량을 수정했습니다. 입력값으로 계산해 자동 대조하거나 예외 확인을 저장하세요.";
  for (const input of document.querySelectorAll("[data-units-sku]")) if (input.dataset.unitsSku === skuCode) {
    input.value = value;
    input.parentElement.querySelector("small").textContent = unitDrafts.has(skuCode) ? "입력값 · 확인 전" : unitSourceLabels[row.source];
  }
  for (const cell of document.querySelectorAll("[data-cartons-sku]")) if (cell.dataset.cartonsSku === skuCode) {
    const units = Number(value), quantity = Number(cell.dataset.orderQuantity);
    cell.textContent = Number.isSafeInteger(units) && units > 0 && quantity % units === 0 ? `${quantity / units}카톤` : "계산 필요";
  }
  preparationMessage.textContent = "발주서와 다른 수량을 적용할 때만 확인 근거와 예외 확인을 저장하세요.";
  syncPreparationControls();
}
document.querySelector("#preparationRows").addEventListener("input", event => {
  if (event.target.matches("[data-units-sku]")) setUnitDraft(event.target.dataset.unitsSku, event.target.value);
  if (event.target.matches("[data-carton-review-note]")) {
    const key = event.target.dataset.cartonReviewNote;
    cartonReviewNotes.set(key, event.target.value);
    cartonReviewChecks.delete(key);
    for (const checkbox of document.querySelectorAll("[data-carton-review-check]")) if (checkbox.dataset.cartonReviewCheck === key) checkbox.checked = false;
    syncPreparationControls();
  }
});
document.querySelector("#preparationRows").addEventListener("change", event => {
  if (!event.target.matches("[data-carton-review-check]")) return;
  const key = event.target.dataset.cartonReviewCheck;
  const row = preparationPlan?.rows.find(row => cartonRowKey(row) === key);
  if (row && event.target.checked) cartonReviewChecks.set(key, cartonCheckKey(row, Number(unitDrafts.get(row.skuCode) ?? row.unitsPerCarton)));
  else cartonReviewChecks.delete(key);
  syncPreparationControls();
});
document.querySelector("#preparationRows").addEventListener("click", event => {
  const button = event.target.closest("[data-candidate-sku]");
  if (button) setUnitDraft(button.dataset.candidateSku, button.dataset.candidateUnits);
});
document.querySelector("#preparationRows").addEventListener("click", async event => {
  const openButton = event.target.closest("[data-open-carton-file]");
  if (openButton) {
    openButton.disabled = true;
    try {
      const result = await postContextTool("open_order_carton_file", { runId: runId.value,
        orderNo: openButton.dataset.openCartonFile, expectedFilePath: openButton.dataset.filePath });
      preparationMessage.textContent = result.message;
    } catch (error) { preparationMessage.textContent = error.message; }
    finally { openButton.disabled = false; }
    return;
  }
  const saveButton = event.target.closest("[data-save-carton-review]");
  if (!saveButton || preparationBusy) return;
  const key = saveButton.dataset.saveCartonReview;
  const row = preparationPlan?.rows.find(row => cartonRowKey(row) === key);
  if (!row) return;
  const unitsPerCarton = Number(unitDrafts.get(row.skuCode) ?? row.unitsPerCarton);
  if (cartonReviewChecks.get(key) !== cartonCheckKey(row, unitsPerCarton)) return;
  setPreparationBusy(true); syncPreparationControls();
  try {
    const input = preparationInput();
    const saved = await postContextTool("confirm_carton_order_review", { runId: input.runId, dataSource: input.dataSource,
      confirmed: true, reviews: [{ orderNo: row.orderNo, skuCode: row.skuCode, evidenceToken: row.evidenceToken,
        unitsPerCarton, note: cartonReviewNotes.get(key) ?? row.cartonReview?.note ?? "" }] });
    if (runId.value !== input.runId) return;
    ++preparationSequence;
    unitDrafts.delete(row.skuCode); cartonReviewChecks.delete(key); cartonReviewNotes.delete(key);
    preparationPlan = saved; renderPreparation(saved);
    preparationMessage.textContent = saved.message;
  } catch (error) { preparationMessage.textContent = error.message; }
  finally { setPreparationBusy(false); syncPreparationControls(); }
});
unitsConfirmation.addEventListener("change", syncPreparationControls);
document.querySelector("#refreshPreparation").addEventListener("click", () => void refreshPreparation(true));
document.querySelector("#calculatePreparation").addEventListener("click", async () => {
  setPreparationBusy(true); syncPreparationControls();
  try {
    const input = preparationInput();
    const preview = await postContextTool("preview_logen_registration", { ...input, draftUnits: draftRows() });
    if (runId.value !== input.runId) return;
    for (const row of preview.rows) if (row.cartonReviewMode === "automatic") unitDrafts.delete(row.skuCode);
    preparationPlan = preview;
    renderPreparation(preview);
    preparationMessage.textContent = `계산 결과: 신규 ${preview.pendingCartonCount}카톤. ${preview.rows.every(row => row.cartonReviewConfirmed) ? "확인이 완료되어 등록 미리보기로 진행할 수 있습니다." : "예외가 있는 품목만 보완하세요."}`;
  } catch (error) { preparationMessage.textContent = error.message; }
  finally { setPreparationBusy(false); syncPreparationControls(); }
});
document.querySelector("#saveCartonUnits").addEventListener("click", async () => {
  setPreparationBusy(true); syncPreparationControls();
  try {
    if (!unitsConfirmation.checked || preparationPlan?.runId !== runId.value) throw new Error("현재 실행의 포장 기준을 확인한 뒤 저장하세요.");
    const selectedRun = runId.value;
    const updates = draftRows().map(draft => {
      const row = preparationPlan.rows.find(item => item.skuCode === draft.skuCode);
      return { ...draft, expectedUnitsPerCarton: row.masterUnitsPerCarton, expectedUpdatedAt: row.masterUpdatedAt };
    });
    const saved = await postContextTool("save_product_carton_units", { runId: selectedRun, confirmed: true, updates });
    if (runId.value !== selectedRun) return;
    ++preparationSequence;
    document.querySelector("#dataSource").value = "auto";
    unitDrafts.clear(); unitsConfirmation.checked = false;
    preparationPlan = saved; renderPreparation(saved);
    cartonReviewChecks.clear();
    preparationMessage.textContent = `${saved.message} 변경된 기준으로 자동 대조했습니다. 남은 예외만 보완하세요.`;
  } catch (error) { preparationMessage.textContent = error.message; }
  finally { setPreparationBusy(false); syncPreparationControls(); }
});
async function reviewRegistration(input) {
  const drafts = preparationPlan?.runId === input.runId ? draftRows() : [];
  const plan = await postContextTool("preview_logen_registration", { ...input, ...(drafts.length ? { draftUnits: drafts } : {}) });
  document.querySelector("#registrationPreviewSummary").textContent = `${plan.runId} · 신규 ${plan.pendingBatchCount}건 / ${plan.pendingCartonCount}카톤 · 기존 등록 ${plan.rows.filter(row => !row.pendingRegistration).length}건 유지`;
  const sender = plan.sender;
  document.querySelector("#registrationParties").textContent = [
    sender ? `송하인: ${sender.name} · ${sender.telephone}\n${sender.address}\n거래처코드 ${sender.customerCode} · 운임 ${sender.deliveryFare} (${sender.fareType})` : "송하인 정보 확인 필요",
    ...plan.rows.map(row => `${row.orderNo} 수취: ${row.recipient ? `${row.recipient.name} · ${row.recipient.telephone}\n${row.recipient.address}` : "정보 확인 필요"}`)
  ].join("\n\n");
  document.querySelector("#registrationPreviewRows").innerHTML = plan.rows.map(row => `<tr><td>${planText(row.orderNo)} / ${planText(row.skuCode)}<small>${planText(row.skuName)}</small></td><td>${row.orderedQuantity}개 / ${row.unitsPerCarton ?? "미정"}개입<small>${unitSourceLabels[row.source]}</small></td><td>${row.cartonCount}카톤</td><td>${planText(registrationLabels[row.registrationStatus] ?? row.registrationStatus)}</td></tr>`).join("");
  showPlanIssues(document.querySelector("#registrationPreviewIssues"), [...plan.issues, ...(drafts.length && !plan.issues.some(issue => issue.includes("아직 저장되지")) ? ["입력값을 포장 기준으로 저장한 뒤 미리보기를 다시 확인하세요."] : [])]);
  const confirmButton = document.querySelector("#confirmRegistrationPreview");
  confirmButton.textContent = plan.pendingBatchCount ? `확인한 ${plan.pendingBatchCount}건 등록` : "추가 등록할 건 없음";
  confirmButton.disabled = !plan.ready || !plan.pendingBatchCount || Boolean(drafts.length);
  document.querySelector("#cancelRegistrationPreview").disabled = false;
  registrationDialog.returnValue = "cancel";
  registrationDialog.showModal();
  const accepted = await new Promise(resolve => registrationDialog.addEventListener("close", () => resolve(registrationDialog.returnValue === "register"), { once: true }));
  return accepted ? { ...input, reviewToken: plan.reviewToken } : undefined;
}
document.querySelector("#cancelRegistrationPreview").addEventListener("click", () => registrationDialog.close("cancel"));
document.querySelector("#confirmRegistrationPreview").addEventListener("click", () => registrationDialog.close("register"));
document.querySelector("#previewRegistration").addEventListener("click", () => void call("register_logen_delivery_order", flow.querySelector('[data-tool="register_logen_delivery_order"]')));
for (const selector of ["#dataSource", "#logenMethod", "#runId"]) document.querySelector(selector).addEventListener("change", () => void refreshPreparation(true));

for (const group of workflowGroups.filter(group => group.from > 1)) {
  const section = document.createElement("article");
  section.id = `group-${group.id}`;
  section.className = "workflow-group";
  section.setAttribute("aria-labelledby", `group-title-${group.id}`);
  section.innerHTML = `<div class="prepare-group-head"><div><span class="group-label">${group.number} · ${group.from}~${group.through}단계</span><h3 id="group-title-${group.id}">${group.name}</h3><p>${group.description}</p></div><button type="button" data-group-run="${group.id}">${group.from}~${group.through} 이어서 실행</button></div>
    <p id="group-summary-${group.id}" class="group-summary" aria-live="polite">실행 기록을 확인하는 중입니다.</p>
    <ul id="checklist-${group.id}" class="group-checklist" aria-label="${group.name} 단계별 상태"></ul>
    <p class="group-review-note">${group.note}</p>
    <details class="prepare-details" id="details-${group.id}"><summary>${group.from}~${group.through} 세부 단계·이력 펼치기</summary><div class="flow" id="stages-${group.id}"></div></details>`;
  remainingFlow.append(section);
}
const documentsGroup = document.querySelector("#group-documents");
const orderReviewCheckpoint = document.querySelector(".review-checkpoint");
documentsGroup.insertBefore(orderReviewCheckpoint, documentsGroup.querySelector(".group-summary"));
for (const group of workflowGroups) {
  document.querySelector(`#checklist-${group.id}`).innerHTML = definitions.filter(([number]) => number >= group.from && number <= group.through).map(([number, name]) =>
    `<li data-check-stage="${number}" data-state="waiting"><span class="step-indicator" aria-hidden="true">${number}</span><span>${checklistLabels[number] || name}</span><span class="step-state">대기</span></li>`).join("");
}
for (const [number, name, tool, shipping, agent] of definitions) {
  const card = document.createElement("article");
  card.className = `stage${shipping ? " shipping" : ""}`;
  card.dataset.stage = String(number);
  const stageNumber = String(number).padStart(2, "0");
  const resetLabel = number === 13 ? "등록키+이력 초기화" : "이력 초기화";
  card.innerHTML = `<span class="number">${stageNumber}</span><div class="name">${name}</div><div class="agent">${agent}</div><div class="tool">${tool}</div><p class="stage-status" aria-live="polite">대기</p>${number === 15 ? '<button type="button" class="secondary-action" data-tool="prepare_supplierhub_shipment_tracking">준비 테스트</button>' : ''}<button data-tool="${tool}">${number === 15 ? '실제 등록' : '이 단계 실행'}</button><button type="button" class="secondary-action" data-stage-reset="${number}">${resetLabel}</button>${number === 14 ? '<button type="button" class="secondary-action" data-waybill-confirm>송장번호 확인</button>' : ''}`;
  const group = workflowGroups.find(group => number >= group.from && number <= group.through);
  (number <= 6 ? preparationFlow : document.querySelector(`#stages-${group.id}`)).append(card);
}
if (isBeginner) {
  document.querySelector("#experienceTitle").textContent = "발주·배송 초보자용";
  document.querySelector("#experienceDescription").textContent = "재고를 확인하고, 지금 할 일의 버튼을 따라 진행하세요.";
  document.querySelector("#beginnerCartonArea").append(document.querySelector("section.preparation"));
  document.querySelector("#beginnerQueryFields").append(document.querySelector("#settings-stage-02 .setting-fields"));
  document.querySelector("#beginnerOrderSelection").append(document.querySelector("#settings-stage-04 .setting-fields"));
  document.querySelector("#beginnerDispatchFields").append(document.querySelector("#settings-stage-15 .setting-fields"));
  const runLabel = recentRunId.closest("label");
  runLabel.firstChild.textContent = "이어할 작업 ";
  document.querySelector("#useRunId").textContent = "이 작업 선택";
  document.querySelector("#refreshContexts").textContent = "목록 새로고침";
  document.querySelector("#beginnerRunSelection").append(runLabel, document.querySelector("#useRunId"), document.querySelector("#refreshContexts"));
  orderReviewCheckpoint.hidden = true;
  document.querySelector(".beginner-current").insertBefore(orderReviewCheckpoint, document.querySelector("#beginnerPrimary"));
  for (const element of document.querySelectorAll("[data-beginner-tool]")) element.hidden = false;
  document.querySelector("#floatingPanelTitle").textContent = "작업 도구 · 초보자용";
} else {
  document.querySelector("#group-logen").insertBefore(document.querySelector("section.preparation"), document.querySelector("#details-logen"));
}
for (const link of document.querySelectorAll("[data-experience-link]")) {
  if (link.dataset.experienceLink === document.body.dataset.experience) link.setAttribute("aria-current", "page");
  link.addEventListener("click", event => {
    syncExperienceLinks();
    if (preparationBusy || workflowRecorder?.state === "recording") {
      event.preventDefault();
      summary.textContent = "진행 중인 실행 또는 녹화를 마친 뒤 화면을 전환하세요.";
    }
  });
}
syncGroupProgress();

function syncExperienceLinks() {
  if (freshStart && runId.value) {
    freshStart = false;
    const current = new URL(location.href);
    current.searchParams.delete("fresh");
    current.searchParams.set("runId", runId.value);
    if (scanId.value) current.searchParams.set("scanId", scanId.value);
    history.replaceState(null, "", current);
  }
  const params = new URLSearchParams();
  if (freshStart) params.set("fresh", "1");
  for (const id of navigationFields) { const value = document.getElementById(id).value; if (value) params.set(id, value); }
  for (const link of document.querySelectorAll("[data-experience-link]")) link.href = `/fulfillment/${link.dataset.experienceLink}?${params}`;
}

function nextBeginnerAction() {
  if (!dashboardReady) return { kind: "wait", title: "현재 작업을 불러오는 중입니다", help: "잠시 후 이어할 작업을 안내합니다.", label: "불러오는 중…" };
  if (!runId.value && selectionNotice) return { kind: "resume", title: "기존 작업을 확인하세요", help: "새로 배정할 발주가 없습니다. 기존 작업의 발주 건수와 대상을 확인해 이어가거나, 조회 기간을 바꿔 새 발주를 불러오세요.", label: "기존 작업 목록 보기", group: "prepare" };
  if (!runId.value) return { kind: "run", from: 1, through: 6, title: "처리할 발주를 불러오세요", help: "조회 기간에 해당하는 발주를 불러오고 확정수량 작성까지 준비합니다.", label: "발주 불러오기", group: "prepare" };
  if (monitoredRun?.id !== runId.value) return { kind: "wait", title: "선택한 작업을 확인하는 중입니다", help: "현재 상태 새로 확인을 눌러 진행 기록을 불러올 수 있습니다.", label: "작업 확인 중…" };
  const stages = monitoredRun.stages ?? [];
  const done = number => stages.some(stage => stage.stage === number && stage.status === "completed");
  const uncertain = stages.find(stage => [7, 13, 15].includes(stage.stage) && ["unknown", "partial"].includes(stage.status));
  if (uncertain) return { kind: "expert", title: "이전 처리 결과를 확인해야 합니다", help: `${uncertain.stage}단계 결과가 확정되지 않았습니다. 전문가용에서 기존 등록 이력을 확인하세요.`, label: "전문가용에서 결과 확인" };
  if (["completed", "released"].includes(monitoredRun.status)) return { kind: "done", title: "이 작업은 마무리되었습니다", help: "새 발주는 아래 ‘새 발주 준비’에서 불러오세요.", label: "작업 마무리됨" };
  if (![5, 6].every(done)) return { kind: "run", from: 5, through: 6, group: "prepare", title: "발주서 확정 준비를 마치세요", help: "확정 양식을 준비하고 수량을 작성합니다. 다음 화면에서 품목과 수량을 검토합니다.", label: "발주 준비 이어하기" };
  if (![7, 8, 9, 10].every(done)) return { kind: "run", from: 7, through: 10, group: "documents", title: "발주를 확인하고 발주서를 인쇄하세요", help: "검토 화면에서 품목과 수량을 확인하면 발주확정과 발주서 인쇄를 이어갑니다.", label: "검토 후 발주확정·인쇄" };
  if (!done(13) && preparationPlan?.runId === runId.value && preparationPlan.rows.some(row => !row.cartonReviewConfirmed)) return { kind: "carton", group: "logen", title: "배송 수량의 예외를 보완하세요", help: "발주서는 자동으로 대조했습니다. 아래에 표시된 누락 또는 불일치 품목만 확인하면 됩니다.", label: "예외 수량 보완하기" };
  if (stages.some(stage => stage.stage === 14 && stage.status === "unknown")) return { kind: "waybill", group: "logen", title: "출력된 송장번호를 확인하세요", help: "확인 화면에서 사용할 송장번호를 선택하면 다음 작업을 이어갈 수 있습니다.", label: "송장번호 확인" };
  if (![11, 12, 13, 14].every(done)) return { kind: "run", from: 11, through: 14, group: "logen", title: "배송을 등록하고 송장을 출력하세요", help: "카톤 수량은 자동으로 확인합니다. 등록 미리보기에서 배송 내용을 확인한 뒤 진행합니다.", label: "배송 등록·송장 출력" };
  if (![15, 16].every(done)) return { kind: "run", from: 15, through: 16, group: "inbound", title: "입고 등록과 마무리 문서를 준비하세요", help: "발송 날짜와 시간을 확인하세요. 확정된 송장번호로 입고를 등록하고 필요한 문서를 출력합니다.", label: "입고 등록·문서 출력" };
  return { kind: "done", title: "모든 작업을 마쳤습니다", help: "출력된 송장과 입고 문서를 확인하세요. 새 발주는 아래에서 시작할 수 있습니다.", label: "작업 완료" };
}

function syncBeginner() {
  syncExperienceLinks();
  if (!isBeginner) return;
  const stock = document.querySelector("#beginnerStockChecked");
  const key = `supplierhub-stock:${new Date().toLocaleDateString("ko-KR")}:${runId.value || "new"}`;
  if (key !== stockContextKey) {
    stockContextKey = key;
    try { stock.checked = sessionStorage.getItem(key) === "checked"; } catch { stock.checked = false; }
  }
  stock.disabled = preparationBusy;
  beginnerAction = nextBeginnerAction();
  const action = beginnerAction;
  const primary = document.querySelector("#beginnerPrimary");
  panelText("beginnerTaskTitle", preparationBusy ? "작업을 진행하고 있습니다" : action.title);
  panelText("beginnerTaskHelp", preparationBusy ? "검토 화면이 열리면 내용을 확인하세요. 현재 단계가 끝난 뒤 멈출 수도 있습니다." : action.help);
  panelText("beginnerTaskState", preparationBusy ? "진행 중" : action.kind === "done" ? "완료" : ["carton", "expert", "waybill"].includes(action.kind) ? "확인 필요" : "다음 작업");
  if (!preparationBusy) primary.textContent = action.kind === "run" && !stock.checked ? "먼저 위에서 재고 확인을 체크하세요" : action.label;
  primary.disabled = preparationBusy || ["wait", "done"].includes(action.kind) || (action.kind === "run" && !stock.checked);
  document.querySelector("#beginnerNewRun").disabled = preparationBusy || !dashboardReady || !stock.checked;
  document.querySelector("#floatingCurrentStep").disabled = primary.disabled;
  panelText("floatingCurrentStep", action.kind === "carton" ? "수량 예외 확인" : action.kind === "waybill" ? "송장번호 확인" : action.kind === "expert" ? "전문가용 확인" : "현재 작업 실행");
  orderReviewCheckpoint.hidden = action.group !== "documents";
  const resetLocked = preparationBusy || !dashboardReady || workflowRecorder?.state === "recording" || Boolean(document.querySelector("dialog[open]"));
  for (const button of document.querySelectorAll("[data-beginner-reset]")) button.disabled = resetLocked;
  panelText("beginnerMonitoring", monitoringError || (monitoringCheckedAt ? `최근 상태 확인 ${monitoringCheckedAt}` : "현재 상태 확인 대기"));
  const run = monitoredRun?.id === runId.value ? monitoredRun : undefined;
  panelText("beginnerOrderSummary", run?.orders?.length ? `선택한 발주 ${run.orders.length}건 · ${run.orders.reduce((sum, order) => sum + (order.items?.length ?? 0), 0)}개 품목\n${run.orders.map(order => `${order.orderNo} · ${order.centerName} · 입고예정 ${order.expectedInboundDate || "미정"}`).join("\n")}` : "");
  document.querySelector("#beginnerCartonArea").hidden = !run || !run.stages?.some(stage => stage.stage === 8 && stage.status === "completed") || !["logen", "inbound"].includes(action.group);
  document.querySelector("#beginnerDispatch").hidden = action.group !== "inbound";
  for (const group of workflowGroups) {
    const pill = document.querySelector(`[data-beginner-group="${group.id}"]`);
    const numbers = Array.from({ length: group.through - Math.max(group.from, 4) + 1 }, (_, index) => index + Math.max(group.from, 4));
    const complete = run && numbers.every(number => run.stages?.some(stage => stage.stage === number && stage.status === "completed"));
    pill.dataset.state = complete ? "completed" : group.id === action.group ? "current" : "waiting";
    if (group.id === action.group) pill.setAttribute("aria-current", "step"); else pill.removeAttribute("aria-current");
  }
}

document.querySelector("#beginnerStockChecked").addEventListener("change", event => {
  try { sessionStorage.setItem(stockContextKey, event.target.checked ? "checked" : ""); } catch {}
  syncBeginner();
});
document.querySelector("#beginnerPrimary").addEventListener("click", async event => {
  syncBeginner();
  if (event.currentTarget.disabled) return;
  const action = beginnerAction;
  if (action.kind === "run") await runStageRange(event.currentTarget, action.from, action.through);
  else if (action.kind === "resume") await showExistingWork();
  else if (action.kind === "carton") {
    document.querySelector("#beginnerCartonArea").scrollIntoView({ block: "start" });
    document.querySelector('#preparationRows input:not(:disabled)')?.focus({ preventScroll: true });
  } else if (action.kind === "waybill") await openWaybillConfirmation();
  else if (action.kind === "expert") document.querySelector('[data-experience-link="expert"]').click();
});
document.querySelector("#beginnerNewRun").addEventListener("click", event => {
  if (document.querySelector("#beginnerStockChecked").checked) void runStageRange(event.currentTarget, 1, 6);
});
document.querySelector("#showBeginnerTools").addEventListener("click", () => {
  setFloatingCollapsed(false);
  document.querySelector("#recordWorkflow").focus({ preventScroll: true });
});
document.querySelector("#floatingCurrentStep").addEventListener("click", () => document.querySelector("#beginnerPrimary").click());
for (const button of document.querySelectorAll("[data-beginner-reset]")) button.addEventListener("click", resetBeginnerWorkspace);

function resetBeginnerWorkspace() {
  runReadRevision++;
  if (!isBeginner || preparationBusy || !dashboardReady || workflowRecorder?.state === "recording" || document.querySelector("dialog[open]")) return;
  const newStockKey = `supplierhub-stock:${new Date().toLocaleDateString("ko-KR")}:new`;
  try { if (stockContextKey) sessionStorage.removeItem(stockContextKey); sessionStorage.removeItem(newStockKey); } catch {}
  freshStart = true;
  selectionNotice = false;
  ++preparationSequence;
  for (const id of ["runId", "scanId", "dateFrom", "dateTo", "targetOrderNos", "shipmentShipDate", "shipmentShipTime"]) document.getElementById(id).value = "";
  document.querySelector("#lookAheadDays").value = "7";
  dateSearchType.value = "expected_inbound_date";
  document.querySelector("#dataSource").value = "auto";
  updateDateSearchType();
  recentRunId.value = ""; recentScanId.value = "";
  unitDrafts.clear(); cartonReviewNotes.clear(); cartonReviewChecks.clear();
  unitsConfirmation.checked = false;
  document.querySelector("#beginnerStockChecked").checked = false;
  document.querySelector("#reviewOrdersChecked").checked = false;
  document.querySelector("#reviewQuantitiesChecked").checked = false;
  orderReviewReady = false; waybillConfirmationContext = [];
  monitoredRun = undefined; preparationPlan = undefined;
  monitoringError = ""; monitoringCheckedAt = ""; stockContextKey = undefined;
  stageRecordStage.replaceChildren(new Option("Run을 선택한 뒤 불러오세요", ""));
  for (const card of flow.querySelectorAll(".stage")) {
    card.dataset.status = "waiting";
    card.classList.remove("running", "completed", "failed");
    card.querySelector(".stage-status").textContent = "대기";
    for (const button of card.querySelectorAll("button")) { delete button.dataset.locked; button.disabled = false; }
  }
  summary.classList.remove("error");
  summary.textContent = "화면을 초기화했습니다. 기존 발주·등록·인쇄 이력은 유지됩니다.";
  result.textContent = "{}";
  contextStatus.textContent = "선택한 작업을 비웠습니다. 이전 작업은 목록에서 다시 선택할 수 있습니다.";
  preparationMessage.textContent = "새 발주를 준비하면 카톤 입수수량을 자동으로 확인합니다.";
  panelText("beginnerResetStatus", "새로 시작할 준비가 됐습니다. 이전 작업은 ‘다른 작업 이어하기’에서 다시 선택할 수 있습니다.");
  const cleanUrl = new URL(location.href);
  cleanUrl.search = ""; cleanUrl.searchParams.set("fresh", "1"); cleanUrl.hash = "";
  history.replaceState(null, "", cleanUrl);
  renderOrderReviewSummary(); renderPreparation(); syncFloatingPanel();
  document.querySelector("#beginnerQuery").open = true;
  document.querySelector("#beginnerStockChecked").focus({ preventScroll: true });
  window.scrollTo({ top: 0, behavior: "instant" });
}

function syncGroupProgress() {
  const labels = { completed: "완료", running: "진행 중", failed: "실패", blocked: "확인 필요", unknown: "결과 확인", partial: "부분 완료", waiting: "대기", unrecorded: "개별 기록 없음" };
  for (const group of workflowGroups) {
    const states = [];
    for (let number = group.from; number <= group.through; number++) {
      const card = flow.querySelector(`.stage[data-stage="${number}"]`);
      const row = document.querySelector(`[data-check-stage="${number}"]`);
      if (!card || !row) continue;
      const state = card.classList.contains("running") ? "running" : card.dataset.status || (card.classList.contains("completed") ? "completed" : card.classList.contains("failed") ? "failed" : "waiting");
      states.push(state);
      row.dataset.state = state;
      row.querySelector(".step-indicator").textContent = state === "completed" ? "✓" : state === "running" ? "…" : ["blocked", "failed", "unknown", "partial"].includes(state) ? "!" : String(number);
      row.querySelector(".step-state").textContent = labels[state] || "대기";
      row.title = card.querySelector(".stage-status")?.textContent || "";
    }
    if (group.from === 1) continue;
    const completeCount = states.filter(state => state === "completed").length;
    const complete = states.length === group.through - group.from + 1 && completeCount === states.length;
    const state = states.includes("running") ? "running" : states.find(state => ["failed", "blocked", "unknown", "partial"].includes(state)) || (complete ? "completed" : "waiting");
    const status = document.querySelector(`#group-summary-${group.id}`);
    const button = document.querySelector(`[data-group-run="${group.id}"]`);
    if (status) {
      status.dataset.state = state;
      status.textContent = `${completeCount}/${group.through - group.from + 1}단계 완료 · ${complete ? "이 묶음 완료" : state === "waiting" ? "현재 실행에서 이어서 진행" : labels[state]}`;
    }
    if (button) {
      button.disabled = preparationBusy || !runId.value || complete;
      if (!preparationBusy) button.textContent = complete ? "완료 · 세부 이력 확인" : `${group.from}~${group.through} 이어서 실행`;
    }
  }
  syncFloatingPanel();
}

function panelText(id, value) {
  const element = document.getElementById(id);
  if (element.textContent !== value) element.textContent = value;
}
function syncFloatingPanel() {
  syncBeginner();
  panelText("floatingRunId", runId.value || "선택되지 않음");
  const stageCards = [...flow.querySelectorAll(".stage[data-stage]")];
  const completed = stageCards.filter(card => card.dataset.status === "completed").length;
  const trackedCount = stageCards.filter(card => card.dataset.status !== "unrecorded").length;
  const running = stageCards.find(card => card.classList.contains("running"));
  const needsAttention = stageCards.find(card => ["blocked", "failed", "unknown", "partial"].includes(card.dataset.status));
  const review = [...document.querySelectorAll("dialog[open]")].at(-1);
  panelText("floatingProgressText", `완료 ${completed}단계`);
  document.querySelector("#floatingProgress").max = trackedCount || 16;
  document.querySelector("#floatingProgress").value = completed;
  let message = !runId.value ? "현재 실행을 선택하거나 전체 실행으로 시작하세요." : completed === trackedCount ? "기록된 모든 단계가 완료됐습니다." : "선택한 실행의 상태를 확인합니다.";
  if (review) message = `검토 대기 · ${review.querySelector("h2")?.textContent || "내용을 확인하세요."}`;
  else if (running) message = `${running.dataset.stage}단계 진행 중 · ${running.querySelector(".name")?.textContent}`;
  else if (needsAttention) message = `${needsAttention.dataset.stage}단계 확인 필요 · ${needsAttention.querySelector(".name")?.textContent}`;
  else if (monitoredRun?.id === runId.value) message = `현재 ${monitoredRun.currentStage || 0}단계 · ${monitoredRun.status === "completed" ? "실행 완료" : "다음 작업 대기"}`;
  if (pauseRequested) message = review ? "검토를 취소하고 연속 실행을 멈추는 중입니다." : "현재 요청이 끝나면 다음 단계 전에 멈춥니다.";
  panelText("floatingStage", message);
  panelText("floatingMonitorState", monitoringError ? "연결 확인 필요" : floatingSettings.monitoring ? "5초 모니터링" : "모니터링 꺼짐");
  panelText("floatingUpdated", monitoringError || (monitoringCheckedAt ? `마지막 확인 ${monitoringCheckedAt}` : "실행 기록 확인 대기"));
  const isRecording = workflowRecorder?.state === "recording";
  const elapsed = isRecording ? Math.max(0, Math.floor((Date.now() - workflowRecordingStartedAt.getTime()) / 1000)) : 0;
  const duration = `${String(Math.floor(elapsed / 60)).padStart(2, "0")}:${String(elapsed % 60).padStart(2, "0")}`;
  panelText("floatingRecording", isRecording ? `● 녹화 중 ${duration}` : "녹화 대기");
  document.querySelector("#floatingRecording").classList.toggle("active", isRecording);
  floatingFullRun.disabled = preparationBusy || !dashboardReady || (isBeginner && (Boolean(review) || !document.querySelector("#beginnerStockChecked").checked || ["wait", "done", "expert", "resume"].includes(beginnerAction?.kind)));
  if (isBeginner && review) document.querySelector("#floatingCurrentStep").disabled = true;
  if (!preparationBusy) floatingFullRun.textContent = "전체 실행";
  document.querySelector("#readRun").disabled = monitoringBusy || !runId.value;
  document.querySelector("#floatingResetHistory").disabled = preparationBusy || Boolean(activeRange) || Boolean(review) || !runId.value || Boolean(running);
  const monitorButton = document.querySelector("#toggleRunMonitoring");
  monitorButton.textContent = floatingSettings.monitoring ? "모니터링 켜짐" : "모니터링 꺼짐";
  monitorButton.setAttribute("aria-pressed", String(floatingSettings.monitoring));
  pauseWorkflow.disabled = !activeRange || pauseRequested;
  document.querySelector("#prepareWorkspaceWindows").disabled = preparationBusy || Boolean(review);
  pauseWorkflow.textContent = pauseRequested ? "멈춤 예약됨" : "다음 단계 전 멈춤";
}
async function refreshFloatingRun(showResult = false) {
  const selectedRun = runId.value.trim();
  if (!selectedRun || monitoringBusy || preparationBusy) { syncFloatingPanel(); return; }
  const revision = runReadRevision;
  monitoringBusy = true;
  syncFloatingPanel();
  try {
    const payload = await api.postTool("get_fulfillment_run", { runId: selectedRun }, {
      signal: AbortSignal.timeout(8000),
    });
    if (runId.value !== selectedRun || payload.id !== selectedRun || revision !== runReadRevision) return;
    monitoredRun = payload;
    monitoringError = "";
    monitoringCheckedAt = new Date().toLocaleTimeString("ko-KR", { hour12: false });
    if (!preparationBusy && !document.querySelector("dialog[open]")) renderRunStages(payload);
    if (showResult) {
      result.textContent = JSON.stringify(payload, null, 2);
      if (!preparationBusy) {
        summary.classList.remove("error");
        summary.textContent = `${selectedRun}의 현재 실행 기록을 확인했습니다.`;
      }
    }
  } catch (error) {
    if (runId.value === selectedRun && revision === runReadRevision) monitoringError = `상태 확인 실패 · ${error.name === "TimeoutError" ? "응답 시간 초과" : error.message}`;
  } finally {
    monitoringBusy = false;
    syncFloatingPanel();
  }
}
function saveFloatingSettings() {
  try { localStorage.setItem(floatingSettingsKey, JSON.stringify(floatingSettings)); } catch { /* Position remains usable for this page. */ }
}
function placeFloatingPanel(x, y) {
  if (floatingPanel.classList.contains("in-review")) return;
  const bounds = floatingPanel.getBoundingClientRect();
  const left = Math.max(12, Math.min(x, innerWidth - bounds.width - 12));
  const top = Math.max(12, Math.min(y, innerHeight - bounds.height - 12));
  Object.assign(floatingPanel.style, { left: `${left}px`, top: `${top}px`, right: "auto", bottom: "auto" });
  floatingSettings.x = left;
  floatingSettings.y = top;
}
function setFloatingCollapsed(collapsed) {
  floatingSettings.collapsed = collapsed;
  floatingBody.hidden = collapsed;
  floatingPanel.classList.toggle("is-collapsed", collapsed);
  if (isBeginner) document.body.classList.toggle("work-tools-collapsed", collapsed);
  const button = document.querySelector("#collapseFloatingPanel");
  button.textContent = collapsed ? "펼치기" : "접기";
  button.setAttribute("aria-expanded", String(!collapsed));
  floatingPanel.closest("dialog")?.classList.toggle("tools-collapsed", collapsed);
  if (floatingSettings.x !== null && floatingSettings.y !== null) placeFloatingPanel(floatingSettings.x, floatingSettings.y);
  saveFloatingSettings();
}
function syncFloatingDialog() {
  const dialog = [...document.querySelectorAll("dialog[open]")].at(-1);
  for (const item of document.querySelectorAll("dialog.has-floating-tools")) {
    if (item !== dialog) item.classList.remove("has-floating-tools", "tools-collapsed");
  }
  const parent = dialog || document.body;
  if (floatingPanel.parentElement !== parent) parent.append(floatingPanel);
  floatingPanel.classList.toggle("in-review", Boolean(dialog));
  if (dialog) {
    dialog.classList.add("has-floating-tools");
    dialog.classList.toggle("tools-collapsed", floatingSettings.collapsed);
  }
  syncFloatingPanel();
}
const floatingHandle = document.querySelector("#floatingDragHandle");
floatingHandle.addEventListener("pointerdown", event => {
  if (event.button !== 0 || floatingPanel.classList.contains("in-review")) return;
  const bounds = floatingPanel.getBoundingClientRect();
  floatingDrag = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, left: bounds.left, top: bounds.top };
  floatingHandle.setPointerCapture(event.pointerId);
  event.preventDefault();
});
floatingHandle.addEventListener("pointermove", event => {
  if (floatingDrag?.pointerId !== event.pointerId) return;
  placeFloatingPanel(floatingDrag.left + event.clientX - floatingDrag.x, floatingDrag.top + event.clientY - floatingDrag.y);
});
for (const eventName of ["pointerup", "pointercancel"]) floatingHandle.addEventListener(eventName, event => {
  if (floatingDrag?.pointerId !== event.pointerId) return;
  floatingDrag = undefined;
  if (floatingHandle.hasPointerCapture(event.pointerId)) floatingHandle.releasePointerCapture(event.pointerId);
  saveFloatingSettings();
});
floatingHandle.addEventListener("keydown", event => {
  const movement = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
  if (!movement || floatingPanel.classList.contains("in-review")) return;
  event.preventDefault();
  const bounds = floatingPanel.getBoundingClientRect(), distance = event.shiftKey ? 40 : 12;
  placeFloatingPanel(bounds.left + movement[0] * distance, bounds.top + movement[1] * distance);
  saveFloatingSettings();
});
document.querySelector("#collapseFloatingPanel").addEventListener("click", () => setFloatingCollapsed(!floatingSettings.collapsed));
document.querySelector("#resetFloatingPanel").addEventListener("click", () => {
  Object.assign(floatingPanel.style, { left: "", top: "", right: "", bottom: "" });
  floatingSettings.x = null; floatingSettings.y = null; saveFloatingSettings();
});
document.querySelector("#toggleRunMonitoring").addEventListener("click", () => {
  floatingSettings.monitoring = !floatingSettings.monitoring;
  saveFloatingSettings(); syncFloatingPanel();
  if (floatingSettings.monitoring) void refreshFloatingRun();
});
pauseWorkflow.addEventListener("click", () => {
  if (!activeRange) return;
  pauseRequested = true;
  for (const dialog of document.querySelectorAll("dialog[open]")) dialog.close("cancel");
  syncFloatingPanel();
});
floatingFullRun.addEventListener("click", () => {
  if (isBeginner && !document.querySelector("#beginnerStockChecked").checked) return;
  void runStageRange(floatingFullRun, runId.value ? 5 : 1, 16, { full: true });
});
addEventListener("resize", () => {
  if (floatingSettings.x !== null && floatingSettings.y !== null) placeFloatingPanel(floatingSettings.x, floatingSettings.y);
});
const floatingDialogObserver = new MutationObserver(changes => {
  if (changes.some(change => change.target instanceof HTMLDialogElement)) syncFloatingDialog();
});
floatingDialogObserver.observe(document.body, { subtree: true, attributes: true, attributeFilter: ["open"] });
setFloatingCollapsed(floatingSettings.collapsed);
if (floatingSettings.x !== null && floatingSettings.y !== null) placeFloatingPanel(floatingSettings.x, floatingSettings.y);
const monitoringTimer = setInterval(() => { if (floatingSettings.monitoring) void refreshFloatingRun(); }, 5000);
addEventListener("pagehide", () => { clearInterval(monitoringTimer); floatingDialogObserver.disconnect(); });

async function loadCurrentRun() {
  const selectedRun = requiredId(runId, "Run ID", 4);
  const payload = await api.postTool("get_fulfillment_run", { runId: selectedRun });
  if (selectedRun !== runId.value || payload.id !== selectedRun) throw new Error("선택 작업이 바뀌었습니다. 현재 작업에서 다시 확인하세요.");
  if (payload.id === runId.value) syncShipmentSchedule(payload);
  return payload;
}

function renderOrderReviewSummary(run) {
  const stage6 = run?.stages?.find(item => item.stage === 6);
  const jobs = run?.orderConfirmationJobs ?? [];
  const complete = jobs.length > 0 && jobs.every(job => job.status === "confirmed");
  const files = [...new Map(jobs.filter(job => job.preparedFilePath).map(job => [job.preparedFilePath, job])).values()];
  document.querySelector("#orderReviewSummary").textContent = run
    ? `${run.id} · 선택 발주 ${run.orders?.length ?? 0}건 · ${complete ? "발주확정 완료 · 기존 이력 확인 가능" : stage6?.status === "completed" ? "준비 완료 · 눈으로 검토한 뒤 7단계를 실행하세요." : "1~6 준비 완료 후 검토하세요."}`
    : "선택 발주·물류센터·입고예정일과 준비된 엑셀의 확정수량을 확인합니다.";
  document.querySelector("#prepareGroupStatus").textContent = stage6?.status === "completed"
    ? `1~6 준비 완료 · ${complete ? "발주확정 완료" : "검토 대기"}`
    : "6단계까지 준비한 뒤 검토를 기다립니다. 7단계 업로드는 별도로 실행합니다.";
  document.querySelector("#preparedOrderFiles").innerHTML = files.length
    ? files.map(job => `<div class="review-file"><strong>${planText(job.preparedFileName || "발주확정 엑셀")}</strong><span>발주 ${planText(job.orderNo)}</span><code>${planText(job.preparedFilePath)}</code><button type="button" data-open-prepared-order="${planText(job.orderNo)}" data-open-prepared-run="${planText(run.id)}" data-open-prepared-path="${planText(job.preparedFilePath)}">엑셀 열기</button></div>`).join("")
    : '<p class="dialog-help">1~6단계를 완료하면 준비된 발주확정 엑셀이 여기에 표시됩니다.</p>';
  document.querySelector("#preparedOrderFileMessage").textContent = files.length
    ? `준비 파일 ${files.length}개 · 파일을 열어도 발주확정은 실행되지 않습니다.`
    : "파일 열기만으로 발주확정은 실행되지 않습니다.";
}
function confirmationReviewIdentity(run) {
  return JSON.stringify({ id: run.id, status: run.status, orders: run.orders,
    jobs: run.orderConfirmationJobs, stage6: run.stages?.find(item => item.stage === 6) });
}
function syncOrderReviewAcceptance() {
  document.querySelector("#acceptOrderReview").disabled = !orderReviewReady ||
    !document.querySelector("#reviewOrdersChecked").checked || !document.querySelector("#reviewQuantitiesChecked").checked;
}
async function reviewOrderConfirmation(input) {
  const run = await postContextTool("get_fulfillment_run", { runId: input.runId });
  if (run.id !== runId.value) throw new Error("선택 실행이 바뀌었습니다. 현재 실행에서 검토 화면을 다시 여세요.");
  renderOrderReviewSummary(run);
  const jobs = run.orderConfirmationJobs ?? [];
  const pending = jobs.filter(job => job.status !== "confirmed");
  const issues = [];
  if (!run.orders?.length) issues.push("선택한 발주가 없습니다. 먼저 1~6 준비를 실행하세요.");
  if (!run.stages?.some(stage => stage.stage === 6 && stage.status === "completed")) issues.push("6단계 확정수량 작성을 완료한 뒤 검토하세요.");
  if (run.orders?.some(order => !jobs.some(job => job.orderNo === order.orderNo))) issues.push("확정 준비 기록이 없는 발주가 있습니다. 5~6단계를 확인하세요.");
  if (pending.some(job => !["prepared", "uploaded"].includes(job.status) || !job.preparedFilePath)) issues.push("준비되지 않았거나 결과가 불명확한 발주가 있습니다. 확정 준비 기록을 확인하세요.");
  if (["released", "completed"].includes(run.status)) issues.push("종료된 실행은 검토만 할 수 있습니다.");
  if (!pending.length) issues.push("새로 발주확정할 건이 없습니다. 기존 확정 이력을 유지합니다.");
  orderReviewReady = issues.length === 0;
  const stateLabels = { confirmed: "발주확정 완료", prepared: "엑셀 준비 완료", uploaded: "업로드 기록 있음", downloaded: "양식 다운로드", unknown: "결과 확인 필요", failed: "준비 실패", pending: "준비 대기" };
  document.querySelector("#confirmationReviewSummary").textContent = `${run.id} · 선택 ${run.orders?.length ?? 0}건 · 이번 확정 대상 ${pending.length}건`;
  document.querySelector("#confirmationReviewRows").innerHTML = (run.orders ?? []).map(order => {
    const job = jobs.find(item => item.orderNo === order.orderNo);
    const quantity = order.items?.length ? `${order.items.reduce((sum, item) => sum + item.orderedQuantity, 0)}개 · ${order.items.length}품목` : "준비된 엑셀에서 확인";
    return `<tr><td><strong>${planText(order.orderNo)}</strong></td><td>${planText(order.centerName)}<small>${planText(order.expectedInboundDate || "입고예정일 확인 필요")}</small></td><td>${planText(quantity)}</td><td>${planText(stateLabels[job?.status] ?? "준비 기록 없음")}</td></tr>`;
  }).join("");
  const files = [...new Map(jobs.filter(job => job.preparedFilePath).map(job => [job.preparedFilePath, job])).values()];
  document.querySelector("#confirmationReviewFiles").innerHTML = files.map(job => `<div class="review-file"><strong>${planText(job.preparedFileName || "발주확정 엑셀")}</strong><code>${planText(job.preparedFilePath)}</code><button type="button" data-open-review-order="${planText(job.orderNo)}" data-open-review-run="${planText(run.id)}" data-open-review-path="${planText(job.preparedFilePath)}">파일 열기</button></div>`).join("") || '<p class="dialog-help">준비된 엑셀 파일 기록이 없습니다.</p>';
  showPlanIssues(document.querySelector("#confirmationReviewIssues"), issues);
  document.querySelector("#confirmationReviewMessage").textContent = "";
  for (const id of ["reviewOrdersChecked", "reviewQuantitiesChecked"]) {
    document.getElementById(id).checked = false;
    document.getElementById(id).disabled = !orderReviewReady;
  }
  syncOrderReviewAcceptance();
  document.querySelector("#closeOrderReview").disabled = false;
  orderReviewDialog.returnValue = "cancel";
  orderReviewDialog.showModal();
  const accepted = await new Promise(resolve => orderReviewDialog.addEventListener("close", () => resolve(orderReviewDialog.returnValue === "confirm"), { once: true }));
  if (!accepted) return false;
  const current = await postContextTool("get_fulfillment_run", { runId: input.runId });
  if (runId.value !== input.runId || confirmationReviewIdentity(current) !== confirmationReviewIdentity(run)) {
    throw new Error("검토 중 발주 또는 준비 파일 기록이 변경됐습니다. 검토 화면에서 다시 확인하세요.");
  }
  return true;
}
for (const id of ["reviewOrdersChecked", "reviewQuantitiesChecked"]) document.getElementById(id).addEventListener("change", syncOrderReviewAcceptance);
document.querySelector("#closeOrderReview").addEventListener("click", () => orderReviewDialog.close("cancel"));
document.querySelector("#acceptOrderReview").addEventListener("click", () => orderReviewDialog.close("confirm"));
document.querySelector("#confirmationReviewFiles").addEventListener("click", async event => {
  const button = event.target.closest("[data-open-review-order]");
  if (!button || button.disabled) return;
  const message = document.querySelector("#confirmationReviewMessage");
  button.disabled = true;
  button.textContent = "여는 중…";
  message.style.color = "var(--muted)";
  message.textContent = "Windows 기본 앱으로 엑셀을 여는 중입니다…";
  try {
    if (button.dataset.openReviewRun !== runId.value) throw new Error("선택 실행이 바뀌었습니다. 검토 화면을 다시 여세요.");
    const payload = await postContextTool("open_order_confirmation_file", {
      runId: button.dataset.openReviewRun,
      orderNo: button.dataset.openReviewOrder,
      expectedFilePath: button.dataset.openReviewPath,
    });
    message.textContent = payload.message;
  } catch (error) {
    message.style.color = "var(--red)";
    message.textContent = error.message;
  } finally {
    button.disabled = false;
    button.textContent = "파일 열기";
  }
});
document.querySelector("#preparedOrderFiles").addEventListener("click", async event => {
  const button = event.target.closest("[data-open-prepared-order]");
  if (!button || button.disabled) return;
  const message = document.querySelector("#preparedOrderFileMessage");
  button.disabled = true;
  button.textContent = "여는 중…";
  message.textContent = "Windows 기본 앱으로 발주확정 엑셀을 여는 중입니다…";
  try {
    if (button.dataset.openPreparedRun !== runId.value) throw new Error("선택 실행이 바뀌었습니다. 현재 실행의 파일 목록을 다시 확인하세요.");
    const payload = await postContextTool("open_order_confirmation_file", {
      runId: button.dataset.openPreparedRun,
      orderNo: button.dataset.openPreparedOrder,
      expectedFilePath: button.dataset.openPreparedPath,
    });
    message.textContent = `${payload.message} 파일 열기만으로 7단계는 실행되지 않습니다.`;
  } catch (error) {
    message.textContent = error.message;
  } finally {
    button.disabled = false;
    button.textContent = "엑셀 열기";
  }
});
document.querySelector("#openOrderReview").addEventListener("click", () => void call("upload_and_confirm_private_label_orders", flow.querySelector('[data-tool="upload_and_confirm_private_label_orders"]')));

function syncShipmentSchedule(payload) {
  const jobs = payload?.coupangUploadJobs ||
    (Array.isArray(payload?.items)
      ? payload.items.filter(item => item?.shipDate && item?.shipTime)
      : []);
  const latest = [...jobs].sort((left, right) =>
    String(right.updatedAt || "").localeCompare(String(left.updatedAt || ""))
  )[0];
  if (!latest) return;
  if (!shipmentShipDate.value) shipmentShipDate.value = latest.shipDate || "";
  if (!shipmentShipTime.value) shipmentShipTime.value = latest.shipTime || "";
}

function formatWaybillNo(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (digits.length === 11) return `${digits.slice(0, 3)}-${digits.slice(3, 7)}-${digits.slice(7)}`;
  return value || "조회되지 않음";
}

function createWaybillNumberCard(labelText, value) {
  const card = document.createElement("div");
  card.className = "waybill-number-card";
  const label = document.createElement("span");
  label.className = "waybill-number-label";
  label.textContent = labelText;
  const number = document.createElement("span");
  number.className = `waybill-number-value${value ? "" : " missing"}`;
  number.textContent = formatWaybillNo(value);
  card.append(label, number);
  return card;
}

async function openWaybillConfirmation() {
  waybillError.textContent = "";
  const payload = await loadCurrentRun();
  const batches = payload.logenBatches || [];
  const cartons = payload.cartons || [];
  const jobs = payload.shippingJobs || [];
  const rows = [];
  for (const batch of batches) {
    for (const carton of cartons.filter(item => item.batchId === batch.id).sort((a, b) => a.cartonIndex - b.cartonIndex)) {
      const job = jobs.find(item => item.orderNo === batch.orderNo && item.skuCode === batch.skuCode && item.cartonIndex === carton.cartonIndex);
      rows.push({ batch, carton, job });
    }
  }
  if (!rows.length) throw new Error("확인할 로젠 카톤이 없습니다.");

  waybillRows.replaceChildren();
  waybillConfirmationContext = rows.map(({ batch, carton }) => {
    const row = document.createElement("section");
    row.className = "waybill-row";
    const title = document.createElement("div");
    title.className = "waybill-row-title";
    title.textContent = `발주 ${batch.orderNo} · SKU ${batch.skuCode} · ${carton.cartonIndex}/${batch.cartonCount} 카톤`;
    const fields = document.createElement("div");
    fields.className = "waybill-fields";
    const original = createWaybillNumberCard("원송장번호", carton.originalSlipNo);
    const waybill = createWaybillNumberCard("운송장번호", carton.waybillNo);
    const sourceLabel = document.createElement("label");
    sourceLabel.textContent = "Supplier Hub 등록 번호";
    const source = document.createElement("select");
    const choices = [];
    if (carton.originalSlipNo) choices.push({ value: "original", label: `원송장번호 사용 · ${formatWaybillNo(carton.originalSlipNo)}` });
    if (carton.waybillNo) choices.push({ value: "waybill", label: `운송장번호 사용 · ${formatWaybillNo(carton.waybillNo)}` });
    if (choices.length > 1) source.add(new Option("사용할 번호를 선택하세요", ""));
    for (const choice of choices) source.add(new Option(choice.label, choice.value));
    if (choices.length === 1) source.value = choices[0].value;
    if (choices.length === 0) {
      source.add(new Option("선택 가능한 번호 없음", ""));
      source.disabled = true;
    }
    sourceLabel.append(source);
    fields.append(original, waybill, sourceLabel);
    row.append(title, fields);
    waybillRows.append(row);
    return {
      batchId: batch.id,
      cartonIndex: carton.cartonIndex,
      sourceInput: source,
      hasCandidate: choices.length > 0
    };
  });
  const missingCount = waybillConfirmationContext.filter(item => !item.hasCandidate).length;
  if (missingCount > 0) {
    waybillError.textContent = `로젠에서 번호 후보를 읽지 못한 카톤이 ${missingCount}건 있습니다. 번호 조회를 다시 교정해야 합니다.`;
  }
  waybillDialog.showModal();
  waybillConfirmationContext.find(item => item.hasCandidate)?.sourceInput.focus();
}

function requiredId(input, label, previousStage) {
  const value = input.value.trim();
  if (!value) throw new Error(`${label}가 없습니다. 먼저 ${previousStage}단계를 실행하세요.`);
  return value;
}

async function postContextTool(tool, input = {}) {
  return api.postTool(tool, input);
}

function contextDate(value) {
  if (!value) return "시각 없음";
  return new Intl.DateTimeFormat("ko-KR", {
    month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false
  }).format(new Date(value));
}

async function refreshContexts() {
  const sequence = ++contextsRequestSequence;
  contextStatus.textContent = "최근 ID 기록을 불러오는 중입니다.";
  try {
    const payload = await postContextTool("list_fulfillment_contexts", { limit: 30 });
    if (sequence !== contextsRequestSequence) return;
    const selectedScan = scanId.value.trim();
    const selectedRun = runId.value.trim();
    recentScanId.replaceChildren(new Option("Scan 기록을 선택하세요", ""));
    for (const scan of payload.scans || []) {
      const range = scan.dateFrom ? ` · ${scan.dateFrom}${scan.dateTo && scan.dateTo !== scan.dateFrom ? `~${scan.dateTo}` : ""}` : "";
      recentScanId.add(new Option(`${scan.id} · ${contextDate(scan.createdAt)} · 발주 ${scan.orderCount}건 · Run ${scan.runCount}건${range}`, scan.id));
    }
    recentRunId.replaceChildren(new Option("Run 기록을 선택하세요", ""));
    for (const run of payload.runs || []) {
      const statusLabel = { completed: "완료", released: "마무리", blocked: "확인 필요", failed: "확인 필요", running: "진행 중", selected: "준비" }[run.status] || "진행 중";
      recentRunId.add(new Option(isBeginner ? `${contextDate(run.updatedAt)} · 발주 ${run.orderCount}건 · ${statusLabel}` : `${run.id} · ${contextDate(run.updatedAt)} · ${run.status} · ${run.currentStage}단계 · 발주 ${run.orderCount}건`, run.id));
    }
    recentScanId.value = selectedScan && [...recentScanId.options].some(option => option.value === selectedScan)
      ? selectedScan : (freshStart ? "" : payload.latestScanId || "");
    recentRunId.value = selectedRun && [...recentRunId.options].some(option => option.value === selectedRun)
      ? selectedRun : (freshStart ? "" : payload.latestRunId || "");
    contextStatus.textContent = `Scan ${payload.scans?.length || 0}건, Run ${payload.runs?.length || 0}건을 불러왔습니다. 목록 선택 후 ‘선택 ID 사용’을 누르세요.`;
  } catch (error) {
    if (sequence === contextsRequestSequence) contextStatus.textContent = `ID 목록을 불러오지 못했습니다: ${error.message}`;
  }
}

async function copyContextId(input, label) {
  const value = input.value.trim();
  if (!value) throw new Error(`복사할 ${label}가 없습니다.`);
  await navigator.clipboard.writeText(value);
  contextStatus.textContent = `${label} ${value}를 복사했습니다.`;
}

async function refreshStageRecords() {
  const payload = await loadCurrentRun();
  return renderRunStages(payload);
}
function renderRunStages(payload) {
  if (payload.id !== runId.value) return payload;
  runReadRevision++;
  monitoredRun = payload;
  monitoringError = "";
  monitoringCheckedAt = new Date().toLocaleTimeString("ko-KR", { hour12: false });
  renderOrderReviewSummary(payload);
  for (const [number, , tool] of definitions) {
    const button = flow.querySelector(`button[data-tool="${tool}"]`);
    const card = button?.closest(".stage");
    const record = payload.stages?.find(item => item.stage === number);
    const unrecorded = !record && number <= 3 && payload.stages?.some(stage => stage.stage === 4);
    card.dataset.status = record?.status || (unrecorded ? "unrecorded" : "waiting");
    card?.classList.remove("running", "completed", "failed");
    if (record?.status === "completed") card?.classList.add("completed");
    if (["blocked", "failed", "unknown"].includes(record?.status)) card?.classList.add("failed");
    const status = card?.querySelector(".stage-status");
    if (status) status.textContent = record ? `${record.status === "completed" ? "완료" : "확인 필요"} · ${record.message}` : unrecorded ? "조회 단계 · 개별 실행 기록 없음" : "대기";
    if (button) {
      button.dataset.locked = String(number === 14 && ["completed", "unknown"].includes(record?.status));
      button.disabled = preparationBusy || button.dataset.locked === "true";
      button.textContent = button.dataset.locked === "true" ? "재출력 차단 · 이력 확인" : record?.status === "completed" ? "완료 · 다시 실행" : number === 15 ? "실제 등록" : "이 단계 실행";
    }
  }
  const selected = stageRecordStage.value;
  stageRecordStage.replaceChildren(new Option("단계 이력을 선택하세요", ""));
  for (const record of [...(payload.stages || [])].sort((left, right) => left.stage - right.stage)) {
    const definition = definitions.find(([number]) => number === record.stage);
    const name = definition?.[1] || `${record.stage}단계`;
    const option = new Option(`${record.stage}단계 · ${name} · ${record.status}`, String(record.stage));
    option.dataset.status = record.status;
    stageRecordStage.add(option);
  }
  if (selected && [...stageRecordStage.options].some(option => option.value === selected)) {
    stageRecordStage.value = selected;
  }
  contextStatus.textContent = `${payload.id}의 단계 이력 ${payload.stages?.length || 0}건을 불러왔습니다.`;
  syncGroupProgress();
  return payload;
}

async function resetStageHistory(stage, status, clearLogenRegistration = false) {
  runReadRevision++;
  const id = requiredId(runId, "Run ID", 4);
  const allowUnknown = status === 'unknown' && stage === 14;
  if (!['blocked', 'failed', 'completed'].includes(status) && !allowUnknown) {
    throw new Error("테스트 모드에서 blocked/failed/completed 또는 실제 미출력을 확인한 14단계 unknown 이력만 초기화할 수 있습니다.");
  }
  const payload = await postContextTool("reset_fulfillment_stage_record", {
    runId: id,
    stage,
    allowUnknown,
    quickReset: true,
    clearLogenRegistration
  });
  summary.classList.remove("error");
  summary.textContent = payload.message;
  result.textContent = JSON.stringify(payload, null, 2);
  await refreshStageRecords();
  await refreshContexts();
  return payload;
}

const resetHistoryDialog = document.querySelector("#resetHistoryDialog");
const resetHistoryStage = document.querySelector("#resetHistoryStage");
const resetHistoryChecked = document.querySelector("#resetHistoryChecked");
const confirmResetHistory = document.querySelector("#confirmResetHistory");
let resetHistoryRunId = "";
let resettingHistory = false;
function syncHistoryResetChoice() {
  confirmResetHistory.disabled = resettingHistory || !resetHistoryStage.value || !resetHistoryChecked.checked;
}
document.querySelector("#floatingResetHistory").addEventListener("click", async () => {
  if (preparationBusy || activeRange || !runId.value || document.querySelector("dialog[open]")) return;
  detachedToolsWindow?.close();
  window.focus();
  resetHistoryRunId = runId.value;
  resetHistoryStage.replaceChildren(new Option("단계를 선택하세요", ""));
  resetHistoryChecked.checked = false;
  syncHistoryResetChoice();
  document.querySelector("#resetHistoryRun").textContent = `선택 작업: ${resetHistoryRunId}`;
  const message = document.querySelector("#resetHistoryMessage");
  message.textContent = "단계 이력을 불러오는 중입니다.";
  resetHistoryDialog.showModal();
  try {
    const run = await api.postTool("get_fulfillment_run", { runId: resetHistoryRunId });
    if (!resetHistoryDialog.open || run.id !== resetHistoryRunId) return;
    if (run.stages?.some(record => record.status === "running")) throw new Error("작업 실행이 끝난 뒤 초기화하세요.");
    for (const record of [...(run.stages || [])].sort((a, b) => a.stage - b.stage)) {
      if (!["blocked", "failed", "completed"].includes(record.status) && !(record.stage === 14 && record.status === "unknown")) continue;
      const name = definitions.find(([number]) => number === record.stage)?.[1] || "";
      const option = new Option(`${record.stage}단계 · ${name} · ${record.status}`, String(record.stage));
      option.dataset.status = record.status;
      resetHistoryStage.add(option);
    }
    message.textContent = resetHistoryStage.options.length > 1 ? "" : "초기화할 수 있는 단계 이력이 없습니다.";
  } catch (error) { message.textContent = error.message; }
});
resetHistoryStage.addEventListener("change", () => { resetHistoryChecked.checked = false; syncHistoryResetChoice(); });
resetHistoryChecked.addEventListener("change", syncHistoryResetChoice);
document.querySelector("#cancelResetHistory").addEventListener("click", () => { if (!resettingHistory) resetHistoryDialog.close(); });
resetHistoryDialog.addEventListener("cancel", event => { if (resettingHistory) event.preventDefault(); });
confirmResetHistory.addEventListener("click", async () => {
  if (confirmResetHistory.disabled || resettingHistory) return;
  const message = document.querySelector("#resetHistoryMessage");
  if (runId.value !== resetHistoryRunId || preparationBusy || activeRange) {
    message.textContent = "선택 작업 또는 실행 상태가 바뀌었습니다. 닫은 뒤 다시 열어 주세요.";
    return;
  }
  resettingHistory = true;
  syncHistoryResetChoice();
  document.querySelector("#cancelResetHistory").disabled = true;
  try {
    const stage = Number(resetHistoryStage.value);
    const selected = resetHistoryStage.selectedOptions[0];
    await resetStageHistory(stage, selected.dataset.status, stage === 13);
    resetHistoryDialog.close();
    await refreshFloatingRun();
  } catch (error) { message.textContent = error.message; }
  finally {
    resettingHistory = false;
    document.querySelector("#cancelResetHistory").disabled = false;
    syncHistoryResetChoice();
  }
});

async function resetSelectedStageRecord() {
  const stage = Number(stageRecordStage.value);
  if (!Number.isInteger(stage)) throw new Error("초기화할 단계 이력을 선택하세요.");
  const selected = stageRecordStage.selectedOptions[0];
  const status = selected?.dataset.status;
  return resetStageHistory(stage, status, stage === 13);
}

async function resetStageFromCard(stage, button) {
  const payload = await loadCurrentRun();
  const record = (payload.stages || []).find(item => item.stage === stage);
  if (!record) throw new Error(`${stage}단계 이력이 없습니다.`);
  const reset = await resetStageHistory(stage, record.status, stage === 13);
  const card = button.closest(".stage");
  card?.classList.remove("running", "completed", "failed");
  const stageStatus = card?.querySelector(".stage-status");
  if (stageStatus) stageStatus.textContent = "이력 초기화됨";
  return reset;
}

function clearDeletedRunSelection() {
  runReadRevision++;
  runId.value = "";
  monitoredRun = undefined;
  monitoringError = "";
  preparationPlan = undefined;
  shipmentShipDate.value = "";
  shipmentShipTime.value = "";
  stageRecordStage.replaceChildren(new Option("Run을 선택한 뒤 불러오세요", ""));
  freshStart = true;
  const cleanUrl = new URL(location.href);
  cleanUrl.searchParams.delete("runId");
  cleanUrl.searchParams.set("fresh", "1");
  history.replaceState(null, "", cleanUrl);
  syncExperienceLinks();
  renderPreparation();
  renderOrderReviewSummary();
  syncFloatingPanel();
}

const resetCurrentRunDialog = document.querySelector("#resetCurrentRunDialog");
const resetCurrentRunConfirmation = document.querySelector("#resetCurrentRunConfirmation");
const resetCurrentRunChecked = document.querySelector("#resetCurrentRunChecked");
const confirmResetCurrentRun = document.querySelector("#confirmResetCurrentRun");
let resetCurrentRunId = "";
let resettingCurrentRun = false;
function syncCurrentRunReset() {
  confirmResetCurrentRun.disabled = resettingCurrentRun
    || !resetCurrentRunId
    || resetCurrentRunConfirmation.value.trim() !== resetCurrentRunId
    || !resetCurrentRunChecked.checked;
}
document.querySelector("#resetCurrentRunAll").addEventListener("click", async () => {
  if (document.querySelector("dialog[open]")) return;
  resetCurrentRunId = runId.value.trim();
  resetCurrentRunConfirmation.value = "";
  resetCurrentRunChecked.checked = false;
  resetCurrentRunConfirmation.disabled = !resetCurrentRunId || preparationBusy || Boolean(activeRange);
  resetCurrentRunChecked.disabled = resetCurrentRunConfirmation.disabled;
  const message = document.querySelector("#resetCurrentRunMessage");
  const runSummary = document.querySelector("#resetCurrentRunSummary");
  message.textContent = "현재 Run의 기록을 확인하는 중입니다.";
  runSummary.textContent = resetCurrentRunId ? `선택 작업: ${resetCurrentRunId}` : "선택 작업 없음";
  syncCurrentRunReset();
  resetCurrentRunDialog.showModal();
  if (!resetCurrentRunId) {
    message.textContent = "현재 선택된 Run이 없습니다. 창을 닫고 ‘최근 Run 기록’에서 작업을 선택한 뒤 다시 여세요.";
    return;
  }
  if (preparationBusy || activeRange) {
    message.textContent = "현재 단계 실행이 끝난 뒤 전체 초기화할 수 있습니다.";
    return;
  }
  try {
    const run = await api.postTool("get_fulfillment_run", { runId: resetCurrentRunId });
    if (!resetCurrentRunDialog.open || run.id !== resetCurrentRunId) return;
    if (run.stages?.some(record => record.status === "running")) {
      throw new Error("실행 중인 단계가 있습니다. 작업이 끝난 뒤 전체 초기화하세요.");
    }
    document.querySelector("#resetCurrentRunSummary").textContent = `선택 작업: ${run.id} · 발주 ${run.orders?.length || 0}건 · 단계 이력 ${run.stages?.length || 0}건`;
    document.querySelector("#resetCurrentRunMessage").textContent = "Run ID 입력과 실제 처리 결과 확인을 완료하면 초기화할 수 있습니다.";
  } catch (error) {
    message.textContent = error.message;
    resetCurrentRunId = "";
    resetCurrentRunConfirmation.disabled = true;
    resetCurrentRunChecked.disabled = true;
    syncCurrentRunReset();
  }
});
resetCurrentRunConfirmation.addEventListener("input", syncCurrentRunReset);
resetCurrentRunChecked.addEventListener("change", syncCurrentRunReset);
document.querySelector("#cancelResetCurrentRun").addEventListener("click", () => { if (!resettingCurrentRun) resetCurrentRunDialog.close(); });
resetCurrentRunDialog.addEventListener("cancel", event => { if (resettingCurrentRun) event.preventDefault(); });
confirmResetCurrentRun.addEventListener("click", async () => {
  if (confirmResetCurrentRun.disabled || resettingCurrentRun) return;
  const message = document.querySelector("#resetCurrentRunMessage");
  if (runId.value.trim() !== resetCurrentRunId || preparationBusy || activeRange) {
    message.textContent = "선택 작업 또는 실행 상태가 바뀌었습니다. 닫은 뒤 다시 열어 주세요.";
    return;
  }
  resettingCurrentRun = true;
  syncCurrentRunReset();
  document.querySelector("#cancelResetCurrentRun").disabled = true;
  try {
    const payload = await postContextTool("delete_fulfillment_run_record", {
      runId: resetCurrentRunId,
      confirmation: resetCurrentRunConfirmation.value.trim()
    });
    clearDeletedRunSelection();
    resetCurrentRunDialog.close();
    contextStatus.textContent = `${payload.message} 연결된 발주 배정을 해제했습니다.`;
    summary.classList.remove("error");
    summary.textContent = contextStatus.textContent;
    result.textContent = JSON.stringify(payload, null, 2);
    await refreshContexts();
    await refreshPreparation(true);
  } catch (error) { message.textContent = error.message; }
  finally {
    resettingCurrentRun = false;
    document.querySelector("#cancelResetCurrentRun").disabled = false;
    syncCurrentRunReset();
  }
});

async function deleteContextRecord(kind) {
  const isScan = kind === "scan";
  const input = isScan ? scanId : runId;
  const id = input.value.trim();
  const label = isScan ? "Scan ID" : "Run ID";
  if (!id) throw new Error(`삭제할 ${label}가 없습니다.`);
  const confirmation = window.prompt(`${label} 기록을 삭제합니다. 확인을 위해 아래 ID를 그대로 입력하세요.\n\n${id}`);
  if (confirmation === null) return;
  const tool = isScan ? "delete_fulfillment_scan_record" : "delete_fulfillment_run_record";
  const payload = await postContextTool(tool, {
    [isScan ? "scanId" : "runId"]: id,
    confirmation: confirmation.trim()
  });
  if (isScan) {
    scanId.value = "";
    if ((payload.deletedRunIds || []).includes(runId.value.trim())) runId.value = "";
  } else {
    clearDeletedRunSelection();
  }
  contextStatus.textContent = payload.message;
  summary.classList.remove("error");
  summary.textContent = payload.message;
  result.textContent = JSON.stringify(payload, null, 2);
  await refreshContexts();
}

function orderQueryInput() {
  const type = dateSearchType.value;
  const from = dateFrom.value;
  const to = dateTo.value;
  const label = type === "order_date" ? "발주일" : "입고예정일";
  if ((from && !to) || (!from && to)) throw new Error(`${label} 시작일과 종료일을 모두 지정하세요.`);
  if (type === "order_date" && (!from || !to)) throw new Error("발주일 조회는 시작일과 종료일을 지정하세요.");
  if (from && to && from > to) throw new Error(`${label} 시작일은 종료일보다 늦을 수 없습니다.`);
  return {
    lookAheadDays: Number(document.querySelector("#lookAheadDays").value),
    dateSearchType: type,
    dateFrom: from || undefined,
    dateTo: to || undefined
  };
}

function updateDateSearchType() {
  const isOrderDate = dateSearchType.value === "order_date";
  const label = isOrderDate ? "발주일" : "입고예정일";
  document.querySelector("#dateFromLabel").textContent = `${label} 시작`;
  document.querySelector("#dateToLabel").textContent = `${label} 종료`;
  document.querySelector("#lookAheadDays").disabled = isOrderDate;
  document.querySelector("#dateHelp").textContent = isOrderDate
    ? "발주일 조회는 시작일과 종료일을 지정해야 합니다."
    : "입고예정일이 기본입니다. 날짜를 비우면 빠른 조회 범위를 사용합니다.";
}

dateSearchType.addEventListener("change", updateDateSearchType);
updateDateSearchType();
dateFrom.addEventListener("change", () => {
  if (dateFrom.value && !dateTo.value) {
    dateTo.value = dateFrom.value;
  }
});

function inputFor(tool) {
  if (tool === "open_supplierhub") return {};
  if (tool === "list_private_label_orders") return orderQueryInput();
  if (tool === "compare_new_orders") return { scanId: requiredId(scanId, "Scan ID", 2) };
  if (["select_orders_for_fulfillment", "select_orders_for_print"].includes(tool)) {
    return {
      scanId: requiredId(scanId, "Scan ID", 2),
      ...(selectedOrderNos() ? { orderNos: selectedOrderNos() } : {})
    };
  }
  if (tool === "release_fulfillment_run_assignments") return { runId: requiredId(runId, "Run ID", 4) };
  const logenMethod = document.querySelector("#logenMethod").value;
  if (tool === "run_fulfillment_workflow") return {
    ...orderQueryInput(),
    dataSource: document.querySelector("#dataSource").value,
    logenMethod,
    ...(selectedOrderNos() ? { orderNos: selectedOrderNos() } : {})
  };
  const common = { runId: requiredId(runId, "Run ID", 4) };
  if (["open_logen_login", "open_logen_single_order_registration"].includes(tool)) return { ...common, logenMethod };
  if (tool === "register_logen_delivery_order") return { ...common, dataSource: document.querySelector("#dataSource").value, logenMethod };
  if (tool === "print_logen_waybill") return { ...common, logenMethod };
  if (["prepare_supplierhub_shipment_tracking", "register_supplierhub_shipment_tracking"].includes(tool)) {
    return {
      ...common,
      ...(shipmentShipDate.value ? { shipDate: shipmentShipDate.value } : {}),
      ...(shipmentShipTime.value ? { shipTime: shipmentShipTime.value } : {})
    };
  }
  if (["download_order_confirmation_template", "prepare_order_confirmation_workbook", "upload_and_confirm_private_label_orders", "download_order_files", "print_order_files", "record_print_result", "print_supplierhub_shipment_documents", "get_fulfillment_run"].includes(tool)) return common;
  return {};
}

function selectedOrderNos() {
  const values = [...new Set(
    targetOrderNos.value.split(/[,\s]+/).map(value => value.trim()).filter(Boolean)
  )];
  const invalid = values.find(value => !/^\d+$/.test(value));
  if (invalid) throw new Error(`발주번호는 숫자만 입력하세요: ${invalid}`);
  return values.length ? values : undefined;
}

async function invokeTool(tool, inputOverride) {
  let input = inputOverride ?? inputFor(tool);
  if (tool === "upload_and_confirm_private_label_orders" && !await reviewOrderConfirmation(input)) {
    return { status: "cancelled", message: "검토 화면을 닫았습니다. 7단계 업로드·발주확정은 실행하지 않았습니다." };
  }
  if (tool === "register_logen_delivery_order") {
    input = await reviewRegistration(input);
    if (!input) return { status: "cancelled", message: "등록 미리보기를 닫았습니다. 13단계는 실행하지 않았습니다." };
  }
  const payload = await api.postTool(tool, input);
  if (payload.scanId) scanId.value = payload.scanId;
  if (payload.runId) runId.value = payload.runId;
  if (tool === "release_fulfillment_run_assignments") runId.value = "";
  if (payload.id && ["get_fulfillment_run", "run_fulfillment_workflow"].includes(tool)) runId.value = payload.id;
  syncShipmentSchedule(payload);
  if (payload.scanId || payload.runId || payload.id) void refreshContexts();
  if (tool === "get_fulfillment_run") renderRunStages(payload);
  if (["select_orders_for_fulfillment", "select_orders_for_print", "download_order_files", "register_logen_delivery_order", "get_fulfillment_run", "release_fulfillment_run_assignments"].includes(tool)) await refreshPreparation();
  if (["prepare_order_confirmation_workbook", "upload_and_confirm_private_label_orders"].includes(tool)) await refreshStageRecords();
  return payload;
}

function recordingFileName(startedAt) {
  const pad = value => String(value).padStart(2, "0");
  return `supplierhub-workflow-${startedAt.getFullYear()}${pad(startedAt.getMonth() + 1)}${pad(startedAt.getDate())}-${pad(startedAt.getHours())}${pad(startedAt.getMinutes())}${pad(startedAt.getSeconds())}.webm`;
}

async function startWorkflowRecording() {
  if (!navigator.mediaDevices?.getDisplayMedia || !window.MediaRecorder) {
    throw new Error("이 브라우저에서는 화면 녹화를 지원하지 않습니다. 화면 공유를 지원하는 브라우저에서 운영 화면을 여세요.");
  }
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: { frameRate: 15, displaySurface: "monitor" },
    audio: true
  });
  const mimeTypes = [
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm"
  ];
  const mimeType = mimeTypes.find(type => MediaRecorder.isTypeSupported(type));
  let recorder;
  try {
    recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
  } catch (error) {
    stream.getTracks().forEach(track => track.stop());
    throw error;
  }
  workflowRecordingChunks = [];
  workflowRecordingStartedAt = new Date();
  workflowRecordingStream = stream;
  workflowRecorder = recorder;
  const surface = stream.getVideoTracks()[0]?.getSettings?.().displaySurface;
  workflowRecordingSurface = { monitor: "전체 화면", window: "선택한 창", browser: "선택한 탭" }[surface] || "선택한 화면";
  let recordingError = "";
  let finished = false;
  recorder.addEventListener("dataavailable", event => {
    if (event.data.size > 0) workflowRecordingChunks.push(event.data);
  });
  const finishRecording = () => {
    if (finished) return;
    finished = true;
    clearInterval(workflowRecordingTimer);
    workflowRecordingTimer = undefined;
    const startedAt = workflowRecordingStartedAt || new Date();
    const fileName = recordingFileName(startedAt);
    const blob = new Blob(workflowRecordingChunks, {
      type: recorder.mimeType || "video/webm"
    });
    workflowRecordingStream?.getTracks().forEach(track => track.stop());
    workflowRecordingStream = undefined;
    workflowRecorder = undefined;
    workflowRecordingChunks = [];
    recordWorkflow.classList.remove("recording");
    recordWorkflow.textContent = "녹화 시작";
    if (blob.size > 0) {
      if (workflowRecordingDownloadUrl) URL.revokeObjectURL(workflowRecordingDownloadUrl);
      workflowRecordingDownloadUrl = URL.createObjectURL(blob);
      const link = document.querySelector("#recordingDownload");
      link.href = workflowRecordingDownloadUrl;
      link.download = fileName;
      link.hidden = false;
      link.textContent = `최근 녹화 영상 다시 저장 (${(blob.size / 1024 / 1024).toFixed(1)} MB)`;
      link.click();
      recordingStatus.textContent = `${recordingError ? "녹화가 중단되어 남은 영상을 저장합니다. " : "녹화를 마쳤습니다. "}다운로드에서 ${fileName}을 확인하세요. 놓쳤다면 아래 링크를 누르세요. 다시 저장 링크는 이 페이지를 닫거나 새로고침하기 전까지 사용할 수 있습니다.`;
    } else {
      recordingStatus.textContent = recordingError || "녹화된 영상이 없습니다. 녹화 시작을 누르고 화면 선택 후 다시 진행하세요.";
    }
    recordWorkflow.disabled = false;
    syncFloatingPanel();
  };
  recorder.addEventListener("stop", finishRecording);
  recorder.addEventListener("error", event => {
    recordingError = `녹화가 중단됐습니다: ${event.error?.message || "녹화 장치 상태를 확인하세요."}`;
    recordingStatus.textContent = recordingError;
  });
  for (const track of stream.getVideoTracks()) {
    track.addEventListener("ended", () => {
      if (recorder.state === "recording") recorder.stop();
    });
  }
  try {
    recorder.start(1000);
  } catch (error) {
    stream.getTracks().forEach(track => track.stop());
    workflowRecordingStream = undefined;
    workflowRecorder = undefined;
    workflowRecordingChunks = [];
    throw error;
  }
  recordWorkflow.classList.add("recording");
  recordWorkflow.textContent = "녹화 중지·파일 저장";
  recordingStatus.textContent = `${workflowRecordingSurface} 녹화 중입니다. 이제 작업을 진행하세요. 끝나면 녹화 중지·파일 저장을 누르세요.`;
  workflowRecordingTimer = setInterval(syncFloatingPanel, 1000);
  syncFloatingPanel();
}

async function toggleWorkflowRecording() {
  if (workflowRecorder?.state === "recording") {
    recordWorkflow.disabled = true;
    recordWorkflow.textContent = "영상 저장 준비 중…";
    recordingStatus.textContent = "녹화를 마무리하고 영상을 저장하고 있습니다.";
    workflowRecorder.stop();
    return;
  }
  recordWorkflow.disabled = true;
  recordWorkflow.textContent = "화면 선택 중…";
  recordingStatus.textContent = "열린 공유 창에서 전체 화면 → 화면 미리보기 → 공유를 선택하세요. 선택 즉시 녹화가 시작됩니다. 다른 창을 선택해도 됩니다.";
  try {
    await startWorkflowRecording();
  } catch (error) {
    recordWorkflow.textContent = "녹화 시작";
    recordingStatus.textContent = ["NotAllowedError", "AbortError"].includes(error.name)
      ? "화면 공유가 시작되지 않았습니다. 녹화 시작을 다시 누르고 공유할 화면을 선택하세요. 권한을 거부했다면 브라우저의 화면 공유 권한도 확인하세요."
      : `녹화를 시작하지 못했습니다: ${error.message}`;
  } finally {
    recordWorkflow.disabled = false;
    syncFloatingPanel();
  }
}

function isEmptySelectionResult(tool, payload) {
  return tool === "select_orders_for_fulfillment" && payload.status === "blocked"
    && String(payload.message || "").includes("3단계 결과에 새로 배정할 발주가 없습니다.");
}

async function showExistingWork() {
  await refreshContexts();
  let parent = recentRunId.closest("details");
  while (parent) { parent.open = true; parent = parent.parentElement?.closest("details"); }
  recentRunId.scrollIntoView({ block: "center" });
}

async function showSelectionNotice(tool, payload, card, stageStatus) {
  if (!isEmptySelectionResult(tool, payload)) return false;
  selectionNotice = true;
  summary.classList.remove("error");
  summary.textContent = "새로 배정할 발주가 없습니다. 아래 기존 작업에서 대상과 발주 건수를 확인한 뒤 이어가세요. 새 발주를 찾으려면 조회 기간을 변경하세요.";
  card?.classList.remove("running", "completed", "failed");
  if (card) card.dataset.status = "waiting";
  if (stageStatus) stageStatus.textContent = "새 배정 없음 · 기존 작업 확인";
  document.querySelector("#prepareGroupStatus").textContent = "조회 완료 · 기존 작업 선택 또는 조회 기간 변경";
  await showExistingWork();
  return true;
}

async function call(tool, button) {
  if (preparationBusy) return;
  const buttons = [...document.querySelectorAll("button:not([data-floating-passive])")];
  const card = button?.closest(".stage");
  const stageStatus = card?.querySelector(".stage-status");
  const idleLabel = button?.textContent;
  const previousClass = card?.className;
  const previousStatus = stageStatus?.textContent;
  const previousOutcome = card?.dataset.status;
  setPreparationBusy(true);
  buttons.forEach(item => item.disabled = true);
  card?.classList.remove("completed", "failed");
  card?.classList.add("running");
  if (stageStatus) stageStatus.textContent = "실행 중…";
  if (button) button.textContent = "실행 중…";
  summary.classList.remove("error");
  summary.textContent = `${tool} 실행 중…`;
  syncGroupProgress();
  try {
    const payload = await invokeTool(tool);
    if (card) card.dataset.status = payload.status || "completed";
    summary.textContent = payload.message || `${tool} 완료`;
    result.textContent = JSON.stringify(payload, null, 2);
    if (await showSelectionNotice(tool, payload, card, stageStatus)) {
      if (button) button.textContent = idleLabel;
      return;
    }
    if (payload.status === "cancelled") {
      if (card) card.className = previousClass;
      if (card) card.dataset.status = previousOutcome || "waiting";
      if (stageStatus) stageStatus.textContent = previousStatus;
      if (button) button.textContent = idleLabel;
      return;
    }
    if (tool === "prepare_supplierhub_shipment_tracking" && payload.status === "partial") {
      card?.classList.remove("running", "failed");
      card?.classList.add("completed");
      if (stageStatus) stageStatus.textContent = "준비 완료 · 실제 업로드 전 중단";
      if (button) button.textContent = "준비 완료 · 다시 확인";
      return;
    }
    if (tool === "print_logen_waybill" && payload.status === "unknown" && String(payload.message || "").includes("사용자 확인")) {
      card?.classList.remove("running", "completed", "failed");
      if (stageStatus) stageStatus.textContent = "출력 완료 · 송장번호 확인 필요";
      if (button) {
        button.textContent = "재출력 차단 · 번호 확인 필요";
        button.dataset.locked = "true";
      }
      await openWaybillConfirmation();
      return;
    }
    if (["blocked", "failed", "unknown"].includes(payload.status)) {
      card?.classList.remove("running", "completed");
      card?.classList.add("failed");
      summary.classList.add("error");
      if (stageStatus) stageStatus.textContent = `중단 · ${payload.message || payload.status}`;
      if (button) button.textContent = "보완 후 다시 실행";
      return;
    }
    card?.classList.remove("running");
    card?.classList.add("completed");
    if (stageStatus) stageStatus.textContent = payload.runId ? `완료 · ${payload.runId}` : "완료";
    if (button) button.textContent = "완료 · 다시 실행";
  } catch (error) {
    summary.classList.add("error");
    summary.textContent = error.message;
    result.textContent = JSON.stringify({ error: error.message }, null, 2);
    if (card) card.dataset.status = "failed";
    card?.classList.remove("running");
    card?.classList.add("failed");
    if (stageStatus) stageStatus.textContent = `실패 · ${error.message}`;
    if (button) button.textContent = "실패 · 다시 실행";
  } finally {
    buttons.forEach(item => item.disabled = item.dataset.locked === "true");
    setPreparationBusy(false);
    syncPreparationControls();
    if (button && !card) button.textContent = idleLabel;
    if (selectionNotice && !runId.value) recentRunId.focus();
    else if (button) button.focus();
  }
}

async function runStageRange(button, from, through, options = {}) {
  if (preparationBusy) return;
  const steps = definitions.filter(([number]) => number >= from && number <= through);
  let query, targetOrders, executionRun;
  try {
    if (from === 1) { query = orderQueryInput(); targetOrders = selectedOrderNos(); }
    else executionRun = requiredId(runId, "Run ID", 4);
  } catch (error) { summary.classList.add("error"); summary.textContent = error.message; return; }
  const dataSource = document.querySelector("#dataSource").value;
  const logenMethod = document.querySelector("#logenMethod").value;
  const buttons = [...document.querySelectorAll("button:not([data-floating-passive])")];
  const idleLabel = button.textContent;
  setPreparationBusy(true);
  activeRange = { from, through, full: options.full === true };
  pauseRequested = false;
  buttons.forEach(item => item.disabled = true);
  if (from === 1) {
    selectionNotice = false;
    scanId.value = "";
    runId.value = "";
    renderOrderReviewSummary();
    await refreshPreparation(true);
  }
  let activeNumber = from;
  let rangeCompleted = false;
  const selectedGroup = workflowGroups.find(group => group.from === from && group.through === through);
  for (const [number, , tool] of from === 1 ? definitions : []) {
    const stageButton = flow.querySelector(`button[data-tool="${tool}"]`);
    const card = stageButton?.closest(".stage");
    if (card) card.dataset.status = "waiting";
    card?.classList.remove("running", "completed", "failed");
    const stageStatus = card?.querySelector(".stage-status");
    if (stageStatus) stageStatus.textContent = "대기";
    if (stageButton) {
      stageButton.textContent = "이 단계 실행";
      delete stageButton.dataset.locked;
    }
    if (number === 14) {
      const confirmButton = card?.querySelector("button[data-waybill-confirm]");
      if (confirmButton) confirmButton.disabled = false;
    }
  }
  buttons.forEach(item => item.disabled = true);
  summary.classList.remove("error");
  result.textContent = "{}";
  try {
    const savedRun = from > 1 ? await postContextTool("get_fulfillment_run", { runId: executionRun }) : undefined;
    for (const [number, name, tool] of steps) {
      if (pauseRequested) {
        summary.textContent = "연속 실행을 멈췄습니다. 완료된 결과를 유지하고 남은 단계부터 이어갈 수 있습니다.";
        return;
      }
      activeNumber = number;
      if (executionRun && runId.value !== executionRun) throw new Error("선택 실행이 변경되어 연속 진행을 멈췄습니다.");
      const stageButton = flow.querySelector(`button[data-tool="${tool}"]`);
      const card = stageButton?.closest(".stage");
      const stageStatus = card?.querySelector(".stage-status");
      const beforeClass = card?.className;
      const beforeStatus = stageStatus?.textContent;
      const beforeOutcome = card?.dataset.status;
      const savedStage = savedRun?.stages?.find(stage => stage.stage === number);
      const confirmationDone = number === 7 && savedRun?.orders?.length && savedRun.orders.every(order => savedRun.orderConfirmationJobs?.some(job => job.orderNo === order.orderNo && job.status === "confirmed"));
      const registrationDone = number === 13 && savedRun?.orders?.some(order => order.items?.length) && savedRun.orders.every(order => order.items?.length && order.items.every(item => savedRun.logenBatches?.some(batch => batch.orderNo === order.orderNo && batch.skuCode === item.skuCode && ["registered", "waybills_printed", "completed"].includes(batch.status))));
      const finishedShippingConnection = options.full && [11, 12].includes(number) && savedRun?.stages?.some(stage => stage.stage === 14 && stage.status === "completed");
      if (confirmationDone || registrationDone || (savedStage?.status === "completed" && (![7, 11, 12, 13].includes(number) || finishedShippingConnection))) {
        if (card) { card.dataset.status = "completed"; card.classList.remove("running", "failed"); card.classList.add("completed"); }
        if (stageStatus) stageStatus.textContent = "완료 · 기존 처리 결과 유지";
        syncGroupProgress();
        continue;
      }
      card?.classList.remove("completed", "failed");
      card?.classList.add("running");
      if (stageStatus) stageStatus.textContent = "자동 진행 중…";
      button.textContent = options.full ? `${number}/16 진행 중` : `${number}/${through} · ${name}`;
      summary.textContent = `${number}단계 ${name} 실행 중…`;
      if (from === 1 && number <= 6) document.querySelector("#prepareGroupStatus").textContent = `${number}/6 · ${name} 진행 중…`;
      syncGroupProgress();

      let inputOverride;
      if (tool === "list_private_label_orders") inputOverride = query;
      if (tool === "select_orders_for_fulfillment") inputOverride = { scanId: requiredId(scanId, "Scan ID", 2), ...(targetOrders ? { orderNos: targetOrders } : {}) };
      if (["open_logen_login", "open_logen_single_order_registration"].includes(tool)) {
        inputOverride = { runId: requiredId(runId, "Run ID", 4), logenMethod };
      }
      if (tool === "register_logen_delivery_order") {
        inputOverride = { runId: requiredId(runId, "Run ID", 4), dataSource, logenMethod };
      }
      if (tool === "print_logen_waybill") {
        inputOverride = { runId: requiredId(runId, "Run ID", 4), logenMethod };
      }
      const payload = await invokeTool(tool, inputOverride);
      if (card) card.dataset.status = payload.status || "completed";
      if (number === 4 && payload.runId) executionRun = payload.runId;
      result.textContent = JSON.stringify(payload, null, 2);
      const status = payload.status || "completed";
      if (await showSelectionNotice(tool, payload, card, stageStatus)) return;
      if (status === "cancelled") {
        if (card) card.className = beforeClass;
        if (card) card.dataset.status = beforeOutcome || "waiting";
        if (stageStatus) stageStatus.textContent = beforeStatus;
        summary.textContent = payload.message + ` 같은 실행에서 ${number}단계부터 이어가세요.`;
        return;
      }

      if (tool === "print_logen_waybill" && status === "unknown" && String(payload.message || "").includes("사용자 확인")) {
        card?.classList.remove("running", "failed");
        if (stageStatus) stageStatus.textContent = "출력 완료 · 송장번호 선택 필요";
        if (stageButton) {
          stageButton.textContent = "재출력 차단 · 번호 확인 필요";
          stageButton.dataset.locked = "true";
        }
        summary.textContent = "14단계 출력 후 송장번호 선택이 필요합니다. 번호를 확인한 뒤 다음 단계를 진행하세요.";
        await openWaybillConfirmation();
        return;
      }

      if (status !== "completed") {
        card?.classList.remove("running", "completed");
        card?.classList.add("failed");
        if (stageStatus) stageStatus.textContent = `${status} · ${payload.message || "진행 중단"}`;
        throw new Error(`${number}단계에서 중단: ${payload.message || status}`);
      }

      card?.classList.remove("running", "failed");
      card?.classList.add("completed");
      if (stageStatus) stageStatus.textContent = status === "partial" ? "부분 완료 · 다음 단계 진행" : "완료";
      if (number === 6) document.querySelector("#prepareGroupStatus").textContent = "1~6 준비 완료 · 눈으로 검토 대기";
      syncGroupProgress();
      const browserOrDeviceStage = [1, 2, 5, 8, 9, 11, 12, 13, 14].includes(number);
      if (number < through && browserOrDeviceStage) {
        summary.textContent = `${number}단계 완료 · 다음 단계 전 1초 대기 중…`;
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    rangeCompleted = true;
    summary.textContent = options.full ? "전체 실행을 완료했습니다. 현재 실행의 16단계까지 처리했습니다." : from === 1 && through === 6
      ? "1~6 준비 완료 · 눈으로 검토할 차례입니다. 7단계 업로드·발주확정은 실행하지 않았습니다."
      : `${selectedGroup?.name || `${from}~${through}단계`} 묶음을 완료했습니다. 다음 묶음은 검토 후 직접 실행하세요.`;
    if (from === 1 && through === 6) document.querySelector("#prepareGroupStatus").textContent = "1~6 준비 완료 · 눈으로 검토 대기";
  } catch (error) {
    summary.classList.add("error");
    summary.textContent = error.message;
    if (from === 1 && activeNumber <= 6) {
      document.querySelector("#prepareGroupStatus").textContent = `${activeNumber}단계에서 중단 · ${error.message}`;
      document.querySelector("#preparationSteps").open = true;
    }
    const failedCard = flow.querySelector(`button[data-tool="${definitions.find(item => item[0] === activeNumber)?.[2]}"]`)?.closest(".stage");
    if (failedCard && !["blocked", "failed", "unknown", "partial"].includes(failedCard.dataset.status)) failedCard.dataset.status = "failed";
    failedCard?.classList.remove("running", "completed");
    failedCard?.classList.add("failed");
    const failedGroup = selectedGroup || workflowGroups.find(group => activeNumber >= group.from && activeNumber <= group.through);
    if (failedGroup && failedGroup.from > 1) document.querySelector(`#details-${failedGroup.id}`).open = true;
  } finally {
    buttons.forEach(item => item.disabled = item.dataset.locked === "true");
    setPreparationBusy(false);
    activeRange = undefined;
    pauseRequested = false;
    button.textContent = idleLabel;
    syncPreparationControls();
    if (selectionNotice && !runId.value) recentRunId.focus();
    else if (rangeCompleted && through === 6) document.querySelector("#openOrderReview").focus();
    else button.focus();
  }
}

flow.addEventListener("click", event => {
  const groupButton = event.target.closest("[data-group-run]");
  if (groupButton) {
    const group = workflowGroups.find(group => group.id === groupButton.dataset.groupRun);
    if (group) void runStageRange(groupButton, group.from, group.through);
    return;
  }
  const resetButton = event.target.closest("button[data-stage-reset]");
  if (resetButton) {
    const stage = Number(resetButton.dataset.stageReset);
    void resetStageFromCard(stage, resetButton).catch(error => {
      summary.classList.add("error");
      summary.textContent = error.message;
    });
    return;
  }
  const confirmationButton = event.target.closest("button[data-waybill-confirm]");
  if (confirmationButton) {
    waybillError.textContent = "";
    void openWaybillConfirmation().catch(error => {
      summary.classList.add("error");
      summary.textContent = error.message;
    });
    return;
  }
  const button = event.target.closest("button[data-tool]");
  if (button) void call(button.dataset.tool, button);
});
document.querySelector("#closeWaybillConfirmation").addEventListener("click", () => waybillDialog.close());
waybillForm.addEventListener("submit", async event => {
  event.preventDefault();
  waybillError.textContent = "";
  const submitButton = waybillForm.querySelector('button[type="submit"]');
  submitButton.disabled = true;
  try {
    const confirmations = waybillConfirmationContext.map(item => ({
      batchId: item.batchId,
      cartonIndex: item.cartonIndex,
      selectedSource: item.sourceInput.value
    }));
    if (confirmations.some(item => !item.selectedSource)) {
      throw new Error("각 카톤에서 Supplier Hub에 등록할 번호를 선택하세요.");
    }
    const payload = await api.postTool("confirm_logen_waybill_numbers", {
      runId: requiredId(runId, "Run ID", 4), confirmations,
    });
    if (payload.status !== "completed") throw new Error(payload.message || "송장번호를 확정하지 못했습니다.");
    summary.classList.remove("error");
    summary.textContent = payload.message;
    result.textContent = JSON.stringify(payload, null, 2);
    const printButton = flow.querySelector('button[data-tool="print_logen_waybill"]');
    const card = printButton?.closest(".stage");
    card?.classList.remove("running", "failed");
    card?.classList.add("completed");
    const status = card?.querySelector(".stage-status");
    if (status) status.textContent = "완료 · 송장번호 사용자 확정";
    if (card) card.dataset.status = "completed";
    syncGroupProgress();
    if (printButton) {
      printButton.textContent = "완료 · 재출력 안 함";
      printButton.dataset.locked = "true";
      printButton.disabled = true;
    }
    waybillDialog.close();
  } catch (error) {
    waybillError.textContent = error.message;
  } finally {
    submitButton.disabled = false;
  }
});
recordWorkflow.addEventListener("click", () => void toggleWorkflowRecording());
document.querySelector("#prepareWorkspaceWindows").addEventListener("click", async event => {
  if (preparationBusy || document.querySelector("dialog[open]")) return;
  const button = event.currentTarget;
  const status = document.querySelector("#workspaceLayoutStatus");
  setPreparationBusy(true);
  button.disabled = true;
  button.textContent = "화면 배치 중…";
  status.textContent = "열려 있는 업무 창을 정리하고 있습니다. 발주·인쇄는 실행하지 않습니다.";
  syncPreparationControls();
  try {
    const payload = await api.postTool("prepare_workspace_windows", runId.value ? { runId: runId.value } : {});
    status.textContent = payload.message;
  } catch (error) {
    status.textContent = error.message;
  } finally {
    setPreparationBusy(false);
    button.textContent = "분할화면 준비";
    syncPreparationControls();
  }
});
runPreparation.addEventListener("click", event => void runStageRange(event.currentTarget, 1, 6));
document.querySelector("#readRun").addEventListener("click", () => void refreshFloatingRun(true));
document.querySelector("#releaseRun").addEventListener("click", event => void call("release_fulfillment_run_assignments", event.currentTarget));
document.querySelector("#refreshContexts").addEventListener("click", () => void refreshContexts());
document.querySelector("#useScanId").addEventListener("click", () => {
  scanId.value = recentScanId.value;
  contextStatus.textContent = scanId.value ? `Scan ID ${scanId.value}를 사용합니다.` : "선택한 Scan 기록이 없습니다.";
});
document.querySelector("#useRunId").addEventListener("click", () => {
  runId.value = recentRunId.value;
  shipmentShipDate.value = "";
  shipmentShipTime.value = "";
  contextStatus.textContent = runId.value ? `Run ID ${runId.value}를 사용합니다.` : "선택한 Run 기록이 없습니다.";
  if (runId.value) void refreshStageRecords().catch(error => { contextStatus.textContent = error.message; });
  void refreshPreparation(true);
});
document.querySelector("#copyScanId").addEventListener("click", () => void copyContextId(scanId, "Scan ID").catch(error => { contextStatus.textContent = error.message; }));
document.querySelector("#copyRunId").addEventListener("click", () => void copyContextId(runId, "Run ID").catch(error => { contextStatus.textContent = error.message; }));
document.querySelector("#clearScanId").addEventListener("click", () => { scanId.value = ""; contextStatus.textContent = "사용 중인 Scan ID를 초기화했습니다."; });
document.querySelector("#clearRunId").addEventListener("click", () => { runId.value = ""; stageRecordStage.replaceChildren(new Option("Run을 선택한 뒤 불러오세요", "")); contextStatus.textContent = "사용 중인 Run ID를 초기화했습니다."; void refreshPreparation(true); });
document.querySelector("#deleteScanId").addEventListener("click", () => void deleteContextRecord("scan").catch(error => { contextStatus.textContent = error.message; }));
document.querySelector("#deleteRunId").addEventListener("click", () => void deleteContextRecord("run").catch(error => { contextStatus.textContent = error.message; }));
document.querySelector("#refreshStageRecords").addEventListener("click", () => void refreshStageRecords().catch(error => { contextStatus.textContent = error.message; }));
document.querySelector("#resetStageRecord").addEventListener("click", () => void resetSelectedStageRecord().catch(error => { contextStatus.textContent = error.message; }));
api.getStatus()
  .then(payload => {
    dashboardReady = true;
    document.querySelector("#mode").textContent = `${payload.workflowMode} · ${payload.operationMode}`;
    orderPrinterName.value = payload.orderPrinterName || "설정되지 않음";
    waybillPrinterName.value = payload.waybillPrinterName || "설정되지 않음";
    shipmentPrinterName.value = payload.shipmentPrinterName || "설정되지 않음";
    shipmentShipTime.placeholder = payload.defaultShipTime || "16:00";
    if (!freshStart && !scanId.value && payload.latestScanId) scanId.value = payload.latestScanId;
    if (!freshStart && !runId.value && payload.latestRunId) runId.value = payload.latestRunId;
    const logenSelect = document.querySelector("#logenMethod");
    logenSelect.value = pageSelection.get("logenMethod") || payload.defaultLogenMethod || "website_mcp";
    const updateLogenReadiness = () => {
      const selected = payload.logenMethods?.[logenSelect.value];
      const label = logenSelect.value === "api" ? "공식 API" : "웹사이트 MCP";
      const registration = selected?.registration?.message || "주문등록 상태를 확인할 수 없습니다.";
      const printing = selected?.printing?.message || "송장출력 상태를 확인할 수 없습니다.";
      document.querySelector("#logenReadiness").textContent = `${label} · 주문등록: ${registration} · 송장출력: ${printing}`;
      const testPopupReady = logenSelect.value === "api"
        && payload.logenMethods?.api?.environment === "test"
        && Boolean(payload.logenMethods?.api?.registration?.ready);
      logenTestPrintPopup.hidden = !testPopupReady;
      openLogenTestPrintPopup.disabled = !testPopupReady;
    };
    logenSelect.addEventListener("change", updateLogenReadiness);
    updateLogenReadiness();
    syncFloatingPanel();
    void refreshContexts();
    void refreshPreparation();
    if (runId.value) void refreshStageRecords().catch(error => { contextStatus.textContent = error.message; });
  })
  .catch(() => {
    document.querySelector("#mode").textContent = "상태 확인 필요";
    if (isBeginner) {
      panelText("beginnerTaskTitle", "서버 연결을 확인하세요");
      panelText("beginnerTaskHelp", "페이지를 새로고침해 다시 연결하세요. 계속 연결되지 않으면 전문가용에서 서버 상태를 확인하세요.");
    }
  });
