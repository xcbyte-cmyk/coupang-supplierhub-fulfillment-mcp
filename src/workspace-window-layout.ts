import { execFile } from "node:child_process";
import { basename, extname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "playwright-core";
import type { FulfillmentRun } from "./fulfillment-types.js";
import type { WorkflowToolHandler } from "./server-tool-handlers.js";

const helperPath = fileURLToPath(new URL("../scripts/focus-browser-window.ps1", import.meta.url));
const browserProcesses = new Set<number>();
export function trackWorkspaceBrowser(pid: number): () => void {
  browserProcesses.add(pid);
  return () => { browserProcesses.delete(pid); };
}

export interface WindowLayoutResult {
  code: string;
  moved: number;
  matched: number;
  left?: number;
  top?: number;
  width?: number;
  height?: number;
}

export function prepareWorkspaceWindows(documentPaths: string[] = []): Promise<WindowLayoutResult> {
  if (process.platform !== "win32") return Promise.resolve({ code: "unsupported", moved: 0, matched: 0 });
  const documents = [...new Set(documentPaths.filter(path => [".xlsx", ".xls", ".pdf"].includes(extname(path).toLowerCase()))
    .map(path => basename(path)))].slice(0, 100);
  return new Promise((resolve, reject) => {
    execFile("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", helperPath, "-PrepareWorkspace",
    ], {
      windowsHide: true, timeout: 8000, maxBuffer: 64 * 1024,
      env: { ...process.env,
        SUPPLIERHUB_LAYOUT_TARGETS: Buffer.from(JSON.stringify({ processes: [...browserProcesses], documents }), "utf8").toString("base64"),
      },
    }, (error, stdout) => {
      if (error) { reject(new Error("창 배치를 준비하지 못했습니다. 업무 창을 열어 둔 뒤 다시 눌러 주세요.")); return; }
      try {
        const result = JSON.parse(stdout.trim()) as WindowLayoutResult;
        if (typeof result.code !== "string" || !Number.isInteger(result.moved)) throw new Error("invalid layout result");
        resolve(result);
      } catch { reject(new Error("창 배치 결과를 확인하지 못했습니다.")); }
    });
  });
}

export function createWorkspaceWindowPreparer(options: {
  getRun: (runId: string) => FulfillmentRun;
  prepare?: typeof prepareWorkspaceWindows;
}): WorkflowToolHandler {
  return async input => {
    const runId = typeof input.runId === "string" ? input.runId.trim() : "";
    const run = runId ? options.getRun(runId) : undefined;
    const paths = run ? [
      ...run.artifacts.map(file => file.filePath),
      ...(run.orderConfirmationJobs ?? []).flatMap(job => [job.preparedFilePath, job.templateFilePath]),
    ].filter((path): path is string => Boolean(path)) : [];
    const result = await (options.prepare ?? prepareWorkspaceWindows)(paths);
    const ready = result.code === "ready";
    const messages: Record<string, string> = {
      ready: result.moved ? `업무 화면은 왼쪽, 열린 작업 창 ${result.moved}개는 오른쪽에 배치했습니다. 여러 창은 오른쪽에 겹쳐 놓입니다.`
        : "업무 화면을 왼쪽에 배치하고 오른쪽 공간을 준비했습니다. 쿠팡·로젠 화면은 해당 단계에서 열면 됩니다.",
      dashboard_missing: "업무 화면 창을 찾지 못했습니다. 이 페이지를 일반 브라우저 창에 열고 앞에 표시한 뒤 다시 눌러 주세요.",
      screen_small: "현재 모니터가 분할 배치에 너무 작습니다. 더 넓은 화면에서 다시 준비해 주세요.",
      partial: "일부 창의 위치를 바꾸지 못했습니다. 열린 창을 확인한 뒤 다시 눌러 주세요.",
      unsupported: "분할화면 준비는 서버가 실행되는 Windows PC에서 사용할 수 있습니다.",
    };
    return { status: ready ? "completed" : "attention", ready, movedWindows: result.moved,
      message: messages[result.code] ?? "창 배치 결과를 확인해 주세요. 업무 실행은 시작하지 않았습니다." };
  };
}

/** Arrange the exact browser popup/window, including sessions without a known OS PID. */
export async function arrangeBrowserPage(page: Page): Promise<void> {
  const result = await prepareWorkspaceWindows();
  if (result.code !== "ready" || !result.width || !result.height) return;
  const session = await page.context().newCDPSession(page);
  try {
    const { windowId } = await session.send("Browser.getWindowForTarget");
    await session.send("Browser.setWindowBounds", { windowId, bounds: { windowState: "normal" } });
    await session.send("Browser.setWindowBounds", { windowId, bounds: {
      left: result.left, top: result.top, width: result.width, height: result.height,
    } });
  } finally { await session.detach(); }
}
