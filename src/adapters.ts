import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import AdmZip from "adm-zip";
import {
  chromium,
  type BrowserContext,
  type Page,
} from "playwright-core";
import type {
  ConnectionStatus,
  PreparedFile,
  PrinterPort,
  PrintResult,
  ScanResult,
  SupplierHubPort,
  SupplierOrder,
  WorkflowSettings,
} from "./types.js";

const PRIVATE_LABEL_URL = "https://supplier.coupang.com/po-web/cplb/po/list";

const DEMO_ORDERS: SupplierOrder[] = [
  {
    orderNo: "DEMO-PO-001",
    poType: "일반",
    orderType: "일반",
    status: "발주확정",
    createdAt: "2026-07-29T09:30:00+09:00",
    transportType: "쉽먼트",
    firstSkuName: "데모 코멧 TPU 양면 도마 · 차콜",
    skuCount: 1,
    center: "이천2",
    quantity: 100,
    expectedInboundDate: "2026-08-01",
    source: "demo",
  },
  {
    orderNo: "DEMO-PO-002",
    poType: "일반",
    orderType: "일반",
    status: "발주확정",
    createdAt: "2026-07-29T10:10:00+09:00",
    transportType: "쉽먼트",
    firstSkuName: "데모 코멧 TPU 양면 도마 · 아이스블루",
    skuCount: 1,
    center: "고양1",
    quantity: 200,
    expectedInboundDate: "2026-08-01",
    source: "demo",
  },
  {
    orderNo: "DEMO-PO-003",
    poType: "일반",
    orderType: "일반",
    status: "발주확정",
    createdAt: "2026-07-30T11:20:00+09:00",
    transportType: "쉽먼트",
    firstSkuName: "데모 코멧 걸이형 양면 도마 · 웜그레이",
    skuCount: 1,
    center: "전라광주2",
    quantity: 150,
    expectedInboundDate: "2026-08-02",
    source: "demo",
  },
];

export class DemoSupplierHubAdapter implements SupplierHubPort {
  async openLogin(): Promise<ConnectionStatus> {
    return {
      status: "ready",
      message: "데모 모드에는 Supplier Hub 로그인이 필요하지 않습니다.",
    };
  }

  async scan(): Promise<ScanResult> {
    return {
      connection: {
        status: "ready",
        message: "데모 발주 3건을 조회했습니다.",
      },
      orders: structuredClone(DEMO_ORDERS),
    };
  }

  async prepare(orderNos: string[], batchId: string): Promise<PreparedFile[]> {
    return orderNos.map((orderNo) => {
      const content = Buffer.from(`demo:${batchId}:${orderNo}`, "utf8");
      return {
        orderNo,
        fileName: `발주서리스트_${orderNo}.xlsx`,
        filePath: `demo://${batchId}/${orderNo}.xlsx`,
        sha256: createHash("sha256").update(content).digest("hex"),
        sizeBytes: content.length,
      };
    });
  }
}

export class DryRunPrinterAdapter implements PrinterPort {
  async print(
    files: PreparedFile[],
    settings: WorkflowSettings,
  ): Promise<PrintResult> {
    return {
      success: true,
      submittedFiles: files.map((file) => file.fileName),
      message: `데모 인쇄 완료: ${settings.printerName}, ${settings.copies}부, ${files.length}개 파일`,
    };
  }
}

export class SupplierHubBrowserAdapter implements SupplierHubPort {
  private context?: BrowserContext;
  private page?: Page;

  constructor(
    private readonly profileDir: string,
    private readonly downloadsDir: string,
  ) {}

  async openLogin(): Promise<ConnectionStatus> {
    try {
      const page = await this.getPage();
      await page.goto(PRIVATE_LABEL_URL, { waitUntil: "domcontentloaded" });
      await page.bringToFront();
      const status = await this.connectionStatus(page);
      return {
        ...status,
        message:
          status.status === "ready"
            ? "Supplier Hub 로그인 세션이 준비되었습니다."
            : "열린 Chrome 창에서 Supplier Hub에 직접 로그인한 뒤 다시 연결 확인을 누르세요.",
      };
    } catch (error) {
      return {
        status: "error",
        message: errorMessage(error),
      };
    }
  }

  async scan(settings: WorkflowSettings): Promise<ScanResult> {
    const page = await this.getPage();
    await page.goto(PRIVATE_LABEL_URL, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(800);

    const connection = await this.connectionStatus(page);
    if (connection.status !== "ready") {
      return { connection, orders: [] };
    }

    await this.applyOperationalRange(page, settings.lookAheadDays);
    const orders = await this.collectAllPages(page);
    return {
      connection: {
        status: "ready",
        message: `Private Label 발주 ${orders.length}건을 조회했습니다.`,
        url: page.url(),
      },
      orders,
    };
  }

  async prepare(orderNos: string[], batchId: string): Promise<PreparedFile[]> {
    if (orderNos.length === 0) throw new Error("준비할 발주번호가 없습니다.");
    if (orderNos.length > 100) throw new Error("한 번에 최대 100건까지 준비할 수 있습니다.");

    const page = await this.getPage();
    await page.goto(PRIVATE_LABEL_URL, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(800);
    const connection = await this.connectionStatus(page);
    if (connection.status !== "ready") throw new Error(connection.message);

    const orderInput = page.getByPlaceholder(
      "발주번호를 (,)로 구분하여 입력해주세요",
      { exact: true },
    );
    if ((await orderInput.count()) !== 1) {
      throw new Error("Supplier Hub 발주번호 입력란을 찾지 못했습니다. 화면 변경을 확인하세요.");
    }

    await orderInput.fill(orderNos.join(","));
    await this.clickUniqueButton(page, "검색");
    await page.waitForTimeout(900);

    for (const orderNo of orderNos) {
      const rows = page.locator("tbody tr").filter({ hasText: orderNo });
      const rowCount = await rows.count();
      if (rowCount === 0) throw new Error(`발주 ${orderNo} 행을 찾지 못했습니다.`);

      let checked = false;
      for (let index = 0; index < rowCount; index += 1) {
        const checkbox = rows.nth(index).locator('input[type="checkbox"]');
        if ((await checkbox.count()) === 1) {
          await checkbox.check();
          checked = true;
          break;
        }
      }
      if (!checked) throw new Error(`발주 ${orderNo} 선택란을 찾지 못했습니다.`);
    }

    const downloadButton = page.getByRole("button", {
      name: "발주서",
      exact: true,
    });
    if ((await downloadButton.count()) !== 1) {
      throw new Error("발주서 다운로드 버튼을 찾지 못했습니다.");
    }

    const immediateDownload = page
      .waitForEvent("download", { timeout: 2_000 })
      .catch(() => undefined);
    await downloadButton.click();
    let download = await immediateDownload;

    if (!download) {
      const dialog = page.locator('[role="dialog"]:visible, .ant-modal:visible');
      await dialog.waitFor({ state: "visible", timeout: 5_000 });
      const confirm = dialog.getByRole("button", { name: /확인|다운로드/ });
      const confirmCount = await confirm.count();
      if (confirmCount !== 1) {
        throw new Error("발주서 다운로드 확인 버튼을 식별하지 못했습니다.");
      }
      const downloadPromise = page.waitForEvent("download", { timeout: 30_000 });
      await confirm.click();
      download = await downloadPromise;
    }

    const batchDir = join(this.downloadsDir, batchId);
    await mkdir(batchDir, { recursive: true });
    const suggestedName = sanitizeFileName(download.suggestedFilename() || `${batchId}.zip`);
    const sourcePath = join(batchDir, suggestedName);
    await download.saveAs(sourcePath);
    return this.validateAndExtract(sourcePath, batchDir, orderNos);
  }

  async close(): Promise<void> {
    await this.context?.close();
    this.context = undefined;
    this.page = undefined;
  }

  private async getPage(): Promise<Page> {
    if (!this.context) {
      await mkdir(this.profileDir, { recursive: true });
      this.context = await chromium.launchPersistentContext(this.profileDir, {
        channel: "chrome",
        headless: false,
        acceptDownloads: true,
        viewport: { width: 1440, height: 960 },
      });
      this.context.on("close", () => {
        this.context = undefined;
        this.page = undefined;
      });
    }

    if (!this.page || this.page.isClosed()) {
      this.page = this.context.pages()[0] ?? (await this.context.newPage());
    }
    return this.page;
  }

  private async connectionStatus(page: Page): Promise<ConnectionStatus> {
    const url = page.url();
    const hasListHeading =
      (await page.getByRole("heading", {
        name: "Private Label 발주 리스트",
        exact: true,
      }).count()) === 1;

    if (hasListHeading && url.includes("/po-web/cplb/po/list")) {
      return { status: "ready", message: "로그인됨", url };
    }
    if (/\/auth\/|login|sign-in/i.test(url)) {
      return { status: "login_required", message: "Supplier Hub 로그인이 필요합니다.", url };
    }
    return {
      status: "error",
      message: "Private Label 발주 리스트 화면을 확인할 수 없습니다.",
      url,
    };
  }

  private async applyOperationalRange(page: Page, lookAheadDays: number): Promise<void> {
    const quickRangeLabel = lookAheadDays <= 7 ? "다음 7일" : "다음 30일";
    const rangeButton = page.getByRole("button", {
      name: quickRangeLabel,
      exact: true,
    });
    if ((await rangeButton.count()) === 1 && (await rangeButton.isVisible())) {
      await rangeButton.click();
    }

    const search = page.getByRole("button", { name: "검색", exact: true });
    if ((await search.count()) !== 1) {
      throw new Error("Supplier Hub 검색 버튼을 찾지 못했습니다. 화면 변경을 확인하세요.");
    }
    await search.click();
    await page.waitForTimeout(900);
  }

  private async collectAllPages(page: Page): Promise<SupplierOrder[]> {
    const collected = new Map<string, SupplierOrder>();

    for (let pageNumber = 0; pageNumber < 50; pageNumber += 1) {
      const pageOrders = await this.readVisibleOrders(page);
      for (const order of pageOrders) collected.set(order.orderNo, order);

      const next = page.locator("li.ant-pagination-next");
      if ((await next.count()) !== 1) break;
      const classes = (await next.getAttribute("class")) ?? "";
      const button = next.locator("button");
      if (classes.includes("ant-pagination-disabled") || (await button.isDisabled())) break;
      await button.click();
      await page.waitForTimeout(700);
    }

    return [...collected.values()];
  }

  private async readVisibleOrders(page: Page): Promise<SupplierOrder[]> {
    return page.evaluate(() => {
      const trim = (value: string | null | undefined) =>
        String(value ?? "").replace(/\s+/g, " ").trim();
      const toNumber = (value: string | undefined) => {
        const parsed = Number(String(value ?? "0").replace(/[^0-9.-]/g, ""));
        return Number.isFinite(parsed) ? parsed : 0;
      };
      const rows = Array.from(document.querySelectorAll("table tbody tr"));
      const orders: SupplierOrder[] = [];

      for (const row of rows) {
        const cells = Array.from(row.querySelectorAll("td")).map((cell) =>
          trim(cell.textContent),
        );
        const poIndex = cells.findIndex((cell) => /^\d{8,}$/.test(cell));
        if (poIndex < 0) continue;
        const at = (offset: number) => cells[poIndex + offset] ?? "";
        const createdRaw = at(4);
        const dateCandidates = cells.filter((cell) => /^\d{4}-\d{2}-\d{2}(?:\s|$)/.test(cell));

        orders.push({
          orderNo: at(0),
          poType: at(1),
          orderType: at(2),
          status: at(3),
          createdAt: createdRaw.replace(" ", "T"),
          transportType: at(6),
          firstSkuName: at(9),
          skuCount: toNumber(at(10)),
          center: at(11),
          quantity: toNumber(at(12)),
          expectedInboundDate:
            [...dateCandidates].reverse().find((value) => /^\d{4}-\d{2}-\d{2}$/.test(value)) ??
            at(15),
          source: "live",
        });
      }

      return orders;
    });
  }

  private async clickUniqueButton(page: Page, name: string): Promise<void> {
    const button = page.getByRole("button", { name, exact: true });
    if ((await button.count()) !== 1) throw new Error(`${name} 버튼을 찾지 못했습니다.`);
    await button.click();
  }

  private async validateAndExtract(
    sourcePath: string,
    batchDir: string,
    orderNos: string[],
  ): Promise<PreparedFile[]> {
    const sourceStat = await stat(sourcePath);
    if (sourceStat.size > 100 * 1024 * 1024) {
      throw new Error("다운로드 파일이 100MB 제한을 초과했습니다.");
    }

    const lower = sourcePath.toLowerCase();
    const candidates: Array<{ name: string; data: Buffer }> = [];
    if (lower.endsWith(".xlsx")) {
      candidates.push({ name: basename(sourcePath), data: await readFile(sourcePath) });
    } else {
      const zip = new AdmZip(sourcePath);
      const entries = zip.getEntries();
      if (entries.length > 500) throw new Error("ZIP 항목 수가 안전 제한을 초과했습니다.");

      for (const entry of entries) {
        if (entry.isDirectory) continue;
        const normalized = entry.entryName.replaceAll("\\", "/");
        if (normalized.startsWith("/") || normalized.split("/").includes("..")) {
          throw new Error("ZIP 내부에 안전하지 않은 경로가 있습니다.");
        }
        if (!normalized.toLowerCase().endsWith(".xlsx")) continue;
        candidates.push({ name: basename(normalized), data: entry.getData() });
      }
    }

    if (candidates.length !== orderNos.length) {
      throw new Error(
        `발주서 수가 일치하지 않습니다. 요청 ${orderNos.length}건, XLSX ${candidates.length}건`,
      );
    }

    const prepared: PreparedFile[] = [];
    const unmatched = new Set(orderNos);
    for (const candidate of candidates) {
      if (candidate.data.length > 25 * 1024 * 1024) {
        throw new Error(`${candidate.name} 파일이 25MB 제한을 초과했습니다.`);
      }
      const workbookZip = new AdmZip(candidate.data);
      if (!workbookZip.getEntry("xl/workbook.xml")) {
        throw new Error(`${candidate.name} 파일은 정상적인 XLSX가 아닙니다.`);
      }

      const orderNo = orderNos.find((value) => candidate.name.includes(value)) ??
        (unmatched.size === 1 ? [...unmatched][0] : undefined);
      if (!orderNo || !unmatched.has(orderNo)) {
        throw new Error(`${candidate.name} 파일을 발주번호와 매칭하지 못했습니다.`);
      }
      unmatched.delete(orderNo);

      const fileName = sanitizeFileName(candidate.name);
      const filePath = join(batchDir, fileName);
      await writeFile(filePath, candidate.data);
      prepared.push({
        orderNo,
        fileName,
        filePath,
        sha256: createHash("sha256").update(candidate.data).digest("hex"),
        sizeBytes: candidate.data.length,
      });
    }

    return prepared;
  }
}

export class ExcelPrinterAdapter implements PrinterPort {
  constructor(private readonly scriptPath: string) {}

  async print(
    files: PreparedFile[],
    settings: WorkflowSettings,
  ): Promise<PrintResult> {
    if (process.platform !== "win32") {
      throw new Error("Excel 인쇄 어댑터는 Windows에서만 실행할 수 있습니다.");
    }
    if (files.some((file) => file.filePath.startsWith("demo://"))) {
      throw new Error("데모 파일은 실제 프린터로 보낼 수 없습니다.");
    }

    const manifest = Buffer.from(
      JSON.stringify({
        files: files.map((file) => file.filePath),
        printerName: settings.printerName,
        copies: settings.copies,
      }),
      "utf8",
    ).toString("base64");

    const output = await runPowerShell(this.scriptPath, manifest);
    const parsed = JSON.parse(output) as PrintResult;
    if (!parsed.success) throw new Error(parsed.message || "Excel 인쇄에 실패했습니다.");
    return parsed;
  }
}

function runPowerShell(scriptPath: string, manifestBase64: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        scriptPath,
        "-ManifestBase64",
        manifestBase64,
      ],
      { shell: false, windowsHide: true },
    );

    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("Excel 인쇄가 120초 안에 끝나지 않았습니다."));
    }, 120_000);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error(stderr.trim() || `PowerShell 인쇄 프로세스 종료 코드: ${code}`));
        return;
      }
      const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
      resolve(lines.at(-1) ?? "{}");
    });
  });
}

function sanitizeFileName(value: string): string {
  return value.replace(/[<>:"/\\|?*\x00-\x1F]/g, "_").slice(0, 180);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
