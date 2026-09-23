import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

import {
  LogenBrowserAdapter,
  waitForLogenPrintDialog,
  waitForLogenLoginTransition,
} from "../src/fulfillment-adapters.js";
import type { LogenWindowsPrintDialogPort } from "../src/logen-windows-print-client.js";

const windowsPrintDialog: LogenWindowsPrintDialogPort = {
  async health() {
    return { ready: true, message: "ready" };
  },
  async prepareDefaultPrinter(expectedCount) {
    return {
      success: true,
      status: "ready",
      message: "prepared",
      expectedCount,
      printerName: "AllLive OLIVE-308B",
      previousPrinterName: "SINDOH N600 Series PCL-8",
      defaultPrinterName: "AllLive OLIVE-308B",
    };
  },
  async restoreDefaultPrinter(printerName, expectedCount) {
    return {
      success: true,
      status: "ready",
      message: "restored",
      expectedCount,
      printerName: "AllLive OLIVE-308B",
      defaultPrinterName: printerName,
    };
  },
  async configure(expectedCount) {
    return {
      success: true,
      status: "ready",
      message: "configured",
      expectedCount,
      printerName: "AllLive OLIVE-308B",
    };
  },
  async probe(expectedCount) {
    return {
      success: true,
      status: "ready",
      message: "ready",
      expectedCount,
      printerName: "AllLive OLIVE-308B",
    };
  },
  async confirm(expectedCount) {
    return {
      success: true,
      status: "submitted",
      message: "submitted",
      expectedCount,
      printerName: "AllLive OLIVE-308B",
    };
  },
};

describe("Logen single-order website flow", () => {
  it("waits for a delayed Windows print dialog instead of failing on the first zero-candidate scan", async () => {
    let checks = 0;
    let now = 0;
    const result = await waitForLogenPrintDialog({
      check: async () => {
        checks += 1;
        return checks < 3
          ? {
              success: false,
              status: "blocked",
              message: "Expected exactly one Logen print dialog; found 0.",
              expectedCount: 2,
              printerName: "AllLive OLIVE-308B",
            }
          : {
              success: true,
              status: "ready",
              message: "configured",
              expectedCount: 2,
              printerName: "AllLive OLIVE-308B",
            };
      },
      wait: async (milliseconds) => {
        now += milliseconds;
      },
      now: () => now,
      timeoutMs: 15_000,
      intervalMs: 500,
    });

    expect(result).toMatchObject({ success: true, status: "ready" });
    expect(checks).toBe(3);
    expect(now).toBe(1_000);
  });

  it("does not retry when multiple Windows print dialogs are visible", async () => {
    let checks = 0;
    const result = await waitForLogenPrintDialog({
      check: async () => {
        checks += 1;
        return {
          success: false,
          status: "blocked",
          message: "Expected exactly one Logen print dialog; found 2.",
          expectedCount: 2,
          printerName: "AllLive OLIVE-308B",
        };
      },
      wait: async () => {
        throw new Error("ambiguous dialogs must not be retried");
      },
    });

    expect(result).toMatchObject({ success: false, status: "blocked" });
    expect(checks).toBe(1);
  });

  it("reads IBSheet rows in the browser context without a transpiler __name dependency", async () => {
    const script = String.raw`
      import { chromium } from "playwright-core";
      import { LogenBrowserAdapter } from "./src/fulfillment-adapters.ts";
      const browser = await chromium.launch({
        executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
        headless: true,
      });
      try {
        const page = await browser.newPage();
        await page.goto("data:text/html,<html><body></body></html>");
        await page.evaluate('globalThis.lrm01f0050Sheet1 = { getDataRows() { return [{ id: "1", takeNo: "TAKE-1", rcvCustNm: "동탄1", qty: 2, printCnt: 0 }]; }, getRowValue(row) { return row; } }');
        const adapter = new LogenBrowserAdapter({ profileDir: "data/test-logen-profile" });
        console.log(JSON.stringify(await adapter.readSingleOrderRows(page)));
      } finally {
        await browser.close();
      }
    `;
    const output = execFileSync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", script],
      { cwd: process.cwd(), encoding: "utf8" },
    );

    expect(JSON.parse(output)).toMatchObject([{ registrationKey: "takeNo:TAKE-1" }]);
  });

  it("keeps a reservation row key stable when IBSheet changes a Date into epoch milliseconds", async () => {
    const script = String.raw`
      import { chromium } from "playwright-core";
      import { LogenBrowserAdapter } from "./src/fulfillment-adapters.ts";
      const browser = await chromium.launch({
        executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
        headless: true,
      });
      try {
        const page = await browser.newPage();
        await page.goto("data:text/html,<html><body></body></html>");
        const adapter = new LogenBrowserAdapter({ profileDir: "data/test-logen-profile" });
        await page.evaluate('globalThis.lrm01f0050Sheet1 = { getDataRows() { return [{ id: "1", takeDt: new Date(1785682800000), seq: 15, fixcustCd: "99999999", rcvCustNm: "동탄1", qty: 1, printCnt: 0 }]; }, getRowValue(row) { return row; } }');
        const before = await adapter.readSingleOrderRows(page);
        await page.evaluate('globalThis.lrm01f0050Sheet1 = { getDataRows() { return [{ id: "1", takeDt: 1785682800000, seq: 15, fixcustCd: "99999999", rcvCustNm: "동탄1", qty: 1, printCnt: 0 }]; }, getRowValue(row) { return row; } }');
        const after = await adapter.readSingleOrderRows(page);
        console.log(JSON.stringify({ before, after }));
      } finally {
        await browser.close();
      }
    `;
    const output = execFileSync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", script],
      { cwd: process.cwd(), encoding: "utf8" },
    );
    const parsed = JSON.parse(output) as {
      before: Array<{ registrationKey: string }>;
      after: Array<{ registrationKey: string }>;
    };

    expect(parsed.before[0]?.registrationKey).toBe(parsed.after[0]?.registrationKey);
  });

  it("recovers and selects only the exact unprinted carton rows for a saved batch", async () => {
    const script = String.raw`
      import { chromium } from "playwright-core";
      import { LogenBrowserAdapter } from "./src/fulfillment-adapters.ts";
      const browser = await chromium.launch({
        executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
        headless: true,
      });
      try {
        const page = await browser.newPage();
        await page.goto("data:text/html,<html><body></body></html>");
        await page.evaluate('globalThis.rows = [{ id: "old", takeDt: 1785682800000, seq: 10, fixcustCd: "99999999", rcvCustNm: "동탄1", ordQty: 1, prtCnt: 1 }, { id: "15", takeDt: 1785682800000, seq: 15, fixcustCd: "99999999", rcvCustNm: "동탄1", ordQty: 1, prtCnt: 0 }, { id: "16", takeDt: 1785682800000, seq: 16, fixcustCd: "99999999", rcvCustNm: "동탄1", ordQty: 1, prtCnt: 0 }, { id: "other", takeDt: 1785682800000, seq: 17, fixcustCd: "99999999", rcvCustNm: "고양1", ordQty: 1, prtCnt: 0 }]; globalThis.lrm01f0050Sheet1 = { getDataRows() { return globalThis.rows; }, getRowValue(row) { return row; }, setValue({ row, col, val }) { row[col] = val; } }');
        const adapter = new LogenBrowserAdapter({ profileDir: "data/test-logen-profile" });
        const batch = { id: "batch", runId: "run", orderNo: "137209097", skuCode: "44133530", skuName: "상품", orderedQuantity: 100, unitsPerCarton: 50, cartonCount: 2, fixTakeNo: "137209097-44133530", status: "unknown", createdAt: "2026-08-03T00:00:00.000Z", updatedAt: "2026-08-03T00:00:00.000Z" };
        const recovered = await adapter.recoverUnprintedRegistrationRows(page, batch, "동탄1");
        const selected = await adapter.selectRegistrationRows(page, recovered.map((row) => row.registrationKey));
        const checks = await page.evaluate('globalThis.rows.map((row) => [row.id, row.CheckData])');
        console.log(JSON.stringify({ recovered, selected, checks }));
      } finally {
        await browser.close();
      }
    `;
    const output = execFileSync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", script],
      { cwd: process.cwd(), encoding: "utf8" },
    );
    const parsed = JSON.parse(output) as {
      recovered: Array<{ rowId: string; registrationKey: string }>;
      selected: Array<{ rowId: string }>;
      checks: Array<[string, number]>;
    };

    expect(parsed.recovered.map((row) => row.rowId)).toEqual(["15", "16"]);
    expect(parsed.selected.map((row) => row.rowId)).toEqual(["15", "16"]);
    expect(parsed.checks).toEqual([
      ["old", 0],
      ["15", 1],
      ["16", 1],
      ["other", 0],
    ]);
  });

  it("waits until every sequentially rendered carton reservation row is visible", async () => {
    const script = String.raw`
      import { chromium } from "playwright-core";
      import { LogenBrowserAdapter } from "./src/fulfillment-adapters.ts";
      const browser = await chromium.launch({
        executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
        headless: true,
      });
      try {
        const page = await browser.newPage();
        await page.goto("data:text/html,<html><body></body></html>");
        await page.evaluate('globalThis.rows = []; globalThis.lrm01f0050Sheet1 = { getDataRows() { return globalThis.rows; }, getRowValue(row) { return row; } }; setTimeout(() => globalThis.rows.push({ id: "15", takeDt: 1785682800000, seq: 15, fixcustCd: "99999999", rcvCustNm: "동탄1", ordQty: 1, prtCnt: 0 }), 50); setTimeout(() => globalThis.rows.push({ id: "16", takeDt: 1785682800000, seq: 16, fixcustCd: "99999999", rcvCustNm: "동탄1", ordQty: 1, prtCnt: 0 }), 150)');
        const adapter = new LogenBrowserAdapter({ profileDir: "data/test-logen-profile" });
        const rows = await adapter.waitForNewRegistrationRows(page, [], "동탄1", 2);
        console.log(JSON.stringify(rows));
      } finally {
        await browser.close();
      }
    `;
    const output = execFileSync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", script],
      { cwd: process.cwd(), encoding: "utf8" },
    );
    const rows = JSON.parse(output) as Array<{ rowId: string }>;

    expect(rows.map((row) => row.rowId)).toEqual(["15", "16"]);
  });

  it("ignores previously printed rows when identifying newly saved cartons", async () => {
    const script = String.raw`
      import { chromium } from "playwright-core";
      import { LogenBrowserAdapter } from "./src/fulfillment-adapters.ts";
      const browser = await chromium.launch({
        executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
        headless: true,
      });
      try {
        const page = await browser.newPage();
        await page.goto("data:text/html,<html><body></body></html>");
        await page.evaluate('globalThis.rows = [{ id: "old-1", takeDt: 1785682800000, seq: 3, fixcustCd: "99999999", rcvCustNm: "동탄1", ordQty: 1, prtCnt: 1 }, { id: "old-2", takeDt: 1785682800000, seq: 4, fixcustCd: "99999999", rcvCustNm: "동탄1", ordQty: 1, prtCnt: 1 }, { id: "new-1", takeDt: 1785682800000, seq: 7, fixcustCd: "99999999", rcvCustNm: "동탄1", ordQty: 1, prtCnt: 0 }, { id: "new-2", takeDt: 1785682800000, seq: 8, fixcustCd: "99999999", rcvCustNm: "동탄1", ordQty: 1, prtCnt: 0 }]; globalThis.lrm01f0050Sheet1 = { getDataRows() { return globalThis.rows; }, getRowValue(row) { return row; } }');
        const adapter = new LogenBrowserAdapter({ profileDir: "data/test-logen-profile" });
        console.log(JSON.stringify(await adapter.waitForNewRegistrationRows(page, [], "동탄1", 2)));
      } finally {
        await browser.close();
      }
    `;
    const output = execFileSync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", script],
      { cwd: process.cwd(), encoding: "utf8" },
    );
    const rows = JSON.parse(output) as Array<{ rowId: string }>;

    expect(rows.map((row) => row.rowId)).toEqual(["new-1", "new-2"]);
  });

  it("runs 조회 before capturing the registration baseline", async () => {
    const script = String.raw`
      import { chromium } from "playwright-core";
      import { LogenBrowserAdapter } from "./src/fulfillment-adapters.ts";
      const browser = await chromium.launch({
        executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
        headless: true,
      });
      try {
        const page = await browser.newPage();
        await page.setContent('<button class="btn base search">조회</button>');
        await page.evaluate('globalThis.queried = false; document.querySelector("button.search").addEventListener("click", function () { globalThis.queried = true; }); globalThis.lrm01f0050Sheet1 = { getDataRows() { return globalThis.queried ? [{ id: "existing", takeDt: 1785682800000, seq: 3, fixcustCd: "99999999", rcvCustNm: "동탄1", ordQty: 1, prtCnt: 1 }] : []; }, getRowValue(row) { return row; } }');
        const adapter = new LogenBrowserAdapter({ profileDir: "data/test-logen-profile" });
        console.log(JSON.stringify(await adapter.refreshSingleOrderRows(page)));
      } finally {
        await browser.close();
      }
    `;
    const output = execFileSync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", script],
      { cwd: process.cwd(), encoding: "utf8" },
    );
    const rows = JSON.parse(output) as Array<{ rowId: string }>;

    expect(rows.map((row) => row.rowId)).toEqual(["existing"]);
  });

  it("inspects both printed and unprinted filters before deciding the batch state", async () => {
    const script = String.raw`
      import { chromium } from "playwright-core";
      import { LogenBrowserAdapter } from "./src/fulfillment-adapters.ts";
      const browser = await chromium.launch({
        executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
        headless: true,
      });
      try {
        const page = await browser.newPage();
        page.setDefaultTimeout(750);
        await page.setContent('<style>.filter{position:relative;display:inline-block;width:70px;height:30px}.filter input{position:absolute;left:0;top:0;width:20px;height:20px}.filter label{position:absolute;inset:0;z-index:2}</style><button class="btn base search"><span>&#xf002;</span> 조회(F2)</button><button class="btn base new">신규</button><span class="filter"><input id="rdo_noprint" type="radio" name="print" checked><label for="rdo_noprint">미출력</label></span><span class="filter"><input id="rdo_print" type="radio" name="print"><label for="rdo_print">출력</label></span>');
        await page.evaluate('globalThis.queried = false; document.querySelector("button.search").addEventListener("click", function () { globalThis.queried = true; }); globalThis.lrm01f0050Sheet1 = { getDataRows() { if (!globalThis.queried) return []; return document.querySelector("#rdo_noprint").checked ? [{ id: "15", takeDt: 1785682800000, seq: 15, fixcustCd: "99999999", rcvCustNm: "동탄1", ordQty: 1, prtCnt: 0 }] : [{ id: "16", takeDt: 1785682800000, seq: 16, fixcustCd: "99999999", rcvCustNm: "동탄1", ordQty: 1, prtCnt: 1 }]; }, getRowValue(row) { return row; } }');
        const adapter = new LogenBrowserAdapter({ profileDir: "data/test-logen-profile" });
        adapter.rememberRegistrationSurface(page);
        const batch = { id: "batch", runId: "run", orderNo: "137209097", skuCode: "44133530", skuName: "상품", orderedQuantity: 100, unitsPerCarton: 50, cartonCount: 2, fixTakeNo: "137209097-44133530", status: "registered", registrationKeys: ["reservation:1785682800000|15|99999999", "reservation:1785682800000|16|99999999"], createdAt: "2026-08-03T00:00:00.000Z", updatedAt: "2026-08-03T00:00:00.000Z" };
        console.log(JSON.stringify(await adapter.inspectBatchWaybills([batch])));
      } finally {
        await browser.close();
      }
    `;
    const output = execFileSync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", script],
      { cwd: process.cwd(), encoding: "utf8" },
    );

    expect(JSON.parse(output)).toMatchObject([
      {
        batchId: "batch",
        success: true,
        printState: "mixed",
        registrationKeys: [
          "reservation:1785682800000|15|99999999",
          "reservation:1785682800000|16|99999999",
        ],
      },
    ]);
  }, 10_000);

  it("confirms the Logen MSG000 web prompt before the Windows print dialog", () => {
    const script = String.raw`
      import { chromium } from "playwright-core";
      import { LogenBrowserAdapter } from "./src/fulfillment-adapters.ts";
      const browser = await chromium.launch({
        executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
        headless: true,
      });
      try {
        const page = await browser.newPage();
        await page.setContent('<div role="dialog" class="modalWrap alert"><strong>MSG000</strong><p>[ 출력정보 : 감열(5인치) ] 출력하시겠습니까?</p><button id="btn-popupModal1">예</button><button id="btn-popupModal1-no">아니오</button></div>');
        await page.evaluate('document.querySelector("#btn-popupModal1").addEventListener("click", function () { document.body.dataset.confirmed = "true"; document.querySelector(".modalWrap").style.display = "none"; })');
        const adapter = new LogenBrowserAdapter({ profileDir: "data/test-logen-profile" });
        await adapter.confirmLogenWebPrintPrompt(page);
        console.log(await page.locator("body").getAttribute("data-confirmed"));
      } finally {
        await browser.close();
      }
    `;

    const output = execFileSync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", script],
      { cwd: process.cwd(), encoding: "utf8" },
    );

    expect(output.trim()).toBe("true");
  });

  it("polls every 0.2 seconds until the delayed waybill loading prompt appears", () => {
    const script = String.raw`
      import { chromium } from "playwright-core";
      import { LogenBrowserAdapter } from "./src/fulfillment-adapters.ts";
      const browser = await chromium.launch({
        executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
        headless: true,
      });
      try {
        const page = await browser.newPage();
        await page.setContent('<div role="dialog" class="modalWrap alert" style="display:none"><strong>MSG000</strong><p>운송장을 불러오는 중입니다.</p><button id="btn-popupModal2">확인</button></div>');
        await page.evaluate('globalThis.startedAt = Date.now(); setTimeout(function () { document.querySelector(".modalWrap").style.display = "block"; }, 600); document.querySelector("#btn-popupModal2").addEventListener("click", function () { document.body.dataset.confirmed = "true"; document.body.dataset.elapsed = String(Date.now() - globalThis.startedAt); document.querySelector(".modalWrap").style.display = "none"; })');
        const adapter = new LogenBrowserAdapter({ profileDir: "data/test-logen-profile" });
        await adapter.dismissLogenWaybillLoadingPrompt(page);
        console.log(JSON.stringify({
          confirmed: await page.locator("body").getAttribute("data-confirmed"),
          elapsed: Number(await page.locator("body").getAttribute("data-elapsed")),
        }));
      } finally {
        await browser.close();
      }
    `;

    const output = execFileSync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", script],
      { cwd: process.cwd(), encoding: "utf8" },
    );
    const result = JSON.parse(output) as { confirmed: string; elapsed: number };

    expect(result.confirmed).toBe("true");
    expect(result.elapsed).toBeGreaterThanOrEqual(550);
  });

  it("waits through a slow login transition instead of stopping after one second", async () => {
    let checks = 0;
    const result = await waitForLogenLoginTransition({
      isLoginFormVisible: async () => {
        checks += 1;
        return checks < 4;
      },
      isReadyMarkerVisible: async () => false,
      wait: async () => undefined,
      timeoutMs: 10_000,
      intervalMs: 500,
    });

    expect(result).toBe("left_login");
    expect(checks).toBe(4);
  });

  it("does not require the obsolete separate waybill-search screen", () => {
    const adapter = new LogenBrowserAdapter({
      profileDir: "data/test-logen-profile",
      registrationUrl: "https://logis.ilogen.com/",
      waybillUrl: "https://logis.ilogen.com/common/html/main.html",
      chromeConnection: "cdp",
      windowsPrintDialog,
    });

    const readiness = adapter.getReadiness("print");

    expect(readiness.ready, readiness.message).toBe(true);
    expect(readiness.message).not.toContain("로젠 송장 검색 입력 셀렉터");
  });
});
