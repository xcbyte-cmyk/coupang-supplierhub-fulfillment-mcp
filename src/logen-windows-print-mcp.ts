import { execFile } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const execFileAsync = promisify(execFile);
const MODULE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HOST = "127.0.0.1";
const PORT = Number(process.env.LOGEN_WINDOWS_MCP_PORT ?? 4311);
const MCP_PATH = "/mcp";
const TOKEN = process.env.LOGEN_WINDOWS_MCP_TOKEN?.trim();
const PRINTER_NAME =
  process.env.LOGEN_WINDOWS_PRINTER?.trim() ??
  "\\\\DESKTOP-EFG7BOL\\AllLive OLIVE-308B";
const SCRIPT_PATH =
  process.env.LOGEN_WINDOWS_PRINT_SCRIPT?.trim() ??
  join(MODULE_ROOT, "scripts", "confirm-logen-oz-print.ps1");

const resultSchema = z.object({
  success: z.boolean(),
  status: z.enum(["ready", "submitted", "blocked", "unknown"]),
  message: z.string(),
  expectedCount: z.number().int(),
  printerName: z.string(),
  previousPrinterName: z.string().nullable().optional(),
  defaultPrinterName: z.string().nullable().optional(),
  processName: z.string().nullable().optional(),
  processId: z.number().int().nullable().optional(),
});

type PrintDialogResult = z.infer<typeof resultSchema>;

if (process.platform !== "win32") {
  throw new Error("Logen Windows Print MCP only supports Windows.");
}
if (!TOKEN) {
  throw new Error("LOGEN_WINDOWS_MCP_TOKEN is required.");
}
if (!Number.isInteger(PORT) || PORT < 1024 || PORT > 65535) {
  throw new Error("LOGEN_WINDOWS_MCP_PORT must be an integer between 1024 and 65535.");
}

function createMcpServer(): McpServer {
  const server = new McpServer(
    { name: "logen-windows-print-mcp", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.registerTool(
    "prepare_logen_default_printer",
    {
      title: "Prepare Logen default printer",
      description:
        "Save the current Windows default printer and temporarily set the fixed OLIVE printer before the print dialog opens.",
      inputSchema: {
        expectedCount: z.number().int().min(1).max(100),
      },
      outputSchema: resultSchema.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ expectedCount }) =>
      toolReply(await runPrintDialogScript("PrepareDefault", expectedCount)),
  );

  server.registerTool(
    "restore_logen_default_printer",
    {
      title: "Restore Windows default printer",
      description:
        "Restore the Windows default printer saved by the fulfillment workflow after the Logen print attempt.",
      inputSchema: {
        expectedCount: z.number().int().min(1).max(100),
        printerName: z.string().trim().min(1).max(512),
      },
      outputSchema: resultSchema.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ expectedCount, printerName }) =>
      toolReply(
        await runPrintDialogScript("RestoreDefault", expectedCount, printerName),
      ),
  );

  server.registerTool(
    "configure_logen_print_dialog",
    {
      title: "Configure Logen Windows print dialog",
      description:
        "Select the fixed OLIVE printer in exactly one already-open Logen Windows print dialog without submitting the print job.",
      inputSchema: {
        expectedCount: z.number().int().min(1).max(100),
      },
      outputSchema: resultSchema.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ expectedCount }) =>
      toolReply(await runPrintDialogScript("Configure", expectedCount)),
  );

  server.registerTool(
    "probe_logen_print_dialog",
    {
      title: "Probe Logen Windows print dialog",
      description:
        "Read-only check that exactly one standard Logen print dialog targets the fixed OLIVE printer.",
      inputSchema: {
        expectedCount: z.number().int().min(1).max(100),
      },
      outputSchema: resultSchema.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ expectedCount }) => toolReply(await runPrintDialogScript("Probe", expectedCount)),
  );

  server.registerTool(
    "confirm_logen_print_dialog",
    {
      title: "Confirm Logen Windows print dialog",
      description:
        "Confirm exactly one already-open Logen Windows print dialog after validating the fixed OLIVE printer and expected waybill count. Never retries automatically.",
      inputSchema: {
        expectedCount: z.number().int().min(1).max(100),
      },
      outputSchema: resultSchema.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ expectedCount }) =>
      toolReply(await runPrintDialogScript("Confirm", expectedCount)),
  );

  return server;
}

async function runPrintDialogScript(
  mode:
    | "PrepareDefault"
    | "RestoreDefault"
    | "Configure"
    | "Probe"
    | "Confirm",
  expectedCount: number,
  restorePrinterName?: string,
): Promise<PrintDialogResult> {
  const args = [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    SCRIPT_PATH,
    "-Mode",
    mode,
    "-PrinterName",
    PRINTER_NAME,
    "-ExpectedCount",
    String(expectedCount),
    "-TimeoutSeconds",
    "15",
  ];
  if (restorePrinterName) {
    args.push("-RestorePrinterName", restorePrinterName);
  }

  let stdout = "";
  try {
    const result = await execFileAsync("pwsh.exe", args, {
      timeout: 30_000,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });
    stdout = result.stdout;
  } catch (error) {
    stdout = commandOutput(error);
  }

  const line = stdout
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean)
    .at(-1);
  if (!line) {
    return {
      success: false,
      status: "blocked",
      message: "The elevated Windows print helper returned no structured result.",
      expectedCount,
      printerName: PRINTER_NAME,
    };
  }

  try {
    return resultSchema.parse(JSON.parse(line));
  } catch (error) {
    return {
      success: false,
      status: "blocked",
      message: `The elevated Windows print helper returned an invalid result: ${errorMessage(error)}`,
      expectedCount,
      printerName: PRINTER_NAME,
    };
  }
}

function toolReply(result: PrintDialogResult) {
  return {
    content: [{ type: "text" as const, text: result.message }],
    structuredContent: result,
    isError: !result.success,
  };
}

function isAuthorized(req: IncomingMessage): boolean {
  return req.headers.authorization === `Bearer ${TOKEN}`;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(body));
}

function commandOutput(error: unknown): string {
  if (!error || typeof error !== "object") return "";
  const stdout = "stdout" in error ? String(error.stdout ?? "") : "";
  const stderr = "stderr" in error ? String(error.stderr ?? "") : "";
  return stdout.trim() || stderr.trim();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const httpServer = createServer(async (req, res) => {
  try {
    if (!isAuthorized(req)) {
      sendJson(res, 401, { error: "Unauthorized" });
      return;
    }
    if (req.url === "/health" && req.method === "GET") {
      sendJson(res, 200, {
        status: "ready",
        service: "logen-windows-print-mcp",
        printerName: PRINTER_NAME,
      });
      return;
    }
    if (
      req.url === MCP_PATH &&
      req.method &&
      new Set(["POST", "GET", "DELETE"]).has(req.method)
    ) {
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
    sendJson(res, 404, { error: "Not Found" });
  } catch (error) {
    if (!res.headersSent) sendJson(res, 500, { error: errorMessage(error) });
    else res.end();
  }
});

httpServer.listen(PORT, HOST, () => {
  console.log(`Logen Windows Print MCP listening on http://${HOST}:${PORT}${MCP_PATH}`);
});
