import { readFile } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";

const printDialogResultSchema = z.object({
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

export type LogenWindowsPrintDialogResult = z.infer<typeof printDialogResultSchema>;

export interface LogenWindowsPrintDialogPort {
  health(): Promise<{ ready: boolean; message: string }>;
  prepareDefaultPrinter(expectedCount: number): Promise<LogenWindowsPrintDialogResult>;
  restoreDefaultPrinter(
    printerName: string,
    expectedCount: number,
  ): Promise<LogenWindowsPrintDialogResult>;
  configure(expectedCount: number): Promise<LogenWindowsPrintDialogResult>;
  probe(expectedCount: number): Promise<LogenWindowsPrintDialogResult>;
  confirm(expectedCount: number): Promise<LogenWindowsPrintDialogResult>;
}

export interface LogenWindowsPrintMcpClientConfig {
  endpoint: string;
  tokenFile?: string;
  token?: string;
  autoStart?: () => Promise<void>;
  autoStartTimeoutMs?: number;
}

export class LogenWindowsPrintMcpClient implements LogenWindowsPrintDialogPort {
  constructor(private readonly config: LogenWindowsPrintMcpClientConfig) {}

  async health(): Promise<{ ready: boolean; message: string }> {
    const first = await this.probeHealth();
    if (first.ready || !first.unreachable || !this.config.autoStart) {
      return { ready: first.ready, message: first.message };
    }
    try {
      await this.config.autoStart();
    } catch (error) {
      return {
        ready: false,
        message: `로젠 Windows MCP 자동 시작을 요청하지 못했습니다: ${errorMessage(error)}`,
      };
    }

    const deadline = Date.now() + (this.config.autoStartTimeoutMs ?? 30_000);
    let latest = first;
    while (Date.now() < deadline) {
      await delay(250);
      latest = await this.probeHealth();
      if (latest.ready) {
        return {
          ready: true,
          message: "로젠 Windows MCP를 자동으로 시작해 인쇄 준비를 완료했습니다.",
        };
      }
    }
    return {
      ready: false,
      message: `로젠 Windows MCP 자동 시작이 완료되지 않았습니다. Windows UAC를 허용한 뒤 다시 실행하세요. ${latest.message}`,
    };
  }

  private async probeHealth(): Promise<{
    ready: boolean;
    message: string;
    unreachable: boolean;
  }> {
    try {
      const token = await this.token();
      const endpoint = new URL(this.config.endpoint);
      const response = await fetch(new URL("/health", endpoint), {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(2_000),
      });
      if (!response.ok) {
        return {
          ready: false,
          message: `로젠 Windows MCP 상태 확인 실패: HTTP ${response.status}`,
          unreachable: false,
        };
      }
      const body = (await response.json()) as { status?: string };
      return body.status === "ready"
        ? {
            ready: true,
            message: "관리자 권한 로젠 Windows MCP가 준비되었습니다.",
            unreachable: false,
          }
        : {
            ready: false,
            message: "로젠 Windows MCP가 준비 상태를 반환하지 않았습니다.",
            unreachable: false,
          };
    } catch (error) {
      return {
        ready: false,
        message: `로젠 Windows MCP에 연결할 수 없습니다: ${errorMessage(error)}`,
        unreachable: true,
      };
    }
  }

  async probe(expectedCount: number): Promise<LogenWindowsPrintDialogResult> {
    return await this.call("probe_logen_print_dialog", { expectedCount });
  }

  async configure(expectedCount: number): Promise<LogenWindowsPrintDialogResult> {
    return await this.call("configure_logen_print_dialog", { expectedCount });
  }

  async prepareDefaultPrinter(
    expectedCount: number,
  ): Promise<LogenWindowsPrintDialogResult> {
    return await this.call("prepare_logen_default_printer", { expectedCount });
  }

  async restoreDefaultPrinter(
    printerName: string,
    expectedCount: number,
  ): Promise<LogenWindowsPrintDialogResult> {
    return await this.call("restore_logen_default_printer", {
      expectedCount,
      printerName,
    });
  }

  async confirm(expectedCount: number): Promise<LogenWindowsPrintDialogResult> {
    return await this.call("confirm_logen_print_dialog", { expectedCount });
  }

  private async call(
    name:
      | "configure_logen_print_dialog"
      | "prepare_logen_default_printer"
      | "restore_logen_default_printer"
      | "probe_logen_print_dialog"
      | "confirm_logen_print_dialog",
    args: { expectedCount: number; printerName?: string },
  ): Promise<LogenWindowsPrintDialogResult> {
    const token = await this.token();
    const client = new Client(
      { name: "supplierhub-fulfillment-mcp", version: "0.1.0" },
      { capabilities: {} },
    );
    const transport = new StreamableHTTPClientTransport(new URL(this.config.endpoint), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    });
    try {
      await client.connect(transport);
      const result = await client.callTool({ name, arguments: args });
      return printDialogResultSchema.parse(result.structuredContent);
    } finally {
      await client.close().catch(() => undefined);
    }
  }

  private async token(): Promise<string> {
    const direct = this.config.token?.trim();
    if (direct) return direct;
    if (this.config.tokenFile) {
      const fromFile = (await readFile(this.config.tokenFile, "utf8")).trim();
      if (fromFile) return fromFile;
    }
    throw new Error("로젠 Windows MCP 인증 토큰이 없습니다.");
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}
