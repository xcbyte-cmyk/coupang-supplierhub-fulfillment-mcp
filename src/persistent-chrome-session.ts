import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { trackWorkspaceBrowser, arrangeBrowserPage } from "./workspace-window-layout.js";
import { SingleFlight } from "./browser-readiness.js";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from "playwright-core";

const FOCUS_BROWSER_WINDOW_SCRIPT = fileURLToPath(
  new URL("../scripts/focus-browser-window.ps1", import.meta.url),
);

/**
 * Owns one persistent Chrome profile and hides Playwright/CDP/Windows focus details
 * from the Supplier Hub and Logen adapters.
 */
export class PersistentChromeSession {
  private readonly pageInitialization = new SingleFlight<Page>();
  private context?: BrowserContext;
  private page?: Page;
  private cdpBrowser?: Browser;
  private cdpProcess?: ChildProcess;

  constructor(
    private readonly profileDir: string,
    private readonly headless: boolean,
    private readonly connectionMode: "playwright" | "cdp" = "playwright",
    private readonly chromeExecutablePath?: string,
    private readonly splitWithDashboard = false,
  ) {}

  async open(url: string): Promise<Page> {
    const page = await this.getPage();
    if (!sameOriginAndPath(page.url(), url)) {
      await page.goto(url, { waitUntil: "domcontentloaded" });
    }
    return page;
  }

  async bringToFront(page: Page): Promise<void> {
    await page.bringToFront();
    if (!this.headless && this.splitWithDashboard && !this.cdpProcess?.pid) {
      await arrangeBrowserPage(page).catch(() => undefined);
    }
    if (process.platform !== "win32" || this.headless || !this.cdpProcess?.pid) {
      return;
    }
    await focusWindowsProcessWindow(this.cdpProcess.pid, this.splitWithDashboard);
  }

  async close(): Promise<void> {
    if (this.cdpBrowser) {
      await this.cdpBrowser.close().catch(() => undefined);
    } else {
      await this.context?.close();
    }
    if (this.cdpProcess && this.cdpProcess.exitCode === null) {
      this.cdpProcess.kill();
    }
    this.context = undefined;
    this.page = undefined;
    this.cdpBrowser = undefined;
    this.cdpProcess = undefined;
  }

  private async getPage(): Promise<Page> {
    return this.pageInitialization.run(() => this.initializePage());
  }

  private async initializePage(): Promise<Page> {
    if (!this.context) {
      await mkdir(this.profileDir, { recursive: true });
      if (this.connectionMode === "cdp") {
        await this.connectToNormallyLaunchedChrome();
      } else {
        this.context = await chromium.launchPersistentContext(this.profileDir, {
          channel: "chrome",
          headless: this.headless,
          acceptDownloads: true,
          viewport: this.splitWithDashboard ? null : { width: 1440, height: 960 },
        });
      }
      const context = this.context;
      if (!context) throw new Error("Chrome 브라우저 컨텍스트를 만들지 못했습니다.");
      context.on("close", () => {
        this.context = undefined;
        this.page = undefined;
      });
    }
    const context = this.context;
    if (!context) throw new Error("Chrome 브라우저 컨텍스트가 종료되었습니다.");
    if (!this.page || this.page.isClosed()) {
      this.page = context.pages()[0] ?? (await context.newPage());
    }
    return this.page;
  }

  private async connectToNormallyLaunchedChrome(): Promise<void> {
    const executable = resolveChromeExecutable(this.chromeExecutablePath);
    const port = await reserveLoopbackPort();
    const args = [
      `--remote-debugging-port=${port}`,
      "--remote-debugging-address=127.0.0.1",
      `--user-data-dir=${this.profileDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-mode",
      "--disable-session-crashed-bubble",
      "--hide-crash-restore-bubble",
    ];
    if (this.headless) args.push("--headless=new");
    this.cdpProcess = spawn(executable, args, {
      detached: false,
      stdio: "ignore",
      windowsHide: this.headless,
    });
    if (!this.headless && this.splitWithDashboard && this.cdpProcess.pid) {
      const untrack = trackWorkspaceBrowser(this.cdpProcess.pid);
      this.cdpProcess.once("exit", untrack);
    }

    let lastError: unknown;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      if (this.cdpProcess.exitCode !== null) {
        throw new Error(
          `일반 Chrome이 원격 디버깅 연결 전에 종료되었습니다. 종료 코드: ${this.cdpProcess.exitCode}`,
        );
      }
      try {
        this.cdpBrowser = await chromium.connectOverCDP(
          `http://127.0.0.1:${port}`,
        );
        this.context = this.cdpBrowser.contexts()[0];
        if (!this.context) throw new Error("Chrome 기본 컨텍스트를 찾을 수 없습니다.");
        this.cdpBrowser.on("disconnected", () => {
          this.context = undefined;
          this.page = undefined;
          this.cdpBrowser = undefined;
          this.cdpProcess = undefined;
        });
        return;
      } catch (error) {
        lastError = error;
        await delay(250);
      }
    }
    this.cdpProcess.kill();
    throw new Error(
      `일반 Chrome CDP 연결을 시작하지 못했습니다: ${errorMessage(lastError)}`,
    );
  }
}

export function sameOriginAndPath(currentUrl: string, targetUrl: string): boolean {
  try {
    const current = new URL(currentUrl);
    const target = new URL(targetUrl);
    return current.origin === target.origin && current.pathname === target.pathname;
  } catch {
    return false;
  }
}

async function focusWindowsProcessWindow(processId: number, splitWithDashboard = false): Promise<void> {
  if (!existsSync(FOCUS_BROWSER_WINDOW_SCRIPT)) return;
  await new Promise<void>((resolveFocus) => {
    const child = spawn(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        FOCUS_BROWSER_WINDOW_SCRIPT,
        "-ProcessId",
        String(processId),
        ...(splitWithDashboard ? ["-SplitWithDashboard"] : []),
      ],
      { stdio: "ignore", windowsHide: true },
    );
    const timeout = setTimeout(() => {
      child.kill();
      resolveFocus();
    }, 5_000);
    const finish = () => {
      clearTimeout(timeout);
      resolveFocus();
    };
    child.once("error", finish);
    child.once("exit", finish);
  });
}

async function reserveLoopbackPort(): Promise<number> {
  return await new Promise<number>((resolvePort, reject) => {
    const server = createNetServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Chrome CDP용 로컬 포트를 확보하지 못했습니다."));
        return;
      }
      const port = address.port;
      server.close((error) => (error ? reject(error) : resolvePort(port)));
    });
  });
}

function resolveChromeExecutable(configured?: string): string {
  const candidates = [
    configured,
    process.env.PROGRAMFILES
      ? join(process.env.PROGRAMFILES, "Google", "Chrome", "Application", "chrome.exe")
      : undefined,
    process.env["PROGRAMFILES(X86)"]
      ? join(
          process.env["PROGRAMFILES(X86)"],
          "Google",
          "Chrome",
          "Application",
          "chrome.exe",
        )
      : undefined,
    process.env.LOCALAPPDATA
      ? join(process.env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe")
      : undefined,
  ].filter((value): value is string => Boolean(value?.trim()));
  const executable = candidates.find((candidate) => existsSync(candidate));
  if (!executable) {
    throw new Error(
      "Google Chrome 실행 파일을 찾지 못했습니다. SUPPLIERHUB_CHROME_EXECUTABLE을 설정하세요.",
    );
  }
  return executable;
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
