import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isAllowedUiRequest } from "./ui-request.js";
import { renderFulfillmentPage } from "./fulfillment-page.js";
import type { WorkflowToolHandlers } from "./server-tool-handlers.js";

interface WorkflowHttpServerOptions {
  host: string;
  port: number;
  mcpPath: string;
  fulfillmentHtml: string;
  practiceHtml?: string;
  projectRoot?: string;
  getWorkflowStatus: () => Promise<unknown>;
  getFulfillmentStatus: () => Promise<unknown>;
  getLogenTestPrintPopupUrl?: () => Promise<string>;
  toolHandlers: WorkflowToolHandlers;
  fulfillmentToolHandlers: WorkflowToolHandlers;
  createMcpServer: () => McpServer;
}

export function createWorkflowHttpServer({
  host,
  port,
  mcpPath,
  fulfillmentHtml,
  practiceHtml,
  projectRoot,
  getWorkflowStatus,
  getFulfillmentStatus,
  getLogenTestPrintPopupUrl,
  toolHandlers,
  fulfillmentToolHandlers,
  createMcpServer,
}: WorkflowHttpServerOptions) {
  const toolRoutes = [
    {
      prefix: "/api/fulfillment/tools/",
      handlers: new Map(Object.entries(fulfillmentToolHandlers)),
      unknownToolMessage: "Unknown fulfillment tool",
    },
    {
      prefix: "/api/tools/",
      handlers: new Map(Object.entries(toolHandlers)),
      unknownToolMessage: "Unknown tool",
    },
  ];

  return createServer(async (req, res) => {
    try {
      if (!isAllowedHost(req, host, port)) {
        sendText(res, 403, "Forbidden host");
        return;
      }
      if (!req.url) {
        sendText(res, 400, "Missing URL");
        return;
      }

      const url = new URL(req.url, `http://${req.headers.host}`);

      if (req.method === "GET" && url.pathname === "/practice" && practiceHtml) {
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
          "content-security-policy":
            "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'none'; img-src data:; form-action 'none'; base-uri 'none'; frame-ancestors 'none'",
        });
        res.end(practiceHtml);
        return;
      }

      if (req.method === "GET" && ["/fulfillment", "/fulfillment/beginner", "/fulfillment/expert"].includes(url.pathname)) {
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
          "content-security-policy":
            "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
        });
        res.end(renderFulfillmentPage(fulfillmentHtml, url.pathname === "/fulfillment/expert" ? "expert" : "beginner"));
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/fulfillment/status") {
        sendJson(res, 200, await getFulfillmentStatus());
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/fulfillment/logen-test-print-popup") {
        if (!getLogenTestPrintPopupUrl) {
          sendText(res, 404, "Logen test print popup is unavailable");
          return;
        }
        const popupUrl = await getLogenTestPrintPopupUrl();
        res.writeHead(302, {
          location: popupUrl,
          "cache-control": "no-store",
          "referrer-policy": "no-referrer",
          "x-content-type-options": "nosniff",
        });
        res.end();
        return;
      }

      const toolRoute = req.method === "POST"
        ? toolRoutes.find((route) => url.pathname.startsWith(route.prefix))
        : undefined;
      if (toolRoute) {
        if (!isAllowedUiRequest(req.headers, host, port)) {
          sendText(res, 403, "Forbidden origin");
          return;
        }
        const toolName = decodeURIComponent(url.pathname.slice(toolRoute.prefix.length));
        const handler = toolRoute.handlers.get(toolName);
        if (!handler) {
          sendText(res, 404, toolRoute.unknownToolMessage);
          return;
        }
        const body = await readJsonBody(req);
        sendJson(res, 200, await handler(body));
        return;
      }

      if (req.method === "GET" && url.pathname === "/health") {
        sendJson(res, 200, { ok: true, mcp: `http://${host}:${port}${mcpPath}`, ...(projectRoot ? { projectRoot } : {}) });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/status") {
        sendJson(res, 200, await getWorkflowStatus());
        return;
      }

      if (req.method === "OPTIONS" && url.pathname === mcpPath) {
        res.writeHead(204, {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST, GET, DELETE, OPTIONS",
          "Access-Control-Allow-Headers": "content-type, mcp-session-id, last-event-id",
          "Access-Control-Expose-Headers": "Mcp-Session-Id",
        });
        res.end();
        return;
      }

      if (
        url.pathname === mcpPath &&
        req.method &&
        new Set(["POST", "GET", "DELETE"]).has(req.method)
      ) {
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
        const server = createMcpServer();
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
          enableJsonResponse: true,
        });
        res.on("close", () => {
          void transport.close();
          void server.close();
        });
        await server.connect(transport);
        await transport.handleRequest(req, res);
        return;
      }

      sendText(res, 404, "Not Found");
    } catch (error) {
      console.error(error);
      if (!res.headersSent) sendJson(res, 500, { error: errorMessage(error) });
      else res.end();
    }
  });
}

function isAllowedHost(req: IncomingMessage, allowedHost: string, port: number): boolean {
  const host = req.headers.host ?? "";
  return host === `${allowedHost}:${port}` || host === `localhost:${port}`;
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > 128 * 1024) throw new Error("Request body is too large");
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("JSON object body is required");
  }
  return parsed as Record<string, unknown>;
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(JSON.stringify(value));
}

function sendText(res: ServerResponse, status: number, value: string): void {
  res.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "x-content-type-options": "nosniff",
  });
  res.end(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
