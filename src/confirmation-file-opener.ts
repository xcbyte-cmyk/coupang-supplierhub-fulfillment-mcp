import { execFile } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { basename, extname, isAbsolute } from "node:path";
import type { FulfillmentRun } from "./fulfillment-types.js";
import type { WorkflowToolHandler } from "./server-tool-handlers.js";
import { prepareWorkspaceWindows } from "./workspace-window-layout.js";

type ReviewRun = Pick<FulfillmentRun, "id" | "orders" | "orderConfirmationJobs">;

/** Desktop UI action: resolve the prepared workbook from the run, never from a launch path supplied by the browser. */
export function createConfirmationFileOpener(options: {
  getRun: (runId: string) => ReviewRun;
  openFile?: (filePath: string) => Promise<void>;
}): WorkflowToolHandler {
  const openFile = options.openFile ?? openWorkbookInWindows;
  return async (input) => {
    const runId = requiredText(input.runId, "실행 ID");
    const orderNo = requiredText(input.orderNo, "발주번호");
    const expectedFilePath = requiredText(input.expectedFilePath, "검토 파일 정보");
    const run = options.getRun(runId);
    const job = run.orderConfirmationJobs?.find(item => item.orderNo === orderNo);
    if (run.id !== runId || !run.orders.some(order => order.orderNo === orderNo) || !job?.preparedFilePath) {
      throw new Error("이 실행의 발주에 연결된 확정 엑셀이 없습니다. 6단계 준비 기록을 확인하세요.");
    }
    if (expectedFilePath !== job.preparedFilePath) {
      throw new Error("준비 파일이 변경됐습니다. 검토 화면을 다시 열고 파일을 확인하세요.");
    }
    if (!isAbsolute(job.preparedFilePath) || extname(job.preparedFilePath).toLowerCase() !== ".xlsx") {
      throw new Error("실제 준비된 XLSX 파일만 열 수 있습니다. 실습용 파일은 열 수 없습니다.");
    }
    let filePath: string;
    try {
      filePath = await realpath(job.preparedFilePath);
      if (extname(filePath).toLowerCase() !== ".xlsx" || !(await stat(filePath)).isFile()) throw new Error("not a workbook");
    } catch {
      throw new Error("준비된 엑셀 파일을 찾을 수 없거나 접근할 수 없습니다. 파일 위치를 확인하세요.");
    }
    await openFile(filePath);
    return {
      status: "requested", runId, orderNo, fileName: basename(filePath),
      message: "파일 열기를 요청했습니다. 열린 엑셀 창에서 품목과 확정수량을 확인하세요.",
    };
  };
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label}가 필요합니다.`);
  return value.trim();
}

export function createOrderFileOpener(options: {
  getRun: (runId: string) => FulfillmentRun;
  openFile?: (filePath: string) => Promise<void>;
}): WorkflowToolHandler {
  return async input => {
    const runId = requiredText(input.runId, "실행 ID");
    const orderNo = requiredText(input.orderNo, "발주번호");
    const expectedFilePath = requiredText(input.expectedFilePath, "검토 파일 정보");
    const run = options.getRun(runId);
    const artifact = run.artifacts.find(file => file.type === "order_file" && file.status === "downloaded" &&
      file.orderNo === orderNo && file.filePath === expectedFilePath);
    if (!artifact) throw new Error("현재 실행에 연결된 발주서가 없습니다. 8단계 다운로드 기록을 확인하세요.");
    const opener = createConfirmationFileOpener({ openFile: options.openFile, getRun: () => ({
      ...run, orderConfirmationJobs: [{ runId, orderNo, sourceStatus: "발주확정", status: "prepared",
        preparedFilePath: artifact.filePath, createdAt: "", updatedAt: "" }],
    }) });
    const result = await opener(input) as Record<string, unknown>;
    return { ...result, message: "발주서 열기를 요청했습니다. 입수수량과 포장 안내를 확인하세요. 파일 열기만으로 확인 완료되지는 않습니다." };
  };
}

async function openWorkbookInWindows(filePath: string): Promise<void> {
  if (process.platform !== "win32") throw new Error("파일 열기는 이 서버가 실행되는 Windows PC에서 지원합니다.");
  await new Promise<void>((resolve, reject) => {
    // The fixed command reads the Unicode path as data from the environment;
    // spaces, quotes and PowerShell metacharacters never become command text.
    execFile("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-Command",
      "$ErrorActionPreference = 'Stop'; Start-Process -FilePath $env:SUPPLIERHUB_REVIEW_FILE -ErrorAction Stop",
    ], {
      windowsHide: true, timeout: 15000,
      env: { ...process.env, SUPPLIERHUB_REVIEW_FILE: filePath },
    }, (error) => {
      if (error) reject(new Error("Windows 파일 열기 요청을 확인하지 못했습니다. 열린 창 또는 XLSX 기본 앱 연결을 확인하세요."));
      else resolve();
    });
  });
  // A slow Excel start must not turn a successful file-open request into failure.
  await prepareWorkspaceWindows([filePath]).catch(() => undefined);
}
