import { randomUUID } from "node:crypto";
import { createInitialState } from "./state-store.js";
import type {
  ManagedOrder,
  PrintBatch,
  PrinterPort,
  StateStore,
  SupplierHubPort,
  WorkflowDashboard,
  WorkflowLog,
  WorkflowMode,
  WorkflowReply,
  WorkflowSettings,
  WorkflowState,
} from "./types.js";

interface WorkflowPorts {
  suppliers: Record<WorkflowMode, SupplierHubPort>;
  printers: Record<WorkflowMode, PrinterPort>;
}

type SettingsPatch = Partial<WorkflowSettings>;

export class SupplierHubWorkflow {
  private busy = false;

  constructor(
    private readonly store: StateStore,
    private readonly ports: WorkflowPorts,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async getStatus(message = "워크플로 상태를 불러왔습니다."): Promise<WorkflowReply> {
    return this.reply(message, await this.store.read());
  }

  async openLogin(): Promise<WorkflowReply> {
    const state = await this.store.read();
    const status = await this.ports.suppliers[state.settings.mode].openLogin();
    const updated = await this.store.update((draft) => {
      if (status.status === "ready") draft.lastError = undefined;
      else draft.lastError = status.message;
      addLog(
        draft,
        status.status === "ready" ? "success" : "warning",
        "supplierhub.connection",
        status.message,
        this.isoNow(),
      );
    });
    return this.reply(status.message, updated);
  }

  async scan(trigger: "manual" | "scheduled" = "manual"): Promise<WorkflowReply> {
    return this.exclusive(async () => {
      const before = await this.store.read();
      const mode = before.settings.mode;
      const startedAt = this.isoNow();

      await this.store.update((draft) => {
        draft.lastScanAt = startedAt;
        addLog(
          draft,
          "info",
          "scan.started",
          `${trigger === "scheduled" ? "예약" : "수동"} 조회를 시작했습니다.`,
          startedAt,
        );
      });

      try {
        const result = await this.ports.suppliers[mode].scan(before.settings);
        if (result.connection.status !== "ready") {
          const updated = await this.store.update((draft) => {
            draft.lastError = result.connection.message;
            addLog(
              draft,
              "warning",
              "scan.attention",
              result.connection.message,
              this.isoNow(),
            );
          });
          return this.reply(result.connection.message, updated);
        }

        let newCount = 0;
        let baselineCount = 0;
        const updated = await this.store.update((draft) => {
          const isInitialLiveBaseline =
            mode === "live" &&
            !draft.initialized &&
            draft.settings.firstLiveScanIsBaseline;
          const existingByOrderNo = new Map(
            draft.orders.map((order) => [order.orderNo, order]),
          );

          for (const incoming of result.orders) {
            const existing = existingByOrderNo.get(incoming.orderNo);
            if (existing) {
              Object.assign(existing, incoming, { updatedAt: this.isoNow() });
              continue;
            }

            const managed: ManagedOrder = {
              ...incoming,
              stage: isInitialLiveBaseline ? "baseline" : "discovered",
              firstSeenAt: this.isoNow(),
              updatedAt: this.isoNow(),
            };
            draft.orders.push(managed);
            existingByOrderNo.set(managed.orderNo, managed);
            if (managed.stage === "baseline") baselineCount += 1;
            else newCount += 1;
          }

          draft.initialized = true;
          draft.lastSuccessfulScanAt = this.isoNow();
          draft.lastError = undefined;
          addLog(
            draft,
            newCount > 0 ? "success" : "info",
            "scan.completed",
            isInitialLiveBaseline
              ? `첫 실연동 기준선 ${baselineCount}건을 저장했습니다. 인쇄 대상에는 포함하지 않습니다.`
              : `조회 완료: 신규 ${newCount}건, 전체 ${result.orders.length}건`,
            this.isoNow(),
          );
        });

        const message =
          baselineCount > 0
            ? `기존 발주 ${baselineCount}건을 기준선으로 저장했습니다.`
            : newCount > 0
              ? `신규 발주 ${newCount}건을 발견했습니다.`
              : "새로운 발주가 없습니다.";
        return this.reply(message, updated);
      } catch (error) {
        const message = errorMessage(error);
        const failed = await this.store.update((draft) => {
          draft.lastError = message;
          addLog(draft, "error", "scan.failed", message, this.isoNow());
        });
        return this.reply(`조회 실패: ${message}`, failed);
      }
    });
  }

  async preparePrintBatch(orderNos: string[]): Promise<WorkflowReply> {
    const uniqueOrderNos = [...new Set(orderNos.map((value) => value.trim()).filter(Boolean))];
    if (uniqueOrderNos.length === 0) throw new Error("발주서를 한 건 이상 선택하세요.");
    if (uniqueOrderNos.length > 100) throw new Error("한 번에 최대 100건까지 선택할 수 있습니다.");

    const batchId = `batch-${randomUUID().slice(0, 8)}`;
    const now = this.isoNow();
    const updated = await this.store.update((draft) => {
      const orders = uniqueOrderNos.map((orderNo) => {
        const order = draft.orders.find((item) => item.orderNo === orderNo);
        if (!order) throw new Error(`발주 ${orderNo}를 찾을 수 없습니다.`);
        if (!["discovered", "failed", "held"].includes(order.stage)) {
          throw new Error(`발주 ${orderNo}는 현재 ${order.stage} 단계라 배치에 넣을 수 없습니다.`);
        }
        return order;
      });

      const batch: PrintBatch = {
        id: batchId,
        orderNos: uniqueOrderNos,
        status: "awaiting_approval",
        createdAt: now,
        updatedAt: now,
        files: [],
        printerName: draft.settings.printerName,
        copies: draft.settings.copies,
      };
      draft.batches.push(batch);
      for (const order of orders) {
        order.stage = "awaiting_approval";
        order.batchId = batchId;
        order.lastError = undefined;
        order.updatedAt = now;
      }
      addLog(
        draft,
        "info",
        "batch.awaiting_approval",
        `${batchId}: 발주 ${uniqueOrderNos.length}건의 인쇄 승인을 기다립니다.`,
        now,
      );
    });

    return this.reply(
      `${batchId}가 준비되었습니다. 인쇄하려면 "PRINT ${batchId}" 확인이 필요합니다.`,
      updated,
    );
  }

  async holdBatch(batchId: string): Promise<WorkflowReply> {
    const updated = await this.store.update((draft) => {
      const batch = requireBatch(draft, batchId);
      if (batch.status !== "awaiting_approval") {
        throw new Error("승인 대기 중인 배치만 보류할 수 있습니다.");
      }
      batch.status = "held";
      batch.updatedAt = this.isoNow();
      for (const order of ordersForBatch(draft, batch)) {
        order.stage = "held";
        order.updatedAt = this.isoNow();
      }
      addLog(draft, "warning", "batch.held", `${batchId}를 보류했습니다.`, this.isoNow());
    });
    return this.reply(`${batchId}를 보류했습니다.`, updated);
  }

  async printBatch(batchId: string, confirmation: string): Promise<WorkflowReply> {
    return this.exclusive(async () => {
      const before = await this.store.read();
      const batch = requireBatch(before, batchId);
      const expected = `PRINT ${batchId}`;
      if (confirmation !== expected) {
        throw new Error(`인쇄 확인 문구가 일치하지 않습니다. 정확히 "${expected}"를 입력하세요.`);
      }
      if (!["awaiting_approval", "failed"].includes(batch.status)) {
        throw new Error(`현재 ${batch.status} 상태의 배치는 인쇄할 수 없습니다.`);
      }

      const mode = before.settings.mode;
      await this.store.update((draft) => {
        const current = requireBatch(draft, batchId);
        current.status = "preparing";
        current.error = undefined;
        current.updatedAt = this.isoNow();
        for (const order of ordersForBatch(draft, current)) {
          order.stage = "preparing";
          order.lastError = undefined;
          order.updatedAt = this.isoNow();
        }
        addLog(
          draft,
          "info",
          "batch.preparing",
          `${batchId}: 발주서 다운로드와 검증을 시작합니다.`,
          this.isoNow(),
        );
      });

      try {
        const files = await this.ports.suppliers[mode].prepare(batch.orderNos, batchId);
        await this.store.update((draft) => {
          const current = requireBatch(draft, batchId);
          current.status = "printing";
          current.files = files;
          current.updatedAt = this.isoNow();
          for (const order of ordersForBatch(draft, current)) {
            const file = files.find((item) => item.orderNo === order.orderNo);
            order.stage = "printing";
            order.fileHash = file?.sha256;
            order.updatedAt = this.isoNow();
          }
          addLog(
            draft,
            "info",
            "batch.printing",
            `${batchId}: 검증된 XLSX ${files.length}개를 인쇄 큐로 보냅니다.`,
            this.isoNow(),
          );
        });

        const printResult = await this.ports.printers[mode].print(files, before.settings);
        if (!printResult.success) throw new Error(printResult.message);

        const completedAt = this.isoNow();
        const completed = await this.store.update((draft) => {
          const current = requireBatch(draft, batchId);
          current.status = "completed";
          current.updatedAt = completedAt;
          for (const order of ordersForBatch(draft, current)) {
            order.stage = "printed";
            order.printedAt = completedAt;
            order.lastError = undefined;
            order.updatedAt = completedAt;
          }
          addLog(draft, "success", "batch.completed", printResult.message, completedAt);
        });
        return this.reply(printResult.message, completed);
      } catch (error) {
        const message = errorMessage(error);
        const failed = await this.store.update((draft) => {
          const current = requireBatch(draft, batchId);
          current.status = "failed";
          current.error = message;
          current.updatedAt = this.isoNow();
          for (const order of ordersForBatch(draft, current)) {
            order.stage = "failed";
            order.lastError = message;
            order.updatedAt = this.isoNow();
          }
          addLog(draft, "error", "batch.failed", `${batchId}: ${message}`, this.isoNow());
        });
        return this.reply(`인쇄 실패: ${message}`, failed);
      }
    });
  }

  async updateSettings(patch: SettingsPatch): Promise<WorkflowReply> {
    const before = await this.store.read();
    const next = normalizeSettings({ ...before.settings, ...patch });
    const modeChanged = before.settings.mode !== next.mode;

    if (modeChanged) await this.ports.suppliers[before.settings.mode].close?.();

    const updated = await this.store.update((draft) => {
      if (modeChanged) {
        if (next.mode === "demo") {
          const fresh = createInitialState(this.isoNow());
          draft.initialized = fresh.initialized;
          draft.orders = fresh.orders;
          draft.batches = [];
        } else {
          draft.initialized = !next.firstLiveScanIsBaseline;
          draft.orders = [];
          draft.batches = [];
        }
        draft.lastScanAt = undefined;
        draft.lastSuccessfulScanAt = undefined;
        draft.lastError = undefined;
      }
      draft.settings = next;
      addLog(
        draft,
        "info",
        "settings.updated",
        `설정 저장: ${next.mode === "live" ? "실연동" : "데모"}, ${next.intervalMinutes}분, ${next.printerName}`,
        this.isoNow(),
      );
    });

    return this.reply("워크플로 설정을 저장했습니다.", updated);
  }

  async scheduledTick(): Promise<void> {
    const state = await this.store.read();
    if (!state.settings.scheduleEnabled || this.busy) return;
    if (!isInsideWindow(this.now(), state.settings.windowStart, state.settings.windowEnd)) return;

    const last = state.lastScanAt ? Date.parse(state.lastScanAt) : 0;
    const dueAt = last + state.settings.intervalMinutes * 60_000;
    if (this.now().getTime() < dueAt) return;
    await this.scan("scheduled");
  }

  private async reply(message: string, state: WorkflowState): Promise<WorkflowReply> {
    return { message, dashboard: dashboardFromState(state) };
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    if (this.busy) throw new Error("다른 조회 또는 인쇄 작업이 진행 중입니다.");
    this.busy = true;
    try {
      return await operation();
    } finally {
      this.busy = false;
    }
  }

  private isoNow(): string {
    return this.now().toISOString();
  }
}

function dashboardFromState(state: WorkflowState): WorkflowDashboard {
  const byStage = (stages: ManagedOrder["stage"][]) =>
    state.orders.filter((order) => stages.includes(order.stage)).length;
  const supplierHub =
    state.settings.mode === "demo"
      ? "demo"
      : state.lastError?.includes("로그인")
        ? "login_required"
        : state.lastError
          ? "error"
          : state.lastSuccessfulScanAt
            ? "ready"
            : "unknown";

  return {
    settings: structuredClone(state.settings),
    summary: {
      newOrders: byStage(["discovered"]),
      awaitingApproval: byStage(["awaiting_approval", "held"]),
      printing: byStage(["preparing", "printing"]),
      completed: byStage(["printed"]),
      failed: byStage(["failed"]),
    },
    orders: [...state.orders].sort((a, b) => b.firstSeenAt.localeCompare(a.firstSeenAt)),
    batches: [...state.batches].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    logs: [...state.logs].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 100),
    initialized: state.initialized,
    lastScanAt: state.lastScanAt,
    lastSuccessfulScanAt: state.lastSuccessfulScanAt,
    lastError: state.lastError,
    connection: {
      mode: state.settings.mode,
      supplierHub,
      printer: state.settings.mode === "demo" ? "dry_run" : "configured",
    },
  };
}

function addLog(
  state: WorkflowState,
  level: WorkflowLog["level"],
  event: string,
  message: string,
  at: string,
): void {
  state.logs.push({ id: randomUUID(), at, level, event, message });
  if (state.logs.length > 500) state.logs = state.logs.slice(-500);
}

function requireBatch(state: WorkflowState, batchId: string): PrintBatch {
  const batch = state.batches.find((item) => item.id === batchId);
  if (!batch) throw new Error(`배치 ${batchId}를 찾을 수 없습니다.`);
  return batch;
}

function ordersForBatch(state: WorkflowState, batch: PrintBatch): ManagedOrder[] {
  return batch.orderNos.map((orderNo) => {
    const order = state.orders.find((item) => item.orderNo === orderNo);
    if (!order) throw new Error(`배치의 발주 ${orderNo}를 찾을 수 없습니다.`);
    return order;
  });
}

function normalizeSettings(settings: WorkflowSettings): WorkflowSettings {
  const timePattern = /^([01]\d|2[0-3]):[0-5]\d$/;
  if (!timePattern.test(settings.windowStart) || !timePattern.test(settings.windowEnd)) {
    throw new Error("실행 시간은 HH:MM 형식이어야 합니다.");
  }
  if (!Number.isInteger(settings.intervalMinutes) || settings.intervalMinutes < 5 || settings.intervalMinutes > 1440) {
    throw new Error("조회 간격은 5~1440분 사이의 정수여야 합니다.");
  }
  if (!Number.isInteger(settings.copies) || settings.copies < 1 || settings.copies > 5) {
    throw new Error("인쇄 부수는 1~5 사이의 정수여야 합니다.");
  }
  if (![7, 30].includes(settings.lookAheadDays)) {
    throw new Error("조회 범위는 다음 7일 또는 다음 30일만 지원합니다.");
  }
  if (!settings.printerName.trim()) throw new Error("프린터 이름이 필요합니다.");
  return { ...settings, printerName: settings.printerName.trim() };
}

function isInsideWindow(now: Date, start: string, end: string): boolean {
  const weekday = now.getDay();
  if (weekday === 0 || weekday === 6) return false;
  const current = now.getHours() * 60 + now.getMinutes();
  const [startHour, startMinute] = start.split(":").map(Number);
  const [endHour, endMinute] = end.split(":").map(Number);
  return current >= startHour * 60 + startMinute && current <= endHour * 60 + endMinute;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
