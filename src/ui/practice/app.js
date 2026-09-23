const STORAGE_KEY = "supplierhub-practice-v1";
const $ = (selector) => document.querySelector(selector);
const esc = (value) => String(value).replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
const model = createPracticeModel({ samples, scenarios, steps });
const fresh = model.fresh;
function restore() {
    try {
        return model.restore(localStorage.getItem(STORAGE_KEY));
    }
    catch {
        return fresh();
    }
}
let state = restore();
let pendingScenario = state.scenario;
const completed = stage => model.completed(state, stage);
const frontier = () => model.frontier(state);
const selectedOrders = () => model.selectedOrders(state);
const quantity = order => model.quantity(state, order);
const cartons = order => model.cartons(state, order);
const cartonTotal = () => model.cartonTotal(state);
const available = order => model.available(state, order);
const orderStatus = () => model.orderStatus(state);
function save() { try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}
catch {
    $("#progress-help").textContent = "이 브라우저에서는 진행 기록 저장을 사용할 수 없습니다.";
} }
function preview(title, body, padded = true) { return `<div class="preview"><div class="preview-bar"><span>${title}</span><span class="window-dots" aria-hidden="true"><i></i><i></i><i></i></span></div><div class="${padded ? "preview-content" : "table-wrap"}">${body}</div>${!padded ? '<p class="mobile-table-hint">표를 좌우로 밀어 모든 항목을 확인하세요.</p>' : ""}</div>`; }
function orderTable(mode = "list") {
    const orders = mode === "list" || mode === "select" ? samples : selectedOrders();
    return `<div class="table-wrap"><table><thead><tr>${mode === "select" ? "<th>선택</th>" : ""}<th>발주번호 / 상품</th><th>센터</th><th>발주수량</th>${mode === "quantity" ? "<th>출고 가능</th><th>확정수량</th>" : mode === "cartons" ? "<th>확정수량</th><th>입수 / 카톤</th>" : "<th>상태</th>"}</tr></thead><tbody>${orders.map(order => `<tr>${mode === "select" ? `<td><input type="checkbox" data-order="${order.id}" aria-label="${order.id} 선택" ${state.selected.includes(order.id) ? "checked" : ""} ${completed(4) ? "disabled" : ""}></td>` : ""}<td><div class="order-id">${order.id}</div><strong>${order.product}</strong></td><td>${order.center}</td><td>${order.quantity}개</td>${mode === "quantity" ? `<td>${available(order)}개</td><td><input class="quantity" type="number" min="1" max="${available(order)}" step="1" data-quantity="${order.id}" aria-label="${order.id} 확정수량" value="${quantity(order)}" ${completed(6) ? "disabled" : ""}></td>` : mode === "cartons" ? `<td>${quantity(order)}개</td><td>${order.pack}개 / <strong>${cartons(order)}카톤</strong></td>` : `<td><span class="pill ${orderStatus() === "발주확정" ? "green" : "amber"}">${orderStatus()}</span></td>`}</tr>`).join("")}</tbody></table></div>`;
}
function files(kind) { return `<div class="file-list">${(kind === "양식" ? [{ id: "선택발주" }] : selectedOrders()).map(order => `<div class="file-row"><span class="file-icon">${kind === "양식" ? "XLS" : "DOC"}</span><div><strong>예제_${order.id}_${kind}${kind === "양식" ? ".xlsx" : ""}</strong><small>실습 화면에서 확인하는 샘플 문서</small></div><span class="pill">미리보기</span></div>`).join("")}</div>`; }
function checkLine(text) { return `<label class="checkline"><input id="stage-confirm" type="checkbox" ${completed(state.view) ? "checked disabled" : ""}>${text}</label>`; }
function login(name) { return preview(`${name} · 접속 연습`, `<div class="login-preview"><div class="login-symbol" aria-hidden="true"><svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="4"/><path d="M5 21v-3a7 7 0 0 1 14 0v3"/></svg></div><div><div class="preview-title">${name} 실습 계정</div><p class="small">로그인 정보를 입력할 필요 없이<br>아래 버튼으로 접속 과정을 연습합니다.</p></div></div><div class="mock-account"><div><span class="small">샘플 사용자</span><br><strong>교육용 담당자 · TRAINING-01</strong></div><span class="pill green">연습 계정</span></div>`); }
function exercise(stage) {
    switch (stage) {
        case 1: return login("Supplier Hub");
        case 2: return preview("Private Label 발주 리스트 · 입고예정일 2026.09.15", orderTable() + `<div class="table-note">예제 발주 3건 · 총 발주수량 94개 · 모든 데이터는 가상입니다.</div>`, false);
        case 3: return preview("상태 분류 결과", `<div class="metrics"><div class="metric"><strong>${state.scenario === "confirmed" ? 0 : 3}<em>건</em></strong><span>거래처확인요청</span></div><div class="metric"><strong>${state.scenario === "confirmed" ? 3 : 0}<em>건</em></strong><span>발주확정</span></div><div class="metric"><strong>0<em>건</em></strong><span>기존 처리 중</span></div></div><p class="small" style="margin-top:20px">${state.scenario === "confirmed" ? "이번 예제는 이미 확정된 발주입니다. 4단계 선택 후 5~7단계를 건너뜁니다." : "이번 예제는 3건 모두 확정이 필요합니다. 5~7단계를 순서대로 연습합니다."}</p>`);
        case 4: return preview("이번에 처리할 발주를 선택하세요", orderTable("select"), false);
        case 5: return preview("발주확정 양식 미리보기", files("양식"));
        case 6: return preview("확정수량 작성 · 숫자를 직접 바꿔보세요", orderTable("quantity") + `<div class="table-note">${state.scenario === "shortage" ? "EX-1002는 재고가 20개입니다. 확정수량을 20개 이하로 조정하세요." : "이 예제의 출고 가능 수량은 발주수량과 같습니다."}</div>`, false);
        case 7: return preview("업로드 전 대상과 수량 확인", orderTable("cartons"), false) + checkLine("대상 발주와 확정수량을 확인했습니다.");
        case 8: return preview("선택 발주의 문서", files("발주서"));
        case 9: return preview("가상 인쇄 설정", `<label class="small" for="printer">발주서용 프린터</label><div style="margin:8px 0 17px"><select id="printer"><option>연습용 문서 프린터 A</option><option>연습용 문서 프린터 B</option></select></div>${files("발주서")}<p class="small" style="margin-top:12px">발주별 1부 · 실제 프린터로 전송되지 않습니다.</p>`);
        case 10: return preview("출력물 확인", `<div class="preview-title">발주서 ${selectedOrders().length}건의 출력 결과를 기록하세요.</div><p class="small">결과가 불명확할 때의 안내도 확인해 볼 수 있습니다.</p><div class="radio-row"><label><input type="radio" name="print-result" value="success" ${completed(10) ? "checked disabled" : ""}>정상 출력 확인</label><label><input type="radio" name="print-result" value="unknown" ${completed(10) ? "disabled" : ""}>출력 결과 불명확</label></div>`);
        case 11: return login("로젠");
        case 12: return preview("로젠 · 주문등록 / 출력(단건)", `<div class="preview-title">등록 화면의 작업 순서를 익혀보세요.</div><div class="process-strip"><span>신규 <strong>F3</strong></span><b>→</b><span>배송 정보 입력</span><b>→</b><span>저장 <strong>F5</strong></span></div><p class="small">실습에서는 다음 단계의 버튼으로 배송 주문을 모의 등록합니다.</p>`);
        case 13: return preview("배송 주문 · 카톤 계산", orderTable("cartons") + `<div class="table-note">선택 발주 ${selectedOrders().length}건 · 확정수량 ${selectedOrders().reduce((sum, order) => sum + quantity(order), 0)}개 · 합계 ${cartonTotal()}카톤</div>`, false);
        case 14: return preview("송장 미리보기 · 전체 " + cartonTotal() + "장", `<div class="waybill"><div class="waybill-header"><span>PRACTICE ONLY</span><span>1 / ${cartonTotal()}</span></div><h3>${selectedOrders()[0].center}</h3><p class="small">${selectedOrders()[0].product} · 첫 번째 카톤</p><div class="barcode" aria-hidden="true"></div><div class="order-id">EX-WB-${selectedOrders()[0].id.slice(3)}-01</div><p class="small" style="margin-top:9px">유효하지 않은 연습 송장입니다.</p></div>`) + checkLine("카톤 수와 연습 송장 장수를 확인했습니다.");
        case 15: return preview("발주별 쉽먼트 연결", `<div class="table-wrap"><table><thead><tr><th>발주번호</th><th>센터</th><th>연습 쉽먼트</th><th>카톤</th></tr></thead><tbody>${selectedOrders().map(order => `<tr><td class="order-id">${order.id}</td><td>${order.center}</td><td class="order-id">EX-SH-${order.id.slice(3)}</td><td>${cartons(order)}개</td></tr>`).join("")}</tbody></table></div><div class="table-note">예제 발송일 2026.09.14 16:00 · 입고예정일 2026.09.15</div>`, false) + checkLine("발주별 센터와 배송 정보를 확인했습니다.");
        case 16: return preview("최종 문서 · 가상 문서 프린터", files("라벨·내역서"));
    }
}
function render() {
    const progress = state.done.length + state.skipped.length;
    $("#progress-label").innerHTML = `${progress} <span>/ 16</span>`;
    $("#progress-fill").style.width = `${progress / 16 * 100}%`;
    $("#progress").setAttribute("aria-valuenow", String(progress));
    $("#progress-help").textContent = progress === 16 ? "모든 실습을 완료했습니다." : progress ? "기록이 저장되어 있어 이어서 연습할 수 있어요." : "첫 단계부터 차근차근 시작해 보세요.";
    document.querySelectorAll("[data-scenario]").forEach(button => button.setAttribute("aria-pressed", String(button.dataset.scenario === state.scenario)));
    $("#stage-nav").innerHTML = groups.map(group => `<div class="stage-group"><div class="group-label">${group.title}</div>${steps.slice(group.start - 1, group.end).map((step, index) => { const number = group.start + index; return `<button class="step-link ${state.view === number ? "current" : ""} ${state.done.includes(number) ? "done" : ""} ${state.skipped.includes(number) ? "skipped" : ""}" data-stage="${number}" aria-label="${number}단계 ${step.title}${state.skipped.includes(number) ? " 생략" : ""}" ${state.view === number ? 'aria-current="step"' : ""} ${number > frontier() ? "disabled" : ""}><span class="step-number">${state.done.includes(number) ? "✓" : String(number).padStart(2, "0")}</span><span class="step-name">${step.title}</span>${state.skipped.includes(number) ? '<span class="step-tail">생략</span>' : ""}</button>`; }).join("")}</div>`).join("");
    const activeStep = $("#stage-nav [aria-current=step]");
    if (activeStep && matchMedia("(max-width:760px)").matches) {
        const nav = $("#stage-nav");
        nav.scrollLeft = activeStep.offsetLeft - nav.offsetLeft - nav.clientWidth / 2 + activeStep.offsetWidth / 2;
    }
    const assigned = state.done.includes(4);
    $("#order-count").innerHTML = `${assigned ? selectedOrders().length : 0}<em>건</em>`;
    $("#carton-count").innerHTML = `${assigned ? cartonTotal() : 0}<em>개</em>`;
    $("#waybill-count").innerHTML = `${state.done.includes(14) ? cartonTotal() : 0}<em>장</em>`;
    $("#lesson-log").innerHTML = state.logs.length ? state.logs.slice(-3).reverse().map(log => `<li>${esc(log)}</li>`).join("") : "<li>아직 실행한 단계가 없습니다.</li>";
    $("#feedback").hidden = true;
    $("#feedback").className = "feedback";
    $("#instruction").hidden = false;
    $("#previous").hidden = false;
    if (state.view === 17) {
        renderCompletion();
        return;
    }
    const step = steps[state.view - 1];
    $("#step-label").textContent = `STEP ${String(state.view).padStart(2, "0")} / 16`;
    $("#lesson-title").textContent = step.title;
    $("#lesson-description").textContent = step.description;
    $("#exercise").innerHTML = exercise(state.view);
    $("#lesson-tip").textContent = step.tip;
    $("#previous").disabled = state.view === 1;
    $("#execute").textContent = completed(state.view) ? "다음 단계로 →" : step.action;
    $("#action-note").textContent = completed(state.view) ? "완료한 단계는 다시 실행하지 않습니다." : "샘플 데이터로 진행하는 실습입니다.";
    if (completed(state.view))
        feedback(state.skipped.includes(state.view) ? "이미 확정된 발주이므로 이 단계는 생략합니다." : step.result);
}
function feedback(message, error = false) { const element = $("#feedback"); element.hidden = false; element.className = "feedback" + (error ? " error" : ""); element.textContent = message; }
function renderCompletion() {
    $("#step-label").textContent = "PRACTICE COMPLETED";
    $("#lesson-title").textContent = "발주·배송 실습 완료";
    $("#lesson-description").textContent = scenarios[state.scenario] + " 예제를 끝까지 마쳤습니다.";
    $("#instruction").hidden = true;
    $("#exercise").innerHTML = `<div class="completion"><div class="completion-symbol" aria-hidden="true">✓</div><h2>한 번의 업무 흐름을 완주했어요.</h2><p>${state.done.length}개 단계 실행${state.skipped.length ? ` · ${state.skipped.length}개 단계 생략` : ""}</p><div class="metrics"><div class="metric"><strong>${selectedOrders().length}<em>건</em></strong><span>발주 처리</span></div><div class="metric"><strong>${cartonTotal()}<em>개</em></strong><span>카톤 준비</span></div><div class="metric"><strong>${cartonTotal()}<em>장</em></strong><span>연습 송장</span></div></div><div class="review-points"><strong>이번 실습에서 익힌 것</strong><p>✓ 발주 상태에 맞는 처리 단계 선택</p><p>✓ 확정수량과 입수수량으로 카톤 계산</p><p>✓ 출력 결과 확인과 발주별 쉽먼트 연결</p></div></div>`;
    $("#execute").textContent = "실습 결과 저장 ↓";
    $("#previous").disabled = false;
    $("#previous").textContent = "마지막 단계 보기";
    $("#action-note").textContent = "연습 결과를 텍스트 파일로 저장합니다.";
}
function go(stage) { state.view = stage; $("#previous").textContent = "이전 단계"; render(); save(); $("#lesson-title").focus({ preventScroll: true }); }
function nextStage() { return model.nextStage(state); }
function execute() {
    if (state.view === 17) {
        downloadResult();
        return;
    }
    if (completed(state.view)) {
        go(nextStage());
        return;
    }
    if (state.view !== frontier())
        return;
    const quantityInputs = [...document.querySelectorAll("[data-quantity]")];
    const outcome = model.complete(state, {
        selected: [...document.querySelectorAll("[data-order]:checked")].map(input => input.dataset.order),
        quantities: Object.fromEntries(quantityInputs.map(input => [input.dataset.quantity, input.value])),
        confirmed: $("#stage-confirm")?.checked,
        printResult: document.querySelector('[name="print-result"]:checked')?.value,
    });
    if (outcome.error) {
        feedback(outcome.error, true);
        quantityInputs.find(input => input.dataset.quantity === outcome.field)?.focus();
        return;
    }
    const stage = state.view;
    state = outcome.state;
    render();
    save();
    if (stage === 4 && state.scenario === "confirmed") {
        feedback("발주를 선택했습니다. 이미 확정된 발주이므로 5~7단계를 생략하고 8단계로 이동합니다.");
    }
}
function downloadResult() { const lines = ["Supplier Hub 실습 결과 — 모든 데이터는 가상입니다.", `예제: ${scenarios[state.scenario]}`, `완료: ${state.done.length}단계 / 생략: ${state.skipped.length}단계`, "", ...selectedOrders().map(order => `${order.id} | ${order.product} | ${order.center} | 확정 ${quantity(order)}개 | 입수 ${order.pack}개 | ${cartons(order)}카톤`), "", `합계 ${selectedOrders().length}개 발주, ${cartonTotal()}카톤, 연습 송장 ${cartonTotal()}장`, "", ...state.logs]; const blob = new Blob(["\ufeff" + lines.join("\r\n")], { type: "text/plain;charset=utf-8" }); const url = URL.createObjectURL(blob); const link = document.createElement("a"); link.href = url; link.download = "SupplierHub_실습결과.txt"; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
$("#execute").addEventListener("click", execute);
$("#previous").addEventListener("click", () => { let previous = state.view - 1; while (previous > 1 && state.skipped.includes(previous))
    previous--; go(Math.max(previous, 1)); });
$("#stage-nav").addEventListener("click", event => { const button = event.target.closest("[data-stage]"); if (button && !button.disabled)
    go(Number(button.dataset.stage)); });
document.querySelectorAll("[data-scenario]").forEach(button => button.addEventListener("click", () => { if (button.dataset.scenario === state.scenario)
    return; pendingScenario = button.dataset.scenario; if (state.done.length)
    $("#reset-dialog").showModal();
else {
    state = fresh(pendingScenario);
    render();
    save();
} }));
$("#reset-button").addEventListener("click", () => { pendingScenario = state.scenario; $("#reset-dialog").showModal(); });
$("#confirm-reset").addEventListener("click", () => { state = fresh(pendingScenario); $("#reset-dialog").close(); go(1); });
$("#cancel-reset").addEventListener("click", () => $("#reset-dialog").close());
$("#help-button").addEventListener("click", () => $("#help-dialog").showModal());
$("#close-help").addEventListener("click", () => $("#help-dialog").close());
render();
