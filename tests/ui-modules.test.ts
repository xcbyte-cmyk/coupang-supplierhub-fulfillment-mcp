import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const source = (path: string) => readFileSync(fileURLToPath(new URL(`../src/ui/${path}`, import.meta.url)), "utf8");
const model = () => runInNewContext(
  source("practice/curriculum.js") + "\n" + source("practice/model.js") + "\ncreatePracticeModel({ samples, scenarios, steps });",
);
const api = (fetchImpl: typeof fetch) => runInNewContext(
  source("fulfillment/api.js") + "\ncreateWorkflowApi(fetchImpl);",
  { fetchImpl },
);

function atStage(rules: ReturnType<typeof model>, stage: number, scenario = "basic") {
  return { ...rules.fresh(scenario), view: stage, done: Array.from({ length: stage - 1 }, (_, i) => i + 1) };
}

describe("isolated practice rules", () => {
  it.each(["basic", "confirmed"])("finishes %s without duplicating completed or skipped work", scenario => {
    const rules = model();
    let state = rules.fresh(scenario);
    while (state.view <= 16) {
      const result = rules.complete(state, {
        selected: state.selected, quantities: state.quantities, confirmed: true, printResult: "success",
      });
      expect(result.error).toBeUndefined();
      state = result.state;
      expect(rules.complete(state).state).toBe(state);
      if (state.view !== 17) state = { ...state, view: rules.nextStage(state) };
    }
    expect(state.view).toBe(17);
    expect(state.done.length).toBe(scenario === "confirmed" ? 13 : 16);
    expect(state.skipped).toEqual(scenario === "confirmed" ? [5, 6, 7] : []);
    expect(rules.cartonTotal(state)).toBe(11);
    expect(rules.frontier(state)).toBe(17);
  });

  it("applies valid shortage quantities atomically and retains selected-order carton totals", () => {
    const rules = model();
    const state = atStage(rules, 6, "shortage");
    const invalid = rules.complete(state, { quantities: { "EX-1001": 20, "EX-1002": 30 } });
    expect(invalid.field).toBe("EX-1002");
    expect(invalid.error).toContain("1~20");
    expect(state.quantities["EX-1001"]).toBe(40);
    const result = rules.complete(state, { quantities: { "EX-1001": 20, "EX-1002": 20 } });
    expect(result.error).toBeUndefined();
    expect(rules.cartonTotal(result.state)).toBe(8);
    expect(rules.cartonTotal({ ...result.state, selected: ["EX-1002"] })).toBe(2);
  });

  it("preserves review and uncertain-print stops without advancing progress", () => {
    const rules = model();
    for (const stage of [7, 14, 15]) {
      const state = atStage(rules, stage);
      expect(rules.complete(state).error).toContain("확인란");
      expect(state.done).not.toContain(stage);
    }
    expect(rules.complete(atStage(rules, 10), { printResult: "unknown" }).error).toContain("자동 재출력하지 않고");
    expect(rules.complete(atStage(rules, 4), { selected: [] }).error).toContain("1건 이상");
  });

  it("restores the existing storage shape and resets only invalid practice data", () => {
    const rules = model();
    const saved = atStage(rules, 8, "confirmed");
    saved.done = [1, 2, 3, 4];
    saved.skipped = [5, 6, 7];
    expect(rules.restore(JSON.stringify(saved))).toEqual(saved);
    expect(rules.restore("{invalid")).toEqual(rules.fresh());
    expect(rules.restore(JSON.stringify({ ...saved, selected: ["unknown"] }))).toEqual(rules.fresh());
  });
});

describe("workflow UI transport", () => {
  it("retains the UI marker, encoded tool name, payload and cancellation signal", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('{"id":"run-1"}'));
    const signal = new AbortController().signal;
    const result = await api(fetchImpl).postTool("get/실행", { runId: "run-1" }, { signal });
    expect(result.id).toBe("run-1");
    expect(fetchImpl).toHaveBeenCalledExactlyOnceWith("/api/fulfillment/tools/get%2F%EC%8B%A4%ED%96%89", {
      method: "POST", signal, body: '{"runId":"run-1"}',
      headers: { "content-type": "application/json", "x-workflow-ui": "supplierhub-dashboard" },
    });
  });

  it("keeps status reads separate from mutations and surfaces failed or malformed responses", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response('{"workflowMode":"demo"}'))
      .mockResolvedValueOnce(new Response('{"error":"Forbidden origin"}', { status: 403 }))
      .mockResolvedValueOnce(new Response("일시 중단", { status: 503 }))
      .mockResolvedValueOnce(new Response("<html>unexpected</html>"));
    const client = api(fetchImpl);
    expect((await client.getStatus()).workflowMode).toBe("demo");
    expect(fetchImpl.mock.calls[0]).toEqual(["/api/fulfillment/status", { headers: { "x-workflow-ui": "supplierhub-dashboard" } }]);
    await expect(client.postTool("example")).rejects.toThrow("Forbidden origin");
    await expect(client.postTool("example")).rejects.toThrow("일시 중단");
    await expect(client.getStatus()).rejects.toThrow("서버 응답을 읽지 못했습니다");
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });
});
