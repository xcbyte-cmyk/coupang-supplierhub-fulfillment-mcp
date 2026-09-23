import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

const source = readFileSync(new URL("../src/ui/fulfillment/app.js", import.meta.url), "utf8");
const ast = ts.createSourceFile("app.js", source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);
const functions = ast.statements.filter(node => ts.isFunctionDeclaration(node)
  && ["isEmptySelectionResult", "showSelectionNotice", "nextBeginnerAction"].includes(node.name?.text ?? ""))
  .map(node => node.getText(ast)).join("\n");

function harness() {
  const summary = { textContent: "", classList: { remove: vi.fn() } };
  const showExistingWork = vi.fn().mockResolvedValue(undefined);
  const group = { textContent: "" };
  const runId = { value: "" };
  const context = { summary, showExistingWork, document: { querySelector: () => group }, runId, dashboardReady: true };
  const api = runInNewContext("let selectionNotice = false;\n" + functions + "\n({showSelectionNotice, nextBeginnerAction})", context);
  return { api, summary, showExistingWork, runId };
}

describe("no new order selection guidance", () => {
  it("offers explicit resume without selecting a run or marking stage 4 completed", async () => {
    const h = harness();
    const card = { dataset: { status: "blocked" }, classList: { remove: vi.fn() } };
    const stage = { textContent: "" };
    const handled = await h.api.showSelectionNotice("select_orders_for_fulfillment", {
      status: "blocked", message: "3단계 결과에 새로 배정할 발주가 없습니다. 이전 실행은 자동으로 선택하지 않습니다.",
    }, card, stage);
    expect(handled).toBe(true);
    expect(h.summary.classList.remove).toHaveBeenCalledWith("error");
    expect(card.dataset.status).toBe("waiting");
    expect(h.showExistingWork).toHaveBeenCalledOnce();
    expect(h.runId.value).toBe("");
    expect(h.api.nextBeginnerAction().kind).toBe("resume");
  });

  it("keeps actual errors and other review stops visible", async () => {
    const h = harness();
    for (const [tool, payload] of [
      ["select_orders_for_fulfillment", { status: "failed", message: "DB 오류" }],
      ["select_orders_for_fulfillment", { status: "blocked", message: "입력한 발주번호가 없습니다." }],
      ["register_logen_delivery_order", { status: "blocked", message: "포장 기준 확인 필요" }],
    ]) expect(await h.api.showSelectionNotice(tool, payload)).toBe(false);
    expect(h.showExistingWork).not.toHaveBeenCalled();
    expect(h.summary.classList.remove).not.toHaveBeenCalled();
  });
});
