import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { ManagedOrder, StateStore, WorkflowState } from "./types.js";

const DEMO_BASELINE_ORDERS: ManagedOrder[] = [
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
    stage: "baseline",
    firstSeenAt: "2026-07-29T09:31:00+09:00",
    updatedAt: "2026-07-29T09:31:00+09:00",
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
    stage: "baseline",
    firstSeenAt: "2026-07-29T10:11:00+09:00",
    updatedAt: "2026-07-29T10:11:00+09:00",
  },
];

export function createInitialState(now = new Date().toISOString()): WorkflowState {
  return {
    version: 1,
    initialized: true,
    settings: {
      mode: "demo",
      scheduleEnabled: false,
      intervalMinutes: 30,
      windowStart: "09:00",
      windowEnd: "18:00",
      printerName: "SINDOH N600 Series PCL-8",
      copies: 1,
      lookAheadDays: 30,
      firstLiveScanIsBaseline: true,
    },
    orders: structuredClone(DEMO_BASELINE_ORDERS),
    batches: [],
    logs: [
      {
        id: randomUUID(),
        at: now,
        level: "info",
        event: "workflow.created",
        message: "데모 모드로 워크플로가 생성되었습니다. 실제 인쇄는 실행되지 않습니다.",
      },
    ],
  };
}

export class JsonStateStore implements StateStore {
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async read(): Promise<WorkflowState> {
    await this.queue;
    return this.readUnsafe();
  }

  async update(
    mutator: (state: WorkflowState) => WorkflowState | void,
  ): Promise<WorkflowState> {
    let updated: WorkflowState | undefined;

    this.queue = this.queue.then(async () => {
      const current = await this.readUnsafe();
      const working = structuredClone(current);
      updated = mutator(working) ?? working;
      await this.writeUnsafe(updated);
    });

    await this.queue;
    return structuredClone(updated!);
  }

  private async readUnsafe(): Promise<WorkflowState> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      return JSON.parse(raw) as WorkflowState;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw error;
      const initial = createInitialState();
      await this.writeUnsafe(initial);
      return initial;
    }
  }

  private async writeUnsafe(state: WorkflowState): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    await rename(tempPath, this.filePath);
  }
}

export class MemoryStateStore implements StateStore {
  constructor(private state: WorkflowState = createInitialState()) {}

  async read(): Promise<WorkflowState> {
    return structuredClone(this.state);
  }

  async update(
    mutator: (state: WorkflowState) => WorkflowState | void,
  ): Promise<WorkflowState> {
    const working = structuredClone(this.state);
    this.state = mutator(working) ?? working;
    return structuredClone(this.state);
  }
}
