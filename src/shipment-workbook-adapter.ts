import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  FulfillmentCarton,
  FulfillmentOrder,
  LogenBatch,
  ShipmentWorkbookPort,
} from "./fulfillment-types.js";

export interface ShipmentWorkbookAdapterConfig {
  sourceWorkbook: string;
  outputRoot: string;
  pythonExecutable?: string;
  scriptPath?: string;
}

interface WorkbookManifest {
  orders: Array<{
    orderNo: string;
    centerCode: string;
    expectedInboundDate: string;
    transportType: string;
    items: Array<{
      skuCode: string;
      skuName: string;
      barcode?: string;
      confirmedQuantity: number;
    }>;
  }>;
  batches: Array<{
    id: string;
    orderNo: string;
    skuCode: string;
    cartonCount: number;
  }>;
  cartons: Array<{
    batchId: string;
    cartonIndex: number;
    quantity: number;
    slipNo: string | null;
  }>;
}

interface PythonResult {
  fileName: string;
  filePath: string;
}

/**
 * Builds a Supplier Hub shipment workbook without exposing workbook internals
 * at the workflow seam. Only PO/SKU/carton identifiers enter the subprocess.
 */
export class ShipmentWorkbookAdapter implements ShipmentWorkbookPort {
  private readonly sourceWorkbook: string;
  private readonly outputRoot: string;
  private readonly pythonExecutable: string;
  private readonly scriptPath: string;

  constructor(config: ShipmentWorkbookAdapterConfig) {
    this.sourceWorkbook = resolve(config.sourceWorkbook);
    this.outputRoot = resolve(config.outputRoot);
    this.pythonExecutable = config.pythonExecutable ?? "python";
    this.scriptPath = resolve(
      config.scriptPath ??
        join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "build-shipment-upload.py"),
    );
  }

  async build(input: {
    runId: string;
    orders: FulfillmentOrder[];
    batches: LogenBatch[];
    cartons: FulfillmentCarton[];
  }): Promise<{ fileName: string; filePath: string }> {
    await mkdir(this.outputRoot, { recursive: true });
    const manifest = buildManifest(input.orders, input.batches, input.cartons);
    const manifestHash = createHash("sha256")
      .update(JSON.stringify(manifest), "utf8")
      .digest("hex");
    const safeRunId = safeFilePart(input.runId);
    const fileName = `ShipmentsUpload_${safeRunId}_${manifestHash}.xlsx`;
    const outputPath = resolve(this.outputRoot, fileName);
    if (outputPath === this.sourceWorkbook) {
      throw new Error("원본 통합문서는 출력 파일로 덮어쓸 수 없습니다.");
    }
    if (await isFile(outputPath)) return { fileName, filePath: outputPath };

    const result = await runPython({
      pythonExecutable: this.pythonExecutable,
      scriptPath: this.scriptPath,
      sourceWorkbook: this.sourceWorkbook,
      outputPath,
      manifest,
    });
    if (resolve(result.filePath) !== outputPath) {
      throw new Error("XLSX 빌더가 요청하지 않은 출력 경로를 반환했습니다.");
    }
    return result;
  }
}

/** Side-effect-free workbook seam used with the demo shipment adapter. */
export class DemoShipmentWorkbookAdapter implements ShipmentWorkbookPort {
  async build(input: {
    runId: string;
    orders: FulfillmentOrder[];
    batches: LogenBatch[];
    cartons: FulfillmentCarton[];
  }): Promise<{ fileName: string; filePath: string }> {
    const manifest = buildManifest(input.orders, input.batches, input.cartons);
    const manifestHash = createHash("sha256")
      .update(JSON.stringify(manifest), "utf8")
      .digest("hex")
      .slice(0, 16);
    const fileName = `ShipmentsUpload_${safeFilePart(input.runId)}_${manifestHash}_demo.xlsx`;
    return {
      fileName,
      filePath: `demo://shipment-workbooks/${fileName}`,
    };
  }
}

export class BlockedShipmentWorkbookAdapter implements ShipmentWorkbookPort {
  constructor(
    private readonly reason =
      "Supplier Hub 쉽먼트 XLSX 원본 경로가 설정되지 않았습니다.",
  ) {}

  async build(_input: {
    runId: string;
    orders: FulfillmentOrder[];
    batches: LogenBatch[];
    cartons: FulfillmentCarton[];
  }): Promise<{ fileName: string; filePath: string }> {
    throw new Error(this.reason);
  }
}

export type ShipmentWorkbookMode = "demo" | "live" | "blocked";

export class ModeRoutedShipmentWorkbookAdapter implements ShipmentWorkbookPort {
  constructor(
    private readonly getMode: () => ShipmentWorkbookMode | Promise<ShipmentWorkbookMode>,
    private readonly demo: ShipmentWorkbookPort,
    private readonly live: ShipmentWorkbookPort,
    private readonly blocked: ShipmentWorkbookPort = new BlockedShipmentWorkbookAdapter(),
  ) {}

  async build(input: {
    runId: string;
    orders: FulfillmentOrder[];
    batches: LogenBatch[];
    cartons: FulfillmentCarton[];
  }): Promise<{ fileName: string; filePath: string }> {
    const mode = await this.getMode();
    if (mode === "demo") return this.demo.build(input);
    if (mode === "live") return this.live.build(input);
    return this.blocked.build(input);
  }
}

function buildManifest(
  orders: FulfillmentOrder[],
  batches: LogenBatch[],
  cartons: FulfillmentCarton[],
): WorkbookManifest {
  return {
    orders: orders
      .map((order) => ({
        orderNo: order.orderNo,
        centerCode: order.centerCode,
        expectedInboundDate: order.expectedInboundDate ?? "",
        transportType: order.transportType || "쉽먼트",
        items: order.items
          .map((item) => ({
            skuCode: item.skuCode,
            skuName: item.skuName,
            barcode: item.barcode,
            confirmedQuantity: item.orderedQuantity,
          }))
          .sort((left, right) => left.skuCode.localeCompare(right.skuCode)),
      }))
      .sort((left, right) => left.orderNo.localeCompare(right.orderNo)),
    batches: batches
      .map((batch) => ({
        id: batch.id,
        orderNo: batch.orderNo,
        skuCode: batch.skuCode,
        cartonCount: batch.cartonCount,
      }))
      .sort(
        (left, right) =>
          left.orderNo.localeCompare(right.orderNo) ||
          left.skuCode.localeCompare(right.skuCode) ||
          left.id.localeCompare(right.id),
      ),
    cartons: cartons
      .map((carton) => ({
        batchId: carton.batchId,
        cartonIndex: carton.cartonIndex,
        quantity: carton.quantity,
        slipNo: carton.slipNo ?? null,
      }))
      .sort(
        (left, right) =>
          left.batchId.localeCompare(right.batchId) || left.cartonIndex - right.cartonIndex,
      ),
  };
}

async function isFile(filePath: string): Promise<boolean> {
  try {
    return (await stat(filePath)).isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function runPython(input: {
  pythonExecutable: string;
  scriptPath: string;
  sourceWorkbook: string;
  outputPath: string;
  manifest: WorkbookManifest;
}): Promise<PythonResult> {
  const child = spawn(
    input.pythonExecutable,
    [
      input.scriptPath,
      "--source",
      input.sourceWorkbook,
      "--output",
      input.outputPath,
    ],
    {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: {
        ...process.env,
        PYTHONUTF8: "1",
        PYTHONIOENCODING: "utf-8",
      },
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
      reject(new Error("쉽먼트 XLSX 생성 시간이 120초를 초과했습니다."));
    }, 120_000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) resolvePromise();
      else reject(new Error(stderr.trim() || `쉽먼트 XLSX 생성기가 종료 코드 ${code}를 반환했습니다.`));
    });
  });

  child.stdin.end(JSON.stringify(input.manifest));
  await completed;
  try {
    return JSON.parse(stdout.trim()) as PythonResult;
  } catch {
    throw new Error(`쉽먼트 XLSX 생성 결과를 읽을 수 없습니다: ${stdout.trim() || stderr.trim()}`);
  }
}

function safeFilePart(value: string): string {
  const normalized = value.trim().replace(/[^0-9A-Za-z._-]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized || "run";
}
