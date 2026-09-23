import { afterEach, describe, expect, it, vi } from "vitest";
import { LogenWindowsPrintMcpClient } from "../src/logen-windows-print-client.js";

describe("LogenWindowsPrintMcpClient", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("starts the local print MCP once when the health endpoint is unreachable", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new TypeError("fetch failed");
      return {
        ok: true,
        json: async () => ({ status: "ready" }),
      } as Response;
    }));
    const autoStart = vi.fn(async () => undefined);
    const client = new LogenWindowsPrintMcpClient({
      endpoint: "http://127.0.0.1:4311/mcp",
      token: "test-token",
      autoStart,
      autoStartTimeoutMs: 1_000,
    });

    await expect(client.health()).resolves.toEqual({
      ready: true,
      message: "로젠 Windows MCP를 자동으로 시작해 인쇄 준비를 완료했습니다.",
    });
    expect(autoStart).toHaveBeenCalledTimes(1);
    expect(calls).toBe(2);
  });

  it("does not restart an MCP that responds with an authentication error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 401 }) as Response));
    const autoStart = vi.fn(async () => undefined);
    const client = new LogenWindowsPrintMcpClient({
      endpoint: "http://127.0.0.1:4311/mcp",
      token: "test-token",
      autoStart,
    });

    await expect(client.health()).resolves.toEqual({
      ready: false,
      message: "로젠 Windows MCP 상태 확인 실패: HTTP 401",
    });
    expect(autoStart).not.toHaveBeenCalled();
  });
});
