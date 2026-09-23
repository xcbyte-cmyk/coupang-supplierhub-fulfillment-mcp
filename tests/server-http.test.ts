import { request, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FulfillmentWorkflowMcpPort } from "../src/fulfillment-mcp.js";
import { createWorkflowHttpServer } from "../src/server-http.js";
import { createWorkflowMcpServer } from "../src/server-mcp.js";
import {
  createFulfillmentToolHandlers,
  createWorkflowToolHandlers,
} from "../src/server-tool-handlers.js";
import type { SupplierHubWorkflow } from "../src/workflow-module.js";

const HOST = "127.0.0.1:4310";
const UI_HEADERS = {
  "x-workflow-ui": "supplierhub-dashboard",
  origin: `http://${HOST}`,
};
const DASHBOARD = { message: "상태 조회 완료", dashboard: { initialized: true } };
const FULFILLMENT_STATUS = { workflowMode: "demo", operationMode: "calibration" };

let server: Server;
let actualPort: number;
let workflow: SupplierHubWorkflow;
let fulfillmentWorkflow: FulfillmentWorkflowMcpPort;
let openConfirmationFile: ReturnType<typeof vi.fn>;
let getLogenTestPrintPopupUrl: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  workflow = {
    getStatus: vi.fn().mockResolvedValue(DASHBOARD),
  } as unknown as SupplierHubWorkflow;
  fulfillmentWorkflow = {
    getFulfillmentRun: vi.fn().mockResolvedValue({ runId: "run-1" }),
    previewLogenRegistration: vi.fn().mockResolvedValue({ status: "completed", readOnly: true, ready: false }),
    saveProductCartonUnits: vi.fn().mockResolvedValue({ status: "completed", savedSkuCodes: ["70924435"] }),
    openLogenSingleOrderRegistration: vi.fn().mockResolvedValue({ ready: true }),
    registerLogenDeliveryOrder: vi.fn().mockResolvedValue({ registered: true }),
    printLogenWaybill: vi.fn().mockResolvedValue({ printed: true }),
    resetFulfillmentStageRecord: vi.fn().mockResolvedValue({ reset: true }),
  } as unknown as FulfillmentWorkflowMcpPort;
  openConfirmationFile = vi.fn().mockResolvedValue({ status: "requested", message: "파일 열기를 요청했습니다." });
  getLogenTestPrintPopupUrl = vi.fn().mockResolvedValue("https://topenapi.ilogen.com/lrm01f-reserve/print/lrm01fp600.html?test-only=1");

  server = createWorkflowHttpServer({
    host: "127.0.0.1",
    port: 4310,
    mcpPath: "/mcp",
    fulfillmentHtml: '<!doctype html><title>발주 관리</title><style>[data-experience="expert"] { color: black; }</style><body data-experience="expert">공통 작업 화면</body>',
    practiceHtml: "<!doctype html><title>발주·배송 실습실</title>",
    getWorkflowStatus: () => workflow.getStatus(),
    getFulfillmentStatus: async () => FULFILLMENT_STATUS,
    getLogenTestPrintPopupUrl,
    toolHandlers: createWorkflowToolHandlers(workflow),
    fulfillmentToolHandlers: {
      ...createFulfillmentToolHandlers(fulfillmentWorkflow, "api"),
      open_order_confirmation_file: openConfirmationFile,
    },
    createMcpServer: () => createWorkflowMcpServer({
      workflow,
      fulfillmentWorkflow,
      dashboardHtml: "<html>기존 대시보드</html>",
    }),
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  actualPort = (server.address() as AddressInfo).port;
});

afterEach(async () => {
  if (server?.listening) {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeAllConnections();
    });
  }
  vi.restoreAllMocks();
});

describe("workflow HTTP and MCP integration", () => {
  it("serves distinct beginner and expert pages using the same workflow contracts", async () => {
    const beginner = await send("/fulfillment/beginner?runId=run-1");
    const expert = await send("/fulfillment/expert?runId=run-1");
    const defaultPage = await send("/fulfillment");
    expect(beginner.status).toBe(200);
    expect(expert.status).toBe(200);
    expect(beginner.body).toContain('<body data-experience="beginner">');
    expect(expert.body).toContain('<body data-experience="expert">');
    expect(defaultPage.body).toContain('<body data-experience="beginner">');
    expect(fulfillmentWorkflow.registerLogenDeliveryOrder).not.toHaveBeenCalled();
    expect(fulfillmentWorkflow.getFulfillmentRun).not.toHaveBeenCalled();
  });
  it("dispatches workbook opening as a guarded UI action without running an upload", async () => {
    const input = { runId: "run-1", orderNo: "PO-1", expectedFilePath: "C:/work/확정.xlsx" };
    const opened = await postTool("/api/fulfillment/tools/open_order_confirmation_file", input);
    expect(JSON.parse(opened.body).status).toBe("requested");
    expect(openConfirmationFile).toHaveBeenCalledExactlyOnceWith(input);
    const foreign = await send("/api/fulfillment/tools/open_order_confirmation_file", {
      method: "POST", headers: { ...UI_HEADERS, origin: "http://example.com" }, body: JSON.stringify(input),
    });
    expect(foreign.status).toBe(403);
    expect(openConfirmationFile).toHaveBeenCalledTimes(1);
    expect(fulfillmentWorkflow.registerLogenDeliveryOrder).not.toHaveBeenCalled();
  });
  it("routes the read-only preview and confirmed carton updates separately from registration", async () => {
    const preview = await postTool("/api/fulfillment/tools/preview_logen_registration", { runId: "run-1", dataSource: "auto", draftUnits: [{ skuCode: "70924435", unitsPerCarton: 50 }] });
    expect(JSON.parse(preview.body)).toMatchObject({ readOnly: true, ready: false });
    const updates = [{ skuCode: "70924435", unitsPerCarton: 50, expectedUnitsPerCarton: null, expectedUpdatedAt: null }];
    const saved = await postTool("/api/fulfillment/tools/save_product_carton_units", { runId: "run-1", confirmed: true, updates });
    expect(saved.status).toBe(200);
    expect(fulfillmentWorkflow.saveProductCartonUnits).toHaveBeenCalledExactlyOnceWith({ runId: "run-1", confirmed: true, updates });
    expect(fulfillmentWorkflow.registerLogenDeliveryOrder).not.toHaveBeenCalled();
    const invalid = await postTool("/api/fulfillment/tools/save_product_carton_units", { runId: "run-1", confirmed: true, updates: [{ ...updates[0], unitsPerCarton: 0 }] });
    expect(invalid.status).toBe(500);
    expect(fulfillmentWorkflow.saveProductCartonUnits).toHaveBeenCalledTimes(1);
  });
  it("serves the practice page with network calls disabled and no workflow access", async () => {
    const page = await send("/practice");
    expect(page.status).toBe(200);
    expect(page.body).toContain("발주·배송 실습실");
    expect(page.headers["content-security-policy"]).toContain("connect-src 'none'");
    expect(page.headers["content-security-policy"]).toContain("form-action 'none'");
    expect(workflow.getStatus).not.toHaveBeenCalled();
    expect(fulfillmentWorkflow.getFulfillmentRun).not.toHaveBeenCalled();
  });

  it("serves the existing dashboard, health and both status contracts", async () => {
    const [page, health, legacyStatus, fulfillmentStatus] = await Promise.all([
      send("/fulfillment"),
      send("/health"),
      send("/api/status"),
      send("/api/fulfillment/status"),
    ]);
    expect(page.status).toBe(200);
    expect(page.body).toContain("발주 관리");
    expect(page.headers["cache-control"]).toBe("no-store");
    expect(page.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(JSON.parse(health.body)).toEqual({ ok: true, mcp: `http://${HOST}/mcp` });
    expect(JSON.parse(legacyStatus.body)).toEqual(DASHBOARD);
    expect(JSON.parse(fulfillmentStatus.body)).toEqual(FULFILLMENT_STATUS);
  });

  it("redirects the test print popup without serializing its destination", async () => {
    const response = await send("/api/fulfillment/logen-test-print-popup");
    expect(response.status).toBe(302);
    expect(response.headers.location).toContain("topenapi.ilogen.com");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body).toBe("");
    expect(getLogenTestPrintPopupUrl).toHaveBeenCalledExactlyOnceWith();
  });

  it("dispatches both API namespaces and trims the selected run ID", async () => {
    const legacy = await postTool("/api/tools/get_workflow_dashboard", {});
    const current = await postTool("/api/fulfillment/tools/get_fulfillment_run", {
      runId: " run-1 ",
    });
    expect(legacy.status).toBe(200);
    expect(JSON.parse(legacy.body)).toEqual(DASHBOARD);
    expect(current.status).toBe(200);
    expect(JSON.parse(current.body)).toEqual({ runId: "run-1" });
    expect(fulfillmentWorkflow.getFulfillmentRun).toHaveBeenCalledExactlyOnceWith({ runId: "run-1" });
  });

  it("rejects foreign hosts, foreign origins and missing UI markers before dispatch", async () => {
    const endpoint = "/api/fulfillment/tools/get_fulfillment_run";
    for (const headers of [
      { ...UI_HEADERS, host: "example.com:4310" },
      { ...UI_HEADERS, origin: "http://example.com:4310" },
      { origin: `http://${HOST}` },
    ]) {
      const response = await send(endpoint, {
        method: "POST", headers, body: JSON.stringify({ runId: "run-1" }),
      });
      expect(response.status).toBe(403);
    }
    expect(fulfillmentWorkflow.getFulfillmentRun).not.toHaveBeenCalled();
  });

  it("rejects unregistered tools and invalid bodies without running a workflow", async () => {
    for (const [prefix, message] of [
      ["/api/tools/", "Unknown tool"],
      ["/api/fulfillment/tools/", "Unknown fulfillment tool"],
    ]) {
      for (const name of ["missing", "toString", "constructor"]) {
        const response = await postTool(prefix + name, {});
        expect(response.status).toBe(404);
        expect(response.body).toBe(message);
      }
    }
    for (const body of ["{broken", "[]", "null", "{}", JSON.stringify({ runId: "x".repeat(128 * 1024) })]) {
      const response = await send("/api/fulfillment/tools/get_fulfillment_run", {
        method: "POST", headers: UI_HEADERS, body,
      });
      expect(response.status).toBe(500);
      expect(JSON.parse(response.body).error).toEqual(expect.any(String));
    }
    expect(fulfillmentWorkflow.getFulfillmentRun).not.toHaveBeenCalled();
  });

  it("keeps both Logen registration names compatible without forcing a saved method", async () => {
    for (const name of ["open_logen_registration", "open_logen_single_order_registration"]) {
      const response = await postTool(`/api/fulfillment/tools/${name}`, { runId: "run-1" });
      expect(response.status).toBe(200);
    }
    expect(fulfillmentWorkflow.openLogenSingleOrderRegistration).toHaveBeenCalledTimes(2);
    expect(fulfillmentWorkflow.openLogenSingleOrderRegistration).toHaveBeenNthCalledWith(1, {
      runId: "run-1", logenMethod: undefined,
    });
    expect(fulfillmentWorkflow.openLogenSingleOrderRegistration).toHaveBeenNthCalledWith(2, {
      runId: "run-1", logenMethod: undefined,
    });
  });

  it("preserves default methods and requires literal true for retry-related flags", async () => {
    const registration = await postTool("/api/fulfillment/tools/register_logen_delivery_order", {
      runId: "run-1", dataSource: "auto", refreshMaster: "true",
    });
    const printing = await postTool("/api/fulfillment/tools/print_logen_waybill", {
      runId: "run-1", forceReprint: "true",
    });
    expect(registration.status).toBe(200);
    expect(printing.status).toBe(200);
    expect(fulfillmentWorkflow.registerLogenDeliveryOrder).toHaveBeenCalledExactlyOnceWith({
      runId: "run-1", dataSource: "auto", logenMethod: "api", refreshMaster: false,
    });
    expect(fulfillmentWorkflow.printLogenWaybill).toHaveBeenCalledExactlyOnceWith({
      runId: "run-1", logenMethod: undefined, forceReprint: false,
    });
    const invalid = await postTool("/api/fulfillment/tools/print_logen_waybill", {
      runId: "run-1", logenMethod: "unsupported", forceReprint: true,
    });
    expect(invalid.status).toBe(500);
    expect(fulfillmentWorkflow.printLogenWaybill).toHaveBeenCalledTimes(1);
  });

  it("retains stage-reset confirmation and strict boolean options", async () => {
    const response = await postTool("/api/fulfillment/tools/reset_fulfillment_stage_record", {
      runId: " run-1 ", stage: "15", confirmation: " RESET run-1 ",
      allowUnknown: "true", quickReset: true, clearLogenRegistration: "true",
    });
    expect(response.status).toBe(200);
    expect(fulfillmentWorkflow.resetFulfillmentStageRecord).toHaveBeenCalledExactlyOnceWith({
      runId: "run-1", stage: 15, confirmation: "RESET run-1",
      allowUnknown: false, quickReset: true, clearLogenRegistration: false,
    });
  });

  it("serves MCP initialization, tools, app resources and structured tool replies", async () => {
    const preflight = await send("/mcp", { method: "OPTIONS" });
    expect(preflight.status).toBe(204);
    expect(preflight.headers["access-control-allow-origin"]).toBe("*");

    const initialize = await rpc("initialize", {
      protocolVersion: LATEST_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "refactor-test", version: "1.0.0" },
    });
    expect(initialize.result.serverInfo.name).toBe("coupang-supplierhub-workflow");
    const list = await rpc("tools/list", {});
    expect(list.result.tools.map((tool: { name: string }) => tool.name)).toEqual(
      expect.arrayContaining([
        "get_workflow_dashboard", "open_supplierhub", "register_logen_delivery_order",
        "register_supplierhub_shipment_tracking", "print_supplierhub_shipment_documents",
      ]),
    );
    const resource = await rpc("resources/read", { uri: "ui://supplierhub-workflow/dashboard-v1.html" });
    expect(resource.result.contents[0].text).toBe("<html>기존 대시보드</html>");
    const reply = await rpc("tools/call", { name: "get_workflow_dashboard", arguments: {} });
    expect(reply.result.structuredContent).toEqual({ dashboard: DASHBOARD.dashboard });
    expect(reply.result.content[0].text).toBe(DASHBOARD.message);
  });
});

function postTool(path: string, body: unknown) {
  return send(path, { method: "POST", headers: UI_HEADERS, body: JSON.stringify(body) });
}

async function rpc(method: string, params: unknown) {
  const response = await send("/mcp", {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": LATEST_PROTOCOL_VERSION,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  expect(response.status).toBe(200);
  return JSON.parse(response.body);
}

function send(path: string, options: {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
} = {}): Promise<{ status: number; headers: IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({
      hostname: "127.0.0.1",
      port: actualPort,
      path,
      method: options.method ?? "GET",
      headers: { host: HOST, "content-type": "application/json", ...options.headers },
    }, (response) => {
      response.setEncoding("utf8");
      let body = "";
      response.on("data", (chunk) => { body += chunk; });
      response.on("error", reject);
      response.on("end", () => resolve({
        status: response.statusCode!, headers: response.headers, body,
      }));
    });
    req.on("error", reject);
    req.end(options.body);
  });
}
