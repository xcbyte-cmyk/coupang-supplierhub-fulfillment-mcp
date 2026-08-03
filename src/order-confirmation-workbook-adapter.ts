import { spawn } from "node:child_process";
import { mkdir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  OrderConfirmationWorkbookPort,
  PreparedOrderConfirmationWorkbook,
} from "./fulfillment-types.js";

export interface OrderConfirmationWorkbookAdapterConfig {
  outputRoot: string;
  pythonExecutable?: string;
  scriptPath?: string;
}

interface PythonResult extends PreparedOrderConfirmationWorkbook {}

/**
 * Owns the workbook-specific implementation behind one preparation interface.
 * Browser callers only provide the downloaded template and selected PO numbers.
 */
export class OrderConfirmationWorkbookAdapter
  implements OrderConfirmationWorkbookPort
{
  private readonly outputRoot: string;
  private readonly pythonExecutable: string;
  private readonly scriptPath: string;

  constructor(config: OrderConfirmationWorkbookAdapterConfig) {
    this.outputRoot = resolve(config.outputRoot);
    this.pythonExecutable = config.pythonExecutable ?? "python";
    this.scriptPath = resolve(
      config.scriptPath ??
        join(
          dirname(fileURLToPath(import.meta.url)),
          "..",
          "scripts",
          "prepare-order-confirmation.py",
        ),
    );
  }

  async prepare(input: {
    runId: string;
    sourceFileName: string;
    sourceFilePath: string;
    orderNos: string[];
  }): Promise<PreparedOrderConfirmationWorkbook> {
    const orderNos = [...new Set(input.orderNos.map((value) => value.trim()).filter(Boolean))];
    if (orderNos.length === 0) throw new Error("확정용 엑셀에 반영할 발주가 없습니다.");

    const outputDir = resolve(this.outputRoot, safeFilePart(input.runId));
    await mkdir(outputDir, { recursive: true });
    const fileName = `발주서_확정_${safeFilePart(input.runId)}.xlsx`;
    const outputPath = resolve(outputDir, fileName);
    if (resolve(input.sourceFilePath) === outputPath) {
      throw new Error("다운로드한 원본 양식을 덮어쓸 수 없습니다.");
    }
    if (await isFile(outputPath)) {
      return { fileName, filePath: outputPath, orderNos, changedRows: orderNos.length };
    }

    return await runPython({
      pythonExecutable: this.pythonExecutable,
      scriptPath: this.scriptPath,
      sourceFilePath: resolve(input.sourceFilePath),
      outputPath,
      orderNos,
    });
  }
}

export class DemoOrderConfirmationWorkbookAdapter
  implements OrderConfirmationWorkbookPort
{
  async prepare(input: {
    runId: string;
    sourceFileName: string;
    sourceFilePath: string;
    orderNos: string[];
  }): Promise<PreparedOrderConfirmationWorkbook> {
    const orderNos = [...new Set(input.orderNos)];
    const fileName = `발주서_확정_${safeFilePart(input.runId)}_demo.xlsx`;
    return {
      fileName,
      filePath: `demo://${input.runId}/confirmation/${fileName}`,
      orderNos,
      changedRows: orderNos.length,
    };
  }
}

export class ModeRoutedOrderConfirmationWorkbookAdapter
  implements OrderConfirmationWorkbookPort
{
  constructor(
    private readonly getMode: () => "demo" | "live" | Promise<"demo" | "live">,
    private readonly demo: OrderConfirmationWorkbookPort,
    private readonly live: OrderConfirmationWorkbookPort,
  ) {}

  async prepare(input: {
    runId: string;
    sourceFileName: string;
    sourceFilePath: string;
    orderNos: string[];
  }): Promise<PreparedOrderConfirmationWorkbook> {
    return (await this.getMode()) === "live"
      ? this.live.prepare(input)
      : this.demo.prepare(input);
  }
}

async function runPython(input: {
  pythonExecutable: string;
  scriptPath: string;
  sourceFilePath: string;
  outputPath: string;
  orderNos: string[];
}): Promise<PythonResult> {
  const child = spawn(
    input.pythonExecutable,
    [input.scriptPath, "--source", input.sourceFilePath, "--output", input.outputPath],
    {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: { ...process.env, PYTHONUTF8: "1" },
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  const completed = new Promise<void>((resolvePromise, reject) => {
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("발주 확정 엑셀 작성 시간이 120초를 초과했습니다."));
    }, 120_000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) resolvePromise();
      else reject(new Error(stderr.trim() || `발주 확정 엑셀 작성기가 종료 코드 ${code}를 반환했습니다.`));
    });
  });

  child.stdin.end(JSON.stringify({ orderNos: input.orderNos }));
  await completed;
  try {
    return JSON.parse(stdout.trim()) as PythonResult;
  } catch {
    throw new Error(`발주 확정 엑셀 결과를 읽을 수 없습니다: ${stdout.trim() || stderr.trim()}`);
  }
}

async function isFile(filePath: string): Promise<boolean> {
  try {
    return (await stat(filePath)).isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function safeFilePart(value: string): string {
  return value.trim().replace(/[^0-9A-Za-z._-]+/g, "-").replace(/^-+|-+$/g, "") || "run";
}
