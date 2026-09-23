/** Pure practice rules. No DOM, storage, network, accounts, or printers. */
function createPracticeModel({ samples, scenarios, steps }) {
    const lastStage = steps.length;
    const completed = (state, stage) => state.done.includes(stage) || state.skipped.includes(stage);
    const frontier = state => steps.findIndex((_, index) => !completed(state, index + 1)) + 1 || lastStage + 1;
    const selectedOrders = state => samples.filter(order => state.selected.includes(order.id));
    const quantity = (state, order) => Number(state.quantities[order.id] ?? order.quantity);
    const cartons = (state, order) => Math.ceil(quantity(state, order) / order.pack);
    const cartonTotal = state => selectedOrders(state).reduce((total, order) => total + cartons(state, order), 0);
    const available = (state, order) => state.scenario === "shortage" && order.id === "EX-1002" ? 20 : order.quantity;
    const orderStatus = state => state.scenario === "confirmed" || state.done.includes(7) ? "발주확정" : "거래처확인요청";
    function fresh(scenario = "basic") {
        return {
            version: 1, scenario, view: 1, done: [], skipped: [],
            selected: samples.map(order => order.id),
            quantities: Object.fromEntries(samples.map(order => [order.id, order.quantity])),
            logs: [],
        };
    }
    function restore(raw) {
        try {
            const saved = JSON.parse(raw);
            if (saved?.version === 1 && Object.hasOwn(scenarios, saved.scenario)
                && Number.isInteger(saved.view) && saved.view >= 1 && saved.view <= lastStage + 1
                && Array.isArray(saved.done) && Array.isArray(saved.skipped)
                && Array.isArray(saved.selected) && saved.selected.every(id => samples.some(order => order.id === id))
                && saved.quantities && Array.isArray(saved.logs))
                return saved;
        }
        catch { }
        return fresh();
    }
    function nextStage(state) {
        let next = state.view + 1;
        while (next <= lastStage && state.skipped.includes(next))
            next++;
        return Math.min(next, lastStage + 1);
    }
    function complete(state, input = {}) {
        const stage = state.view;
        if (stage > lastStage || completed(state, stage) || stage !== frontier(state))
            return { state };
        let selected = state.selected;
        let quantities = state.quantities;
        if (stage === 4) {
            selected = input.selected ?? [];
            if (!selected.length)
                return { error: "처리할 발주를 1건 이상 선택해 주세요." };
        }
        if (stage === 6) {
            quantities = { ...state.quantities };
            for (const [id, raw] of Object.entries(input.quantities ?? {})) {
                const order = samples.find(item => item.id === id);
                const value = Number(raw);
                if (!Number.isInteger(value) || value < 1 || value > available(state, order)) {
                    return { error: `${order.id}: 확정수량은 1~${available(state, order)}개 사이의 정수로 입력해 주세요.`, field: id };
                }
                quantities[id] = value;
            }
        }
        if ([7, 14, 15].includes(stage) && !input.confirmed) {
            return { error: "미리보기 내용을 확인한 뒤 확인란을 선택해 주세요." };
        }
        if (stage === 10 && input.printResult !== "success") {
            return { error: input.printResult === "unknown"
                    ? "출력 결과가 불명확합니다. 자동 재출력하지 않고 멈춥니다. 예제 출력물을 확인했다고 가정한 뒤 ‘정상 출력 확인’을 선택해 보세요."
                    : "출력물 확인 결과를 선택해 주세요." };
        }
        const next = {
            ...state, selected, quantities, done: [...state.done, stage],
            logs: [...state.logs, `${String(stage).padStart(2, "0")} · ${steps[stage - 1].title} 완료`],
        };
        if (stage === 4 && state.scenario === "confirmed") {
            next.skipped = [5, 6, 7];
            next.logs.push("05~07 · 이미 확정된 발주이므로 생략");
        }
        if (stage === lastStage)
            next.view = lastStage + 1;
        return { state: next };
    }
    return { fresh, restore, completed, frontier, selectedOrders, quantity, cartons, cartonTotal, available, orderStatus, nextStage, complete };
}
