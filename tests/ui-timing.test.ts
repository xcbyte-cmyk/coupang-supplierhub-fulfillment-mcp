import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const source = readFileSync(new URL("../src/ui/fulfillment/app.js", import.meta.url), "utf8");
const monitorSource = source.slice(source.indexOf("async function refreshFloatingRun("), source.indexOf("function saveFloatingSettings("));
function setup() {
  let resolve!: (value: unknown) => void;
  const pending = new Promise(done => { resolve = done; });
  const scope = {
    runId: { value: "run-1" }, monitoringBusy: false, preparationBusy: false, runReadRevision: 0,
    api: { postTool: vi.fn(() => pending) }, AbortSignal,
    syncFloatingPanel: vi.fn(), monitoredRun: undefined, monitoringError: "", monitoringCheckedAt: "",
    document: { querySelector: () => null }, renderRunStages: vi.fn(),
  };
  return { scope, resolve, refresh: runInNewContext(monitorSource + "\nrefreshFloatingRun;", scope) };
}
describe("monitor response ordering", () => {
  it("ignores a read begun before a same-run action completed", async () => {
    const { scope, resolve, refresh } = setup();
    const pending = refresh();
    scope.runReadRevision += 2;
    resolve({ id: "run-1", currentStage: 4 });
    await pending;
    expect(scope.renderRunStages).not.toHaveBeenCalled();
    expect(scope.monitoredRun).toBeUndefined();
    expect(scope.monitoringBusy).toBe(false);
  });
  it("ignores a previous selection and renders a current response", async () => {
    const stale = setup();
    const pending = stale.refresh();
    stale.scope.runId.value = "run-2";
    stale.resolve({ id: "run-1" });
    await pending;
    expect(stale.scope.renderRunStages).not.toHaveBeenCalled();
    const current = setup();
    const latest = current.refresh();
    current.resolve({ id: "run-1" });
    await latest;
    expect(current.scope.renderRunStages).toHaveBeenCalledOnce();
  });
  it("does not issue overlapping reads while an action is running", async () => {
    const { scope, refresh } = setup();
    scope.preparationBusy = true;
    await refresh();
    expect(scope.api.postTool).not.toHaveBeenCalled();
  });
});
