import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { migrateFulfillmentDatabase } from "./fulfillment-store-schema.js";
import type {
  CenterMaster,
  ClassifiedFulfillmentOrder,
  CoupangUploadJob,
  FulfillmentArtifact,
  FulfillmentCarton,
  FulfillmentOrder,
  FulfillmentOrderQuery,
  FulfillmentOrderItem,
  FulfillmentRun,
  FulfillmentRunStatus,
  FulfillmentStage,
  FulfillmentStageStatus,
  FulfillmentWorkflowVersion,
  LogenBatch,
  LogenIntegrationMethod,
  OrderConfirmationJob,
  OrderConfirmationStatus,
  ProductMaster,
  ScanSnapshot,
  SenderProfile,
  ShipmentGroup,
  ShippingJob,
  StageRecord,
} from "./fulfillment-types.js";

type SqlPrimitive = string | number | bigint | null;

interface RunRow {
  id: string;
  scan_id: string;
  status: FulfillmentRunStatus;
  current_stage: number;
  created_at: string;
  updated_at: string;
  last_error: string | null;
  logen_integration_method: LogenIntegrationMethod | null;
  workflow_version: number;
}

export class FulfillmentStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
    migrateFulfillmentDatabase(this.db);
  }

  close(): void {
    this.db.close();
  }

  saveScan(
    orders: FulfillmentOrder[],
    lookAheadDays: 7 | 30,
    createdAt = new Date().toISOString(),
    query?: Pick<
      FulfillmentOrderQuery,
      "dateSearchType" | "dateFrom" | "dateTo"
    >,
  ): ScanSnapshot {
    const id = `scan-${randomUUID().slice(0, 12)}`;
    this.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO scans
           (id, look_ahead_days, date_search_type, date_from, date_to, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          lookAheadDays,
          query?.dateSearchType ?? "expected_inbound_date",
          query?.dateFrom ?? null,
          query?.dateTo ?? null,
          createdAt,
        );
      const insert = this.db.prepare(
        "INSERT INTO scan_orders (scan_id, order_no, payload_json, is_new) VALUES (?, ?, ?, NULL)",
      );
      for (const order of uniqueOrders(orders)) {
        insert.run(id, order.orderNo, JSON.stringify(order));
      }
    });
    return {
      id,
      lookAheadDays,
      dateSearchType: query?.dateSearchType ?? "expected_inbound_date",
      dateFrom: query?.dateFrom,
      dateTo: query?.dateTo,
      createdAt,
      orders: uniqueOrders(orders),
    };
  }

  getScan(scanId: string): ScanSnapshot {
    const scan = this.db
      .prepare(
        `SELECT id, look_ahead_days, date_search_type, date_from, date_to, created_at
         FROM scans WHERE id = ?`,
      )
      .get(scanId) as
      | {
          id: string;
          look_ahead_days: number;
          date_search_type: "expected_inbound_date" | "order_date" | null;
          date_from: string | null;
          date_to: string | null;
          created_at: string;
        }
      | undefined;
    if (!scan) throw new Error(`스캔 ${scanId}을 찾을 수 없습니다.`);
    const rows = this.db
      .prepare("SELECT payload_json FROM scan_orders WHERE scan_id = ? ORDER BY order_no")
      .all(scanId) as Array<{ payload_json: string }>;
    return {
      id: scan.id,
      lookAheadDays: scan.look_ahead_days as 7 | 30,
      dateSearchType: scan.date_search_type ?? "expected_inbound_date",
      dateFrom: scan.date_from ?? undefined,
      dateTo: scan.date_to ?? undefined,
      createdAt: scan.created_at,
      orders: rows.map((row) => parseJson<FulfillmentOrder>(row.payload_json)),
    };
  }

  getLatestScanId(): string | undefined {
    const row = this.db
      .prepare("SELECT id FROM scans ORDER BY created_at DESC, rowid DESC LIMIT 1")
      .get() as { id: string } | undefined;
    return row?.id;
  }

  getLatestRunId(): string | undefined {
    const row = this.db
      .prepare(
        `SELECT id FROM fulfillment_runs
         WHERE workflow_version IN (2, 3) AND status <> 'released'
         ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      )
      .get() as { id: string } | undefined;
    return row?.id;
  }

  listRecentContexts(limit = 20): {
    scans: Array<{
      id: string;
      lookAheadDays: number;
      dateSearchType: string;
      dateFrom?: string;
      dateTo?: string;
      createdAt: string;
      orderCount: number;
      runCount: number;
    }>;
    runs: Array<{
      id: string;
      scanId: string;
      workflowVersion: number;
      status: string;
      currentStage: number;
      createdAt: string;
      updatedAt: string;
      orderCount: number;
    }>;
  } {
    const safeLimit = Math.max(1, Math.min(50, Math.trunc(limit)));
    const scans = this.db
      .prepare(
        `SELECT s.id, s.look_ahead_days, s.date_search_type, s.date_from, s.date_to,
                s.created_at, COUNT(DISTINCT so.order_no) AS order_count,
                COUNT(DISTINCT r.id) AS run_count
         FROM scans s
         LEFT JOIN scan_orders so ON so.scan_id = s.id
         LEFT JOIN fulfillment_runs r ON r.scan_id = s.id
         GROUP BY s.id
         ORDER BY s.created_at DESC, s.rowid DESC
         LIMIT ?`,
      )
      .all(safeLimit) as Array<Record<string, unknown>>;
    const runs = this.db
      .prepare(
        `SELECT r.id, r.scan_id, r.workflow_version, r.status, r.current_stage,
                r.created_at, r.updated_at, COUNT(ro.order_no) AS order_count
         FROM fulfillment_runs r
         LEFT JOIN fulfillment_run_orders ro ON ro.run_id = r.id
         GROUP BY r.id
         ORDER BY r.created_at DESC, r.rowid DESC
         LIMIT ?`,
      )
      .all(safeLimit) as Array<Record<string, unknown>>;
    return {
      scans: scans.map((row) => ({
        id: String(row.id),
        lookAheadDays: Number(row.look_ahead_days),
        dateSearchType: String(row.date_search_type ?? "expected_inbound_date"),
        dateFrom: row.date_from ? String(row.date_from) : undefined,
        dateTo: row.date_to ? String(row.date_to) : undefined,
        createdAt: String(row.created_at),
        orderCount: Number(row.order_count),
        runCount: Number(row.run_count),
      })),
      runs: runs.map((row) => ({
        id: String(row.id),
        scanId: String(row.scan_id),
        workflowVersion: Number(row.workflow_version),
        status: String(row.status),
        currentStage: Number(row.current_stage),
        createdAt: String(row.created_at),
        updatedAt: String(row.updated_at),
        orderCount: Number(row.order_count),
      })),
    };
  }

  deleteRunRecord(runId: string): { runId: string; deleted: true; releasedOrderNos: string[] } {
    const run = this.getRun(runId);
    const releasedOrderNos = run.orders.map((order) => order.orderNo);
    this.transaction(() => {
      this.db.prepare("DELETE FROM fulfillment_run_order_conflicts WHERE run_id = ? OR kept_run_id = ?").run(runId, runId);
      this.db.prepare("DELETE FROM fulfillment_runs WHERE id = ?").run(runId);
      const reset = this.db.prepare(
        `UPDATE scan_orders SET is_new = NULL, is_first_seen = NULL,
           is_unprocessed = NULL, disposition = NULL WHERE order_no = ?`,
      );
      for (const orderNo of releasedOrderNos) reset.run(orderNo);
    });
    return { runId, deleted: true, releasedOrderNos };
  }

  deleteScanRecord(scanId: string): {
    scanId: string;
    deleted: true;
    deletedRunIds: string[];
  } {
    this.getScan(scanId);
    const runRows = this.db
      .prepare("SELECT id FROM fulfillment_runs WHERE scan_id = ? ORDER BY created_at")
      .all(scanId) as Array<{ id: string }>;
    const deletedRunIds = runRows.map((row) => row.id);
    const orderRows = this.db
      .prepare(
        `SELECT DISTINCT ro.order_no
         FROM fulfillment_run_orders ro
         JOIN fulfillment_runs r ON r.id = ro.run_id
         WHERE r.scan_id = ?`,
      )
      .all(scanId) as Array<{ order_no: string }>;
    this.transaction(() => {
      for (const deletedRunId of deletedRunIds) {
        this.db
          .prepare("DELETE FROM fulfillment_run_order_conflicts WHERE run_id = ? OR kept_run_id = ?")
          .run(deletedRunId, deletedRunId);
      }
      this.db.prepare("DELETE FROM fulfillment_runs WHERE scan_id = ?").run(scanId);
      this.db.prepare("DELETE FROM scans WHERE id = ?").run(scanId);
      const reset = this.db.prepare(
        `UPDATE scan_orders SET is_new = NULL, is_first_seen = NULL,
           is_unprocessed = NULL, disposition = NULL WHERE order_no = ?`,
      );
      for (const row of orderRows) reset.run(row.order_no);
    });
    return { scanId, deleted: true, deletedRunIds };
  }

  resetStageRecord(
    runId: string,
    stage: FulfillmentStage,
    at = new Date().toISOString(),
    allowUnknown = false,
    quickReset = false,
    clearLogenRegistration = false,
  ): {
    runId: string;
    stage: FulfillmentStage;
    previousStatus: "blocked" | "failed" | "unknown" | "completed";
    resetWaybillBatchIds: string[];
    clearedLogenBatchIds: string[];
  } {
    const run = this.getRun(runId);
    const record = run.stages.find((item) => item.stage === stage);
    if (!record) {
      throw new Error(`Run ${runId}의 ${stage}단계 이력이 없습니다.`);
    }
    const resettableFailure = record.status === "blocked" || record.status === "failed";
    const confirmedUnknown =
      allowUnknown && stage === 14 && record.status === "unknown";
    const calibrationCompleted = quickReset && record.status === "completed";
    if (!resettableFailure && !confirmedUnknown && !calibrationCompleted) {
      throw new Error(
        `${stage}단계 ${record.status} 이력은 초기화할 수 없습니다. unknown 14단계는 실제 미출력을 확인한 강제 초기화에서만 처리할 수 있습니다.`,
      );
    }
    if (clearLogenRegistration && stage !== 13) {
      throw new Error("로젠 예약키 초기화는 13단계에서만 사용할 수 있습니다.");
    }

    if (stage === 14) {
      const submittedArtifacts = this.db
        .prepare(
          `SELECT COUNT(*) AS count
           FROM fulfillment_artifacts
           WHERE run_id = ? AND type = 'waybill_print'
             AND (status = 'submitted' OR submitted_at IS NOT NULL)`,
        )
        .get(runId) as { count: number };
      const unknownArtifacts = this.db
        .prepare(
          `SELECT COUNT(*) AS count
           FROM fulfillment_artifacts
           WHERE run_id = ? AND type = 'waybill_print' AND status = 'unknown'`,
        )
        .get(runId) as { count: number };
      const numberedCartons = this.db
        .prepare(
          `SELECT COUNT(*) AS count
           FROM fulfillment_cartons c
           JOIN logen_batches b ON b.id = c.batch_id
           WHERE b.run_id = ?
             AND coalesce(c.slip_no, c.original_slip_no, c.waybill_no) IS NOT NULL`,
        )
        .get(runId) as { count: number };
      const uncertainBatches = this.db
        .prepare(
          `SELECT COUNT(*) AS count
           FROM logen_batches
           WHERE run_id = ? AND waybill_status IN ('in_flight', 'submitted')`,
        )
        .get(runId) as { count: number };
      if (
        !quickReset &&
        (Number(submittedArtifacts.count) > 0 ||
          Number(numberedCartons.count) > 0 ||
          Number(uncertainBatches.count) > 0 ||
          (!allowUnknown && Number(unknownArtifacts.count) > 0))
      ) {
        throw new Error(
          "14단계에는 출력 제출 또는 송장번호 후보 기록이 있어 이력을 초기화할 수 없습니다.",
        );
      }
    }

    const resetWaybillBatchIds =
      stage === 14
        ? this.db
            .prepare(
              `SELECT id FROM logen_batches
               WHERE run_id = ?
                 AND waybill_status IN (${quickReset ? "'failed', 'unknown', 'in_flight', 'submitted'" : allowUnknown ? "'failed', 'unknown'" : "'failed'"})
               ORDER BY id`,
            )
            .all(runId)
            .map((row) => String((row as { id: string }).id))
        : [];
    const clearedLogenBatchIds = clearLogenRegistration
      ? this.db
          .prepare(
            `SELECT id FROM logen_batches
             WHERE run_id = ?
               AND (logen_order_no IS NOT NULL OR registration_keys_json IS NOT NULL)
             ORDER BY id`,
          )
          .all(runId)
          .map((row) => String((row as { id: string }).id))
      : [];

    if (clearLogenRegistration) {
      const numberedCartons = this.db
        .prepare(
          `SELECT COUNT(*) AS count
           FROM fulfillment_cartons c
           JOIN logen_batches b ON b.id = c.batch_id
           WHERE b.run_id = ?
             AND coalesce(c.slip_no, c.original_slip_no, c.waybill_no) IS NOT NULL`,
        )
        .get(runId) as { count: number };
      const submittedArtifacts = this.db
        .prepare(
          `SELECT COUNT(*) AS count
           FROM fulfillment_artifacts
           WHERE run_id = ? AND type = 'waybill_print'
             AND (status = 'submitted' OR submitted_at IS NOT NULL)`,
        )
        .get(runId) as { count: number };
      if (Number(numberedCartons.count) > 0 || Number(submittedArtifacts.count) > 0) {
        throw new Error(
          "송장번호 또는 출력 제출 기록이 있어 로젠 예약키를 초기화할 수 없습니다.",
        );
      }
    }

    this.transaction(() => {
      this.db
        .prepare("DELETE FROM fulfillment_stage_results WHERE run_id = ? AND stage = ?")
        .run(runId, stage);
      if (stage === 14) {
        if (quickReset) {
          this.db
            .prepare("DELETE FROM fulfillment_artifacts WHERE run_id = ? AND type = 'waybill_print'")
            .run(runId);
        }
        this.db
          .prepare(
            `UPDATE logen_batches
             SET status = CASE
                   WHEN registration_keys_json IS NOT NULL THEN 'registered'
                   ELSE status
                 END,
                 waybill_status = 'not_started',
                 waybill_message = NULL,
                 message = CASE
                   WHEN ? = 1 THEN '사용자가 실제 미출력을 확인하고 14단계 unknown 상태를 초기화했습니다.'
                   ELSE message
                 END,
                 updated_at = ?
             WHERE run_id = ?
               AND waybill_status IN (${quickReset ? "'failed', 'unknown', 'in_flight', 'submitted'" : allowUnknown ? "'failed', 'unknown'" : "'failed'"})`,
          )
          .run(allowUnknown ? 1 : 0, at, runId);
        this.db
          .prepare(
            `UPDATE fulfillment_shipping_jobs
             SET status = 'registered', slip_no = NULL, error = NULL, waybill_printed_at = NULL
             WHERE run_id = ? AND logen_registered_at IS NOT NULL
               AND (? = 1 OR slip_no IS NULL)`,
          )
          .run(runId, quickReset ? 1 : 0);
        this.db
          .prepare(
            `UPDATE fulfillment_cartons
             SET status = 'ready',
                 slip_no = CASE WHEN ? = 1 THEN NULL ELSE slip_no END,
                 original_slip_no = CASE WHEN ? = 1 THEN NULL ELSE original_slip_no END,
                 waybill_no = CASE WHEN ? = 1 THEN NULL ELSE waybill_no END,
                 message = NULL,
                 updated_at = ?
             WHERE batch_id IN (SELECT id FROM logen_batches WHERE run_id = ?)
               AND (? = 1 OR coalesce(slip_no, original_slip_no, waybill_no) IS NULL)`,
          )
          .run(
            quickReset ? 1 : 0,
            quickReset ? 1 : 0,
            quickReset ? 1 : 0,
            at,
            runId,
            quickReset ? 1 : 0,
          );
      }
      if (clearLogenRegistration) {
        this.db
          .prepare(
            `UPDATE logen_batches
             SET status = 'ready',
                 logen_order_no = NULL,
                 registration_keys_json = NULL,
                 registration_recorded_at = NULL,
                 waybill_status = 'not_started',
                 waybill_message = NULL,
                 message = '사용자가 로젠 예약 삭제 후 13단계 등록정보를 초기화했습니다.',
                 updated_at = ?
             WHERE run_id = ?`,
          )
          .run(at, runId);
        this.db
          .prepare(
            `UPDATE fulfillment_shipping_jobs
             SET status = 'ready', logen_registered_at = NULL, error = NULL
             WHERE run_id = ? AND slip_no IS NULL`,
          )
          .run(runId);
        this.db
          .prepare(
            `UPDATE fulfillment_cartons
             SET status = 'ready', message = NULL, updated_at = ?
             WHERE batch_id IN (SELECT id FROM logen_batches WHERE run_id = ?)
               AND coalesce(slip_no, original_slip_no, waybill_no) IS NULL`,
          )
          .run(at, runId);
      }

      if (run.currentStage === stage) {
        const latest = this.db
          .prepare(
            `SELECT stage, status, message
             FROM fulfillment_stage_results
             WHERE run_id = ? ORDER BY stage DESC LIMIT 1`,
          )
          .get(runId) as
          | { stage: number; status: FulfillmentStageStatus; message: string }
          | undefined;
        const currentStage = latest
          ? (latest.stage as FulfillmentStage)
          : (Math.max(1, stage - 1) as FulfillmentStage);
        const runStatus = latest
          ? stageStatusToRunStatus(
              latest.status,
              currentStage,
              run.workflowVersion,
            )
          : "running";
        this.db
          .prepare(
            `UPDATE fulfillment_runs
             SET current_stage = ?, status = ?, updated_at = ?, last_error = ?
             WHERE id = ?`,
          )
          .run(
            currentStage,
            runStatus,
            at,
            latest && ["blocked", "failed", "unknown"].includes(latest.status)
              ? latest.message
              : null,
            runId,
          );
      }
    });

    return {
      runId,
      stage,
      previousStatus: record.status as
        | "blocked"
        | "failed"
        | "unknown"
        | "completed",
      resetWaybillBatchIds,
      clearedLogenBatchIds,
    };
  }

  releaseRunAssignments(
    runId: string,
    at = new Date().toISOString(),
  ): { runId: string; releasedOrderNos: string[] } {
    const run = this.getRun(runId);
    const irreversibleStage = run.stages.find(
      (stage) => stage.stage >= 7 && ["completed", "partial", "unknown"].includes(stage.status),
    );
    if (
      irreversibleStage ||
      run.artifacts.length > 0 ||
      run.shippingJobs.length > 0 ||
      (run.coupangUploadJobs?.length ?? 0) > 0
    ) {
      throw new Error(
        `실행 ${runId}은(는) 외부 등록 또는 출력 단계가 시작되어 배정을 해제할 수 없습니다.`,
      );
    }

    const releasedOrderNos = run.orders.map((order) => order.orderNo);
    if (releasedOrderNos.length === 0) {
      return { runId, releasedOrderNos: [] };
    }

    this.transaction(() => {
      const resetScanOrder = this.db.prepare(
        `UPDATE scan_orders SET
           is_new = NULL, is_first_seen = NULL, is_unprocessed = NULL, disposition = NULL
         WHERE order_no = ?`,
      );
      for (const orderNo of releasedOrderNos) resetScanOrder.run(orderNo);
      this.db.prepare("DELETE FROM fulfillment_run_orders WHERE run_id = ?").run(runId);
      this.db
        .prepare(
          `UPDATE fulfillment_runs SET status = 'released', updated_at = ?,
             last_error = '사용자가 고급 복구 옵션에서 발주 배정을 해제했습니다.'
           WHERE id = ?`,
        )
        .run(at, runId);
    });
    return { runId, releasedOrderNos };
  }

  compareAndRecordNewOrders(
    scanId: string,
    at = new Date().toISOString(),
  ): FulfillmentOrder[] {
    return this.classifyAndRecordOrders(scanId, at)
      .filter(
        (item) =>
          item.unprocessed &&
          ["needs_confirmation", "already_confirmed"].includes(item.disposition),
      )
      .map((item) => item.order);
  }

  classifyAndRecordOrders(
    scanId: string,
    at = new Date().toISOString(),
  ): ClassifiedFulfillmentOrder[] {
    this.getScan(scanId);
    this.transaction(() => {
      const pending = this.db
        .prepare(
          `SELECT order_no, payload_json FROM scan_orders
           WHERE scan_id = ? AND disposition IS NULL ORDER BY order_no`,
        )
        .all(scanId) as Array<{ order_no: string; payload_json: string }>;
      const findOrder = this.db.prepare(
        "SELECT 1 FROM fulfillment_orders WHERE order_no = ? LIMIT 1",
      );
      const assignedToRun = this.db.prepare(
        "SELECT run_id FROM fulfillment_run_orders WHERE order_no = ? LIMIT 1",
      );
      const insertOrder = this.db.prepare(
        `INSERT INTO fulfillment_orders (order_no, payload_json, first_seen_at, updated_at)
         VALUES (?, ?, ?, ?) ON CONFLICT(order_no) DO UPDATE SET payload_json = excluded.payload_json, updated_at = excluded.updated_at`,
      );
      const insertItem = this.db.prepare(
        `INSERT INTO fulfillment_order_items (order_no, sku_code, payload_json)
         VALUES (?, ?, ?) ON CONFLICT(order_no, sku_code) DO UPDATE SET payload_json = excluded.payload_json`,
      );
      const mark = this.db.prepare(
        `UPDATE scan_orders SET
           is_new = ?, is_first_seen = ?, is_unprocessed = ?, disposition = ?
         WHERE scan_id = ? AND order_no = ?`,
      );
      for (const row of pending) {
        const order = parseJson<FulfillmentOrder>(row.payload_json);
        const firstSeen = !findOrder.get(row.order_no);
        const owner = assignedToRun.get(row.order_no) as { run_id: string } | undefined;
        const unprocessed = !owner;
        const disposition = owner
          ? "already_assigned"
          : order.status === "거래처확인요청"
            ? "needs_confirmation"
            : order.status === "발주확정"
              ? "already_confirmed"
              : "unsupported_status";
        insertOrder.run(row.order_no, row.payload_json, at, at);
        for (const item of order.items) insertItem.run(row.order_no, item.skuCode, JSON.stringify(item));
        const actionable =
          unprocessed && ["needs_confirmation", "already_confirmed"].includes(disposition);
        mark.run(
          actionable ? 1 : 0,
          firstSeen ? 1 : 0,
          unprocessed ? 1 : 0,
          disposition,
          scanId,
          row.order_no,
        );
      }
    });
    return this.classifiedOrdersForScan(scanId);
  }

  classifiedOrdersForScan(scanId: string): ClassifiedFulfillmentOrder[] {
    const rows = this.db
      .prepare(
        `SELECT payload_json, is_first_seen, is_unprocessed, disposition
         FROM scan_orders WHERE scan_id = ? ORDER BY order_no`,
      )
      .all(scanId) as Array<{
        payload_json: string;
        is_first_seen: number | null;
        is_unprocessed: number | null;
        disposition: ClassifiedFulfillmentOrder["disposition"] | null;
      }>;
    return rows.map((row) => {
      const order = parseJson<FulfillmentOrder>(row.payload_json);
      const disposition = row.disposition ?? "unsupported_status";
      const firstSeen = row.is_first_seen === 1;
      const unprocessed = row.is_unprocessed === 1;
      return {
        order,
        disposition,
        firstSeen,
        unprocessed,
        message: classificationMessage(order, disposition, firstSeen, unprocessed),
      };
    });
  }

  newOrdersForScan(scanId: string): FulfillmentOrder[] {
    const rows = this.db
      .prepare(
        `SELECT payload_json FROM scan_orders
         WHERE scan_id = ? AND is_unprocessed = 1
           AND disposition IN ('needs_confirmation', 'already_confirmed')
         ORDER BY order_no`,
      )
      .all(scanId) as Array<{ payload_json: string }>;
    return rows.map((row) => parseJson<FulfillmentOrder>(row.payload_json));
  }

  createRun(
    scanId: string,
    selectedOrderNos?: string[],
    at = new Date().toISOString(),
  ): FulfillmentRun {
    const available = this.newOrdersForScan(scanId);
    if (available.length === 0) {
      return this.getRun(this.assignedRunForScan(scanId, selectedOrderNos));
    }
    const requested = selectedOrderNos
      ? [...new Set(selectedOrderNos.map((value) => value.trim()).filter(Boolean))].sort()
      : available.map((order) => order.orderNo).sort();
    const availableSet = new Set(available.map((order) => order.orderNo));
    for (const orderNo of requested) {
      if (!availableSet.has(orderNo)) throw new Error(`신규 발주 ${orderNo}를 스캔에서 찾을 수 없습니다.`);
    }
    if (requested.length === 0) throw new Error("실행할 발주가 없습니다.");

    const id = this.transaction(() => {
      const findOwner = this.db.prepare(
        "SELECT run_id FROM fulfillment_run_orders WHERE order_no = ? LIMIT 1",
      );
      const owners = new Map<string, string>();
      for (const orderNo of requested) {
        const owner = findOwner.get(orderNo) as { run_id: string } | undefined;
        if (owner) owners.set(orderNo, owner.run_id);
      }
      const unassigned = requested.filter((orderNo) => !owners.has(orderNo));
      if (unassigned.length === 0) {
        const ownerRunIds = [...new Set(owners.values())];
        if (ownerRunIds.length === 1) return ownerRunIds[0];
        throw new Error("선택한 발주가 이미 여러 실행에 배정되어 새 실행을 만들지 않았습니다.");
      }

      const selectionKey = JSON.stringify(unassigned);
      const existing = this.db
        .prepare("SELECT id FROM fulfillment_runs WHERE scan_id = ? AND selection_key = ?")
        .get(scanId, selectionKey) as { id: string } | undefined;
      if (existing) return existing.id;

      const runId = `run-${randomUUID().slice(0, 12)}`;
      this.db
        .prepare(
          `INSERT INTO fulfillment_runs
           (id, scan_id, selection_key, workflow_version, status, current_stage, created_at, updated_at)
           VALUES (?, ?, ?, 3, 'created', 4, ?, ?)`,
        )
        .run(runId, scanId, selectionKey, at, at);
      const insert = this.db.prepare(
        "INSERT INTO fulfillment_run_orders (run_id, order_no) VALUES (?, ?)",
      );
      for (const orderNo of unassigned) insert.run(runId, orderNo);
      return runId;
    });
    return this.getRun(id);
  }

  private assignedRunForScan(scanId: string, selectedOrderNos?: string[]): string {
    this.getScan(scanId);
    const rows = this.db
      .prepare(
        `SELECT so.order_no, ro.run_id
         FROM scan_orders so
         JOIN fulfillment_run_orders ro ON ro.order_no = so.order_no
         WHERE so.scan_id = ? AND so.disposition = 'already_assigned'
         ORDER BY so.order_no`,
      )
      .all(scanId) as Array<{ order_no: string; run_id: string }>;
    const requested = selectedOrderNos
      ? new Set(selectedOrderNos.map((value) => value.trim()).filter(Boolean))
      : undefined;
    const candidates = requested
      ? rows.filter((row) => requested.has(row.order_no))
      : rows;
    if (requested && candidates.length !== requested.size) {
      throw new Error("선택한 발주 중 기존 실행에 배정되지 않은 발주가 있습니다.");
    }
    if (candidates.length === 0) throw new Error("실행할 신규 발주가 없습니다.");
    const ownerRunIds = [...new Set(candidates.map((row) => row.run_id))];
    if (ownerRunIds.length !== 1) {
      throw new Error("선택한 발주가 이미 여러 실행에 배정되어 하나의 실행으로 연결할 수 없습니다.");
    }
    return ownerRunIds[0];
  }

  getRun(runId: string): FulfillmentRun {
    const row = this.db
      .prepare("SELECT * FROM fulfillment_runs WHERE id = ?")
      .get(runId) as RunRow | undefined;
    if (!row) throw new Error(`실행 ${runId}을 찾을 수 없습니다.`);

    const orderRows = this.db
      .prepare(
        `SELECT o.payload_json FROM fulfillment_run_orders ro
         JOIN fulfillment_orders o ON o.order_no = ro.order_no
         WHERE ro.run_id = ? ORDER BY ro.order_no`,
      )
      .all(runId) as Array<{ payload_json: string }>;
    const orders = orderRows.map((item) => {
      const order = parseJson<FulfillmentOrder>(item.payload_json);
      order.items = this.getOrderItems(order.orderNo);
      return order;
    });

    return {
      id: row.id,
      scanId: row.scan_id,
      workflowVersion: (row.workflow_version ?? 1) as FulfillmentWorkflowVersion,
      status: row.status,
      currentStage: row.current_stage as FulfillmentRun["currentStage"],
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastError: row.last_error ?? undefined,
      logenIntegrationMethod: row.logen_integration_method ?? undefined,
      orders,
      shippingJobs: this.getShippingJobs(runId),
      artifacts: this.getArtifacts(runId),
      stages: this.getStages(runId),
      logenBatches: this.getLogenBatches(runId),
      cartons: this.getLogenBatches(runId).flatMap((batch) =>
        this.getFulfillmentCartons(batch.id),
      ),
      shipmentGroups: this.getShipmentGroups(runId),
      coupangUploadJobs: this.getCoupangUploadJobs(runId),
      orderConfirmationJobs: this.getOrderConfirmationJobs(runId),
    };
  }

  ensureOrderConfirmationJobs(
    runId: string,
    orders: FulfillmentOrder[],
    at = new Date().toISOString(),
  ): OrderConfirmationJob[] {
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO order_confirmation_jobs
       (run_id, order_no, source_status, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    this.transaction(() => {
      for (const order of uniqueOrders(orders)) {
        insert.run(
          runId,
          order.orderNo,
          order.status,
          order.status === "발주확정" ? "confirmed" : "pending",
          at,
          at,
        );
      }
    });
    return this.getOrderConfirmationJobs(runId);
  }

  getOrderConfirmationJobs(runId: string): OrderConfirmationJob[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM order_confirmation_jobs
         WHERE run_id = ? ORDER BY order_no`,
      )
      .all(runId) as Array<Record<string, unknown>>;
    return rows.map(rowToOrderConfirmationJob);
  }

  updateOrderConfirmationJob(input: {
    runId: string;
    orderNo: string;
    status: OrderConfirmationStatus;
    templateFileName?: string;
    templateFilePath?: string;
    preparedFileName?: string;
    preparedFilePath?: string;
    message?: string;
    updatedAt?: string;
  }): OrderConfirmationJob {
    const current = this.db
      .prepare(
        `SELECT * FROM order_confirmation_jobs
         WHERE run_id = ? AND order_no = ?`,
      )
      .get(input.runId, input.orderNo) as Record<string, unknown> | undefined;
    if (!current) {
      throw new Error(`발주확정 작업 ${input.runId}/${input.orderNo}를 찾을 수 없습니다.`);
    }
    const job = rowToOrderConfirmationJob(current);
    this.db
      .prepare(
        `UPDATE order_confirmation_jobs SET
           status = ?, template_file_name = ?, template_file_path = ?,
           prepared_file_name = ?, prepared_file_path = ?, message = ?, updated_at = ?
         WHERE run_id = ? AND order_no = ?`,
      )
      .run(
        input.status,
        input.templateFileName ?? job.templateFileName ?? null,
        input.templateFilePath ?? job.templateFilePath ?? null,
        input.preparedFileName ?? job.preparedFileName ?? null,
        input.preparedFilePath ?? job.preparedFilePath ?? null,
        input.message ?? job.message ?? null,
        input.updatedAt ?? new Date().toISOString(),
        input.runId,
        input.orderNo,
      );
    return this.getOrderConfirmationJobs(input.runId).find(
      (item) => item.orderNo === input.orderNo,
    )!;
  }

  /** Runs that may safely continue from their last durable stage. */
  getAutomaticResumeRunIds(): string[] {
    const rows = this.db
      .prepare(
        `SELECT r.id, r.created_at
         FROM fulfillment_runs r
         WHERE r.workflow_version = 3
           AND r.status IN ('created', 'running', 'partial', 'blocked')
         ORDER BY r.created_at, r.id`,
      )
      .all() as Array<{ id: string }>;
    return rows.map((row) => row.id);
  }

  replaceOrderItems(orderNo: string, items: FulfillmentOrderItem[]): void {
    this.transaction(() => {
      this.db.prepare("DELETE FROM fulfillment_order_items WHERE order_no = ?").run(orderNo);
      const insert = this.db.prepare(
        "INSERT INTO fulfillment_order_items (order_no, sku_code, payload_json) VALUES (?, ?, ?)",
      );
      for (const item of items) insert.run(orderNo, item.skuCode, JSON.stringify(item));
    });
  }

  saveStageResult(input: {
    runId: string;
    stage: FulfillmentStage;
    status: FulfillmentStageStatus;
    message: string;
    items?: unknown[];
    updatedAt?: string;
  }): StageRecord {
    const updatedAt = input.updatedAt ?? new Date().toISOString();
    const runRow = this.db
      .prepare("SELECT workflow_version FROM fulfillment_runs WHERE id = ?")
      .get(input.runId) as { workflow_version: number } | undefined;
    if (!runRow) throw new Error(`Fulfillment 실행을 찾을 수 없습니다: ${input.runId}`);
    const runStatus = stageStatusToRunStatus(
      input.status,
      input.stage,
      runRow.workflow_version as FulfillmentWorkflowVersion,
    );
    this.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO fulfillment_stage_results
           (run_id, stage, status, message, items_json, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(run_id, stage) DO UPDATE SET
             status = excluded.status, message = excluded.message,
             items_json = excluded.items_json, updated_at = excluded.updated_at`,
        )
        .run(
          input.runId,
          input.stage,
          input.status,
          input.message,
          JSON.stringify(input.items ?? []),
          updatedAt,
        );
      this.db
        .prepare(
          `UPDATE fulfillment_runs SET
             status = CASE WHEN current_stage > ? THEN status ELSE ? END,
             current_stage = CASE WHEN current_stage > ? THEN current_stage ELSE ? END,
             updated_at = ?,
             last_error = CASE WHEN current_stage > ? THEN last_error ELSE ? END
           WHERE id = ?`,
        )
        .run(
          input.stage,
          runStatus,
          input.stage,
          input.stage,
          updatedAt,
          input.stage,
          ["failed", "blocked", "unknown"].includes(input.status) ? input.message : null,
          input.runId,
        );
    });
    return {
      stage: input.stage,
      status: input.status,
      message: input.message,
      items: input.items ?? [],
      updatedAt,
    };
  }

  recordArtifact(artifact: Omit<FulfillmentArtifact, "id"> & { id?: string }): FulfillmentArtifact {
    const complete: FulfillmentArtifact = { ...artifact, id: artifact.id ?? randomUUID() };
    this.db
      .prepare(
        `INSERT INTO fulfillment_artifacts
         (id, run_id, type, status, order_no, shipping_job_id, file_name, file_path,
          printer_name, submitted_at, message)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET status = excluded.status, file_name = excluded.file_name,
          file_path = excluded.file_path, printer_name = excluded.printer_name,
          submitted_at = excluded.submitted_at, message = excluded.message`,
      )
      .run(
        complete.id,
        complete.runId,
        complete.type,
        complete.status,
        complete.orderNo ?? null,
        complete.shippingJobId ?? null,
        complete.fileName ?? null,
        complete.filePath ?? null,
        complete.printerName ?? null,
        complete.submittedAt ?? null,
        complete.message ?? null,
      );
    return complete;
  }

  getArtifacts(runId: string): FulfillmentArtifact[] {
    const rows = this.db
      .prepare("SELECT * FROM fulfillment_artifacts WHERE run_id = ? ORDER BY rowid")
      .all(runId) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.id),
      runId: String(row.run_id),
      type: row.type as FulfillmentArtifact["type"],
      status: row.status as FulfillmentArtifact["status"],
      orderNo: optionalString(row.order_no),
      shippingJobId: optionalString(row.shipping_job_id),
      fileName: optionalString(row.file_name),
      filePath: optionalString(row.file_path),
      printerName: optionalString(row.printer_name),
      submittedAt: optionalString(row.submitted_at),
      message: optionalString(row.message),
    }));
  }

  upsertProductMaster(master: ProductMaster): void {
    this.db
      .prepare(
        `INSERT INTO product_master (sku_code, sku_name, units_per_carton, source, updated_at)
         VALUES (?, ?, ?, ?, ?) ON CONFLICT(sku_code) DO UPDATE SET
          sku_name = excluded.sku_name, units_per_carton = excluded.units_per_carton,
          source = excluded.source, updated_at = excluded.updated_at`,
      )
      .run(master.skuCode, master.skuName, master.unitsPerCarton, master.source, master.updatedAt);
  }

  getProductMaster(skuCode: string): ProductMaster | undefined {
    const row = this.db.prepare("SELECT * FROM product_master WHERE sku_code = ?").get(skuCode) as
      | Record<string, unknown>
      | undefined;
    return row
      ? {
          skuCode: String(row.sku_code),
          skuName: String(row.sku_name),
          unitsPerCarton: Number(row.units_per_carton),
          source: row.source as ProductMaster["source"],
          updatedAt: String(row.updated_at),
        }
      : undefined;
  }

  upsertCenterMaster(master: CenterMaster): void {
    this.db
      .prepare(
        `INSERT INTO center_master
         (center_code, center_name, recipient_name, address, telephone, mobile, postal_code, source, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(center_code) DO UPDATE SET
          center_name = excluded.center_name, recipient_name = excluded.recipient_name,
          address = excluded.address, telephone = excluded.telephone, mobile = excluded.mobile,
          postal_code = excluded.postal_code, source = excluded.source, updated_at = excluded.updated_at`,
      )
      .run(
        master.centerCode,
        master.centerName,
        master.recipientName,
        master.address,
        master.telephone,
        master.mobile ?? null,
        master.postalCode ?? null,
        master.source,
        master.updatedAt,
      );
  }

  getCenterMaster(centerCode: string): CenterMaster | undefined {
    const row = this.db.prepare("SELECT * FROM center_master WHERE center_code = ?").get(centerCode) as
      | Record<string, unknown>
      | undefined;
    return row
      ? {
          centerCode: String(row.center_code),
          centerName: String(row.center_name),
          recipientName: String(row.recipient_name),
          address: String(row.address),
          telephone: String(row.telephone),
          mobile: optionalString(row.mobile),
          postalCode: optionalString(row.postal_code),
          source: row.source as CenterMaster["source"],
          updatedAt: String(row.updated_at),
        }
      : undefined;
  }

  saveOrderFileCenter(orderNo: string, center: CenterMaster): void {
    this.db
      .prepare(
        `INSERT INTO fulfillment_order_file_centers
         (order_no, center_code, center_name, recipient_name, address, telephone,
          mobile, postal_code, captured_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(order_no) DO UPDATE SET
          center_code = excluded.center_code, center_name = excluded.center_name,
          recipient_name = excluded.recipient_name, address = excluded.address,
          telephone = excluded.telephone, mobile = excluded.mobile,
          postal_code = excluded.postal_code, captured_at = excluded.captured_at`,
      )
      .run(
        orderNo,
        center.centerCode,
        center.centerName,
        center.recipientName,
        center.address,
        center.telephone,
        center.mobile ?? null,
        center.postalCode ?? null,
        center.updatedAt,
      );
  }

  getOrderFileCenter(orderNo: string): CenterMaster | undefined {
    const row = this.db
      .prepare("SELECT * FROM fulfillment_order_file_centers WHERE order_no = ?")
      .get(orderNo) as Record<string, unknown> | undefined;
    return row
      ? {
          centerCode: String(row.center_code),
          centerName: String(row.center_name),
          recipientName: String(row.recipient_name),
          address: String(row.address),
          telephone: String(row.telephone),
          mobile: optionalString(row.mobile),
          postalCode: optionalString(row.postal_code),
          source: "order_file",
          updatedAt: String(row.captured_at),
        }
      : undefined;
  }

  bindLogenIntegrationMethod(
    runId: string,
    method: LogenIntegrationMethod,
  ): LogenIntegrationMethod {
    const row = this.db
      .prepare("SELECT logen_integration_method FROM fulfillment_runs WHERE id = ?")
      .get(runId) as { logen_integration_method: LogenIntegrationMethod | null } | undefined;
    if (!row) throw new Error(`실행 ${runId}을 찾을 수 없습니다.`);
    if (row.logen_integration_method && row.logen_integration_method !== method) {
      throw new Error(
        `실행 ${runId}은 이미 로젠 ${displayLogenMethod(row.logen_integration_method)} 방식으로 고정되었습니다.`,
      );
    }
    if (!row.logen_integration_method) {
      this.db
        .prepare(
          "UPDATE fulfillment_runs SET logen_integration_method = ?, updated_at = ? WHERE id = ?",
        )
        .run(method, new Date().toISOString(), runId);
    }
    return method;
  }

  setSenderProfile(profile: SenderProfile): void {
    this.db
      .prepare(
        `INSERT INTO sender_profile
         (id, name, address, telephone, mobile, postal_code, customer_code, fare_type,
          box_type_code, delivery_fare, updated_at)
         VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, address = excluded.address,
          telephone = excluded.telephone, mobile = excluded.mobile, postal_code = excluded.postal_code,
          customer_code = excluded.customer_code, fare_type = excluded.fare_type,
          box_type_code = excluded.box_type_code, delivery_fare = excluded.delivery_fare,
          updated_at = excluded.updated_at`,
      )
      .run(
        profile.name,
        profile.address,
        profile.telephone,
        profile.mobile ?? null,
        profile.postalCode ?? null,
        profile.customerCode,
        profile.fareType,
        profile.boxTypeCode ?? null,
        profile.deliveryFare,
        profile.updatedAt,
      );
  }

  getSenderProfile(): SenderProfile | undefined {
    const row = this.db.prepare("SELECT * FROM sender_profile WHERE id = 1").get() as
      | Record<string, unknown>
      | undefined;
    return row
      ? {
          name: String(row.name),
          address: String(row.address),
          telephone: String(row.telephone),
          mobile: optionalString(row.mobile),
          postalCode: optionalString(row.postal_code),
          customerCode: String(row.customer_code),
          fareType: String(row.fare_type),
          boxTypeCode: optionalString(row.box_type_code),
          deliveryFare: Number(row.delivery_fare),
          updatedAt: String(row.updated_at),
        }
      : undefined;
  }

  saveShippingJobs(jobs: ShippingJob[]): void {
    this.transaction(() => {
      const statement = this.db.prepare(
        `INSERT INTO fulfillment_shipping_jobs
         (id, run_id, order_no, sku_code, sku_name, carton_index, shipped_quantity,
          units_per_carton, fix_take_no, status, error, slip_no, shipment_id,
          logen_registered_at, waybill_printed_at, tracking_registered_at, documents_printed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(run_id, order_no, sku_code, carton_index) DO UPDATE SET
          sku_name = excluded.sku_name, shipped_quantity = excluded.shipped_quantity,
          units_per_carton = excluded.units_per_carton, fix_take_no = excluded.fix_take_no,
          status = CASE
            WHEN fulfillment_shipping_jobs.status IN
              ('registered', 'waybill_printed', 'tracking_registered', 'documents_printed', 'unknown')
              AND excluded.status IN ('ready', 'blocked')
            THEN fulfillment_shipping_jobs.status
            ELSE excluded.status
          END,
          error = CASE
            WHEN fulfillment_shipping_jobs.status IN
              ('registered', 'waybill_printed', 'tracking_registered', 'documents_printed', 'unknown')
              AND excluded.status IN ('ready', 'blocked')
            THEN fulfillment_shipping_jobs.error
            ELSE excluded.error
          END,
          slip_no = COALESCE(excluded.slip_no, fulfillment_shipping_jobs.slip_no),
          shipment_id = COALESCE(excluded.shipment_id, fulfillment_shipping_jobs.shipment_id),
          logen_registered_at = COALESCE(excluded.logen_registered_at, fulfillment_shipping_jobs.logen_registered_at),
          waybill_printed_at = COALESCE(excluded.waybill_printed_at, fulfillment_shipping_jobs.waybill_printed_at),
          tracking_registered_at = COALESCE(excluded.tracking_registered_at, fulfillment_shipping_jobs.tracking_registered_at),
          documents_printed_at = COALESCE(excluded.documents_printed_at, fulfillment_shipping_jobs.documents_printed_at)`,
      );
      for (const job of jobs) {
        statement.run(
          job.id,
          job.runId,
          job.orderNo,
          job.skuCode,
          job.skuName,
          job.cartonIndex,
          job.shippedQuantity,
          job.unitsPerCarton,
          job.fixTakeNo,
          job.status,
          job.error ?? null,
          job.slipNo ?? null,
          job.shipmentId ?? null,
          job.logenRegisteredAt ?? null,
          job.waybillPrintedAt ?? null,
          job.trackingRegisteredAt ?? null,
          job.documentsPrintedAt ?? null,
        );
      }
    });
  }

  getShippingJobs(runId: string): ShippingJob[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM fulfillment_shipping_jobs WHERE run_id = ? ORDER BY order_no, sku_code, carton_index",
      )
      .all(runId) as Array<Record<string, unknown>>;
    return rows.map(rowToShippingJob);
  }

  updateShippingJob(jobId: string, patch: Partial<ShippingJob>): ShippingJob {
    const currentRow = this.db.prepare("SELECT * FROM fulfillment_shipping_jobs WHERE id = ?").get(jobId) as
      | Record<string, unknown>
      | undefined;
    if (!currentRow) throw new Error(`배송 작업 ${jobId}를 찾을 수 없습니다.`);
    const merged: ShippingJob = { ...rowToShippingJob(currentRow), ...patch, id: jobId };
    this.saveShippingJobs([merged]);
    if (
      Object.prototype.hasOwnProperty.call(patch, "slipNo") &&
      patch.slipNo === undefined
    ) {
      this.db
        .prepare("UPDATE fulfillment_shipping_jobs SET slip_no = NULL WHERE id = ?")
        .run(jobId);
    }
    const updatedRow = this.db
      .prepare("SELECT * FROM fulfillment_shipping_jobs WHERE id = ?")
      .get(jobId) as Record<string, unknown>;
    return rowToShippingJob(updatedRow);
  }

  saveLogenBatches(batches: LogenBatch[]): void {
    this.transaction(() => {
      const statement = this.db.prepare(
        `INSERT INTO logen_batches
         (id, run_id, order_no, sku_code, sku_name, ordered_quantity, units_per_carton,
          carton_count, fix_take_no, status, logen_order_no, registration_keys_json,
          registration_recorded_at, waybill_status, waybill_message,
          message, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(run_id, order_no, sku_code) DO UPDATE SET
          sku_name = CASE
            WHEN logen_batches.status IN
              ('registered', 'waybills_printed', 'completed', 'failed', 'unknown')
              AND excluded.status IN ('ready', 'blocked')
            THEN logen_batches.sku_name ELSE excluded.sku_name END,
          ordered_quantity = CASE
            WHEN logen_batches.status IN
              ('registered', 'waybills_printed', 'completed', 'failed', 'unknown')
              AND excluded.status IN ('ready', 'blocked')
            THEN logen_batches.ordered_quantity ELSE excluded.ordered_quantity END,
          units_per_carton = CASE
            WHEN logen_batches.status IN
              ('registered', 'waybills_printed', 'completed', 'failed', 'unknown')
              AND excluded.status IN ('ready', 'blocked')
            THEN logen_batches.units_per_carton ELSE excluded.units_per_carton END,
          carton_count = CASE
            WHEN logen_batches.status IN
              ('registered', 'waybills_printed', 'completed', 'failed', 'unknown')
              AND excluded.status IN ('ready', 'blocked')
            THEN logen_batches.carton_count ELSE excluded.carton_count END,
          fix_take_no = CASE
            WHEN logen_batches.status IN
              ('registered', 'waybills_printed', 'completed', 'failed', 'unknown')
              AND excluded.status IN ('ready', 'blocked')
            THEN logen_batches.fix_take_no ELSE excluded.fix_take_no END,
          status = CASE
            WHEN logen_batches.status IN
              ('registered', 'waybills_printed', 'completed', 'failed', 'unknown')
              AND excluded.status IN ('ready', 'blocked')
            THEN logen_batches.status
            ELSE excluded.status
          END,
          logen_order_no = COALESCE(excluded.logen_order_no, logen_batches.logen_order_no),
          registration_keys_json = COALESCE(
            excluded.registration_keys_json,
            logen_batches.registration_keys_json
          ),
          registration_recorded_at = COALESCE(
            excluded.registration_recorded_at,
            logen_batches.registration_recorded_at
          ),
          waybill_status = CASE
            WHEN logen_batches.status IN
              ('registered', 'waybills_printed', 'completed', 'failed', 'unknown')
              AND excluded.status IN ('ready', 'blocked')
            THEN logen_batches.waybill_status
            ELSE excluded.waybill_status
          END,
          waybill_message = CASE
            WHEN logen_batches.status IN
              ('registered', 'waybills_printed', 'completed', 'failed', 'unknown')
              AND excluded.status IN ('ready', 'blocked')
            THEN logen_batches.waybill_message
            ELSE excluded.waybill_message
          END,
          message = CASE
            WHEN logen_batches.status IN
              ('registered', 'waybills_printed', 'completed', 'failed', 'unknown')
              AND excluded.status IN ('ready', 'blocked')
            THEN logen_batches.message
            ELSE excluded.message
          END,
          updated_at = excluded.updated_at`,
      );
      for (const batch of batches) {
        assertPositiveInteger(batch.orderedQuantity, "주문수량");
        if (batch.status !== "blocked") {
          assertPositiveInteger(batch.unitsPerCarton, "입수수량");
          assertPositiveInteger(batch.cartonCount, "박스 수");
        } else if (batch.unitsPerCarton < 0 || batch.cartonCount < 0) {
          throw new Error("중단된 로젠 배치의 입수수량과 박스 수는 음수일 수 없습니다.");
        }
        statement.run(
          batch.id,
          batch.runId,
          batch.orderNo,
          batch.skuCode,
          batch.skuName,
          batch.orderedQuantity,
          batch.unitsPerCarton,
          batch.cartonCount,
          batch.fixTakeNo,
          batch.status,
          batch.logenOrderNo ?? null,
          batch.registrationKeys?.length
            ? JSON.stringify(batch.registrationKeys)
            : null,
          batch.registrationRecordedAt ?? null,
          batch.waybillStatus ?? "not_started",
          batch.waybillMessage ?? null,
          batch.message ?? null,
          batch.createdAt,
          batch.updatedAt,
        );
      }
    });
  }

  getLogenBatch(batchId: string): LogenBatch | undefined {
    const row = this.db.prepare("SELECT * FROM logen_batches WHERE id = ?").get(batchId) as
      | Record<string, unknown>
      | undefined;
    return row ? rowToLogenBatch(row) : undefined;
  }

  getLogenBatches(runId: string): LogenBatch[] {
    const rows = this.db
      .prepare("SELECT * FROM logen_batches WHERE run_id = ? ORDER BY order_no, sku_code")
      .all(runId) as Array<Record<string, unknown>>;
    return rows.map(rowToLogenBatch);
  }

  updateLogenBatch(batchId: string, patch: Partial<LogenBatch>): LogenBatch {
    const current = this.getLogenBatch(batchId);
    if (!current) throw new Error(`로젠 배치 ${batchId}를 찾을 수 없습니다.`);
    const merged: LogenBatch = { ...current, ...patch, id: batchId };
    this.saveLogenBatches([merged]);
    return this.getLogenBatch(batchId) ?? merged;
  }

  /**
   * Explicit recovery path for a failure that happened before Logen accepted
   * an order. Normal plan replay still cannot downgrade progressed batches.
   */
  resetLogenBatchBeforeSubmission(
    batchId: string,
    message: string,
    updatedAt: string,
  ): LogenBatch {
    const result = this.db
      .prepare(
        `UPDATE logen_batches
         SET status = 'ready', message = ?, waybill_status = 'not_started',
             waybill_message = NULL, updated_at = ?
         WHERE id = ?
           AND status IN ('blocked', 'failed')
           AND logen_order_no IS NULL
           AND registration_keys_json IS NULL`,
      )
      .run(message, updatedAt, batchId);
    if (result.changes !== 1) {
      throw new Error(
        `로젠 배치 ${batchId}는 제출 전 실패 상태가 아니어서 자동 재등록 대상으로 전환할 수 없습니다.`,
      );
    }
    return this.getLogenBatch(batchId)!;
  }

  saveFulfillmentCartons(cartons: FulfillmentCarton[]): void {
    this.transaction(() => {
      this.upsertFulfillmentCartons(cartons);
    });
  }

  /**
   * Replaces planner-owned carton rows while a batch is still mutable.
   * Once an external side effect advances a batch, its persisted batch/carton
   * snapshot wins over a newly calculated plan.
   */
  replacePlannedFulfillmentCartons(
    batches: LogenBatch[],
    cartons: FulfillmentCarton[],
  ): void {
    const batchByInputId = new Map(batches.map((batch) => [batch.id, batch]));
    for (const carton of cartons) {
      if (!batchByInputId.has(carton.batchId)) {
        throw new Error(`카톤의 로젠 배치 ${carton.batchId}가 교체 대상에 없습니다.`);
      }
    }

    this.transaction(() => {
      const findPersisted = this.db.prepare(
        `SELECT id, status FROM logen_batches
         WHERE run_id = ? AND order_no = ? AND sku_code = ?`,
      );
      const deleteCartons = this.db.prepare(
        "DELETE FROM fulfillment_cartons WHERE batch_id = ?",
      );
      const mutableBatchIds = new Set<string>();

      for (const batch of batches) {
        const persisted = findPersisted.get(
          batch.runId,
          batch.orderNo,
          batch.skuCode,
        ) as { id: string; status: LogenBatch["status"] } | undefined;
        if (!persisted) {
          throw new Error(`로젠 배치 ${batch.id}가 저장되지 않아 카톤 계획을 교체할 수 없습니다.`);
        }
        if (persisted.id !== batch.id) {
          throw new Error(
            `로젠 배치 식별자가 일치하지 않습니다: 입력 ${batch.id}, 저장 ${persisted.id}`,
          );
        }
        if (!["ready", "blocked"].includes(persisted.status)) continue;
        mutableBatchIds.add(persisted.id);
        deleteCartons.run(persisted.id);
      }

      this.upsertFulfillmentCartons(
        cartons.filter((carton) => mutableBatchIds.has(carton.batchId)),
      );
    });
  }

  getFulfillmentCartons(batchId: string): FulfillmentCarton[] {
    const rows = this.db
      .prepare("SELECT * FROM fulfillment_cartons WHERE batch_id = ? ORDER BY carton_index")
      .all(batchId) as Array<Record<string, unknown>>;
    return rows.map(rowToFulfillmentCarton);
  }

  updateFulfillmentCarton(
    batchId: string,
    cartonIndex: number,
    patch: Partial<FulfillmentCarton>,
  ): FulfillmentCarton {
    const currentRow = this.db
      .prepare("SELECT * FROM fulfillment_cartons WHERE batch_id = ? AND carton_index = ?")
      .get(batchId, cartonIndex) as Record<string, unknown> | undefined;
    if (!currentRow) throw new Error(`로젠 배치 ${batchId}의 ${cartonIndex}번 박스를 찾을 수 없습니다.`);
    const merged: FulfillmentCarton = {
      ...rowToFulfillmentCarton(currentRow),
      ...patch,
      batchId,
      cartonIndex,
    };
    this.saveFulfillmentCartons([merged]);
    return this.getFulfillmentCartons(batchId).find((item) => item.cartonIndex === cartonIndex) ?? merged;
  }

  private upsertFulfillmentCartons(cartons: FulfillmentCarton[]): void {
    const statement = this.db.prepare(
      `INSERT INTO fulfillment_cartons
       (batch_id, carton_index, quantity, original_slip_no, waybill_no, slip_no,
        status, message, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(batch_id, carton_index) DO UPDATE SET
        quantity = CASE
          WHEN fulfillment_cartons.status IN
            ('waybill_assigned', 'uploaded', 'completed', 'failed', 'unknown')
            AND excluded.status = 'ready'
          THEN fulfillment_cartons.quantity
          ELSE excluded.quantity
        END,
        original_slip_no = COALESCE(
          excluded.original_slip_no,
          fulfillment_cartons.original_slip_no
        ),
        waybill_no = COALESCE(excluded.waybill_no, fulfillment_cartons.waybill_no),
        slip_no = CASE
          WHEN fulfillment_cartons.status IN
            ('waybill_assigned', 'uploaded', 'completed')
            AND excluded.status = 'ready'
          THEN fulfillment_cartons.slip_no
          ELSE excluded.slip_no
        END,
        status = CASE
          WHEN fulfillment_cartons.status IN
            ('waybill_assigned', 'uploaded', 'completed', 'failed', 'unknown')
            AND excluded.status = 'ready'
          THEN fulfillment_cartons.status
          ELSE excluded.status
        END,
        message = CASE
          WHEN fulfillment_cartons.status IN
            ('waybill_assigned', 'uploaded', 'completed', 'failed', 'unknown')
            AND excluded.status = 'ready'
          THEN fulfillment_cartons.message
          ELSE excluded.message
        END,
        updated_at = excluded.updated_at`,
    );
    for (const carton of cartons) {
      assertPositiveInteger(carton.cartonIndex, "박스 순번");
      assertPositiveInteger(carton.quantity, "박스 수량");
      statement.run(
        carton.batchId,
        carton.cartonIndex,
        carton.quantity,
        carton.originalSlipNo ?? null,
        carton.waybillNo ?? null,
        carton.slipNo ?? null,
        carton.status,
        carton.message ?? null,
        carton.createdAt,
        carton.updatedAt,
      );
    }
  }

  saveShipmentGroups(groups: ShipmentGroup[]): void {
    this.transaction(() => {
      const statement = this.db.prepare(
        `INSERT INTO shipment_groups
         (id, run_id, order_no, center_code, expected_inbound_date, order_nos_json,
          shipment_id, status, message, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(run_id, order_no) DO UPDATE SET
          center_code = excluded.center_code,
          expected_inbound_date = excluded.expected_inbound_date,
          order_nos_json = excluded.order_nos_json,
          shipment_id = COALESCE(excluded.shipment_id, shipment_groups.shipment_id),
          status = CASE
            WHEN shipment_groups.status IN
              ('created', 'tracking_uploaded', 'documents_printed', 'completed', 'failed', 'unknown')
              AND excluded.status = 'ready'
            THEN shipment_groups.status
            ELSE excluded.status
          END,
          message = CASE
            WHEN shipment_groups.status IN
              ('created', 'tracking_uploaded', 'documents_printed', 'completed', 'failed', 'unknown')
              AND excluded.status = 'ready'
            THEN shipment_groups.message
            ELSE excluded.message
          END,
          updated_at = excluded.updated_at`,
      );
      for (const group of groups) {
        const orderNos = [...new Set(group.orderNos.map((value) => value.trim()).filter(Boolean))].sort();
        if (orderNos.length !== 1) {
          throw new Error("쉽먼트 그룹은 발주번호 한 건만 가져야 합니다.");
        }
        statement.run(
          group.id,
          group.runId,
          orderNos[0],
          group.centerCode,
          group.expectedInboundDate,
          JSON.stringify(orderNos),
          group.shipmentId ?? null,
          group.status,
          group.message ?? null,
          group.createdAt,
          group.updatedAt,
        );
      }
    });
  }

  getShipmentGroup(groupId: string): ShipmentGroup | undefined {
    const row = this.db.prepare("SELECT * FROM shipment_groups WHERE id = ?").get(groupId) as
      | Record<string, unknown>
      | undefined;
    return row ? rowToShipmentGroup(row) : undefined;
  }

  getShipmentGroups(runId: string): ShipmentGroup[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM shipment_groups WHERE run_id = ? ORDER BY order_no, center_code, expected_inbound_date",
      )
      .all(runId) as Array<Record<string, unknown>>;
    return rows.map(rowToShipmentGroup);
  }

  updateShipmentGroup(groupId: string, patch: Partial<ShipmentGroup>): ShipmentGroup {
    const current = this.getShipmentGroup(groupId);
    if (!current) throw new Error(`쉽먼트 그룹 ${groupId}를 찾을 수 없습니다.`);
    const merged: ShipmentGroup = { ...current, ...patch, id: groupId };
    this.saveShipmentGroups([merged]);
    return this.getShipmentGroup(groupId) ?? merged;
  }

  saveCoupangUploadJobs(jobs: CoupangUploadJob[]): void {
    this.transaction(() => {
      const existingStatus = this.db.prepare(
        "SELECT status FROM coupang_upload_jobs WHERE id = ?",
      );
      const statement = this.db.prepare(
        `INSERT INTO coupang_upload_jobs
         (id, run_id, shipment_group_id, file_name, file_path, ship_date, ship_time,
          upload_number, status, message, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
          shipment_group_id = CASE
            WHEN coupang_upload_jobs.status = 'confirmed' AND excluded.status <> 'confirmed'
            THEN coupang_upload_jobs.shipment_group_id
            ELSE excluded.shipment_group_id
          END,
          file_name = CASE
            WHEN coupang_upload_jobs.status = 'confirmed' AND excluded.status <> 'confirmed'
            THEN coupang_upload_jobs.file_name
            ELSE excluded.file_name
          END,
          file_path = CASE
            WHEN coupang_upload_jobs.status = 'confirmed' AND excluded.status <> 'confirmed'
            THEN coupang_upload_jobs.file_path
            ELSE excluded.file_path
          END,
          ship_date = CASE
            WHEN coupang_upload_jobs.status = 'confirmed' AND excluded.status <> 'confirmed'
            THEN coupang_upload_jobs.ship_date
            ELSE excluded.ship_date
          END,
          ship_time = CASE
            WHEN coupang_upload_jobs.status = 'confirmed' AND excluded.status <> 'confirmed'
            THEN coupang_upload_jobs.ship_time
            ELSE excluded.ship_time
          END,
         upload_number = COALESCE(excluded.upload_number, coupang_upload_jobs.upload_number),
          status = CASE
            WHEN coupang_upload_jobs.status = 'confirmed' AND excluded.status <> 'confirmed'
            THEN coupang_upload_jobs.status
            ELSE excluded.status
          END,
          message = CASE
            WHEN coupang_upload_jobs.status = 'confirmed' AND excluded.status <> 'confirmed'
            THEN coupang_upload_jobs.message
            ELSE excluded.message
          END,
          updated_at = excluded.updated_at`,
      );
      const deleteGroups = this.db.prepare(
        "DELETE FROM coupang_upload_job_groups WHERE upload_job_id = ?",
      );
      const insertGroup = this.db.prepare(
        `INSERT INTO coupang_upload_job_groups (upload_job_id, shipment_group_id)
         VALUES (?, ?)`,
      );
      for (const job of jobs) {
        const previous = existingStatus.get(job.id) as { status: string } | undefined;
        statement.run(
          job.id,
          job.runId,
          job.shipmentGroupId ?? null,
          job.fileName,
          job.filePath,
          job.shipDate,
          job.shipTime,
          job.uploadNumber ?? null,
          job.status,
          job.message ?? null,
          job.createdAt,
          job.updatedAt,
        );
        const preserveConfirmedGroups =
          previous?.status === "confirmed" && job.status !== "confirmed";
        if (job.shipmentGroupIds !== undefined && !preserveConfirmedGroups) {
          const groupIds = [
            ...new Set(job.shipmentGroupIds.map((value) => value.trim()).filter(Boolean)),
          ].sort();
          deleteGroups.run(job.id);
          for (const groupId of groupIds) insertGroup.run(job.id, groupId);
        }
      }
    });
  }

  getCoupangUploadJob(jobId: string): CoupangUploadJob | undefined {
    const row = this.db.prepare("SELECT * FROM coupang_upload_jobs WHERE id = ?").get(jobId) as
      | Record<string, unknown>
      | undefined;
    return row ? this.withUploadJobGroups(rowToCoupangUploadJob(row)) : undefined;
  }

  getCoupangUploadJobs(runId: string): CoupangUploadJob[] {
    const rows = this.db
      .prepare("SELECT * FROM coupang_upload_jobs WHERE run_id = ? ORDER BY created_at, id")
      .all(runId) as Array<Record<string, unknown>>;
    return rows.map((row) => this.withUploadJobGroups(rowToCoupangUploadJob(row)));
  }

  updateCoupangUploadJob(jobId: string, patch: Partial<CoupangUploadJob>): CoupangUploadJob {
    const current = this.getCoupangUploadJob(jobId);
    if (!current) throw new Error(`쿠팡 업로드 작업 ${jobId}를 찾을 수 없습니다.`);
    const merged: CoupangUploadJob = { ...current, ...patch, id: jobId };
    this.saveCoupangUploadJobs([merged]);
    return this.getCoupangUploadJob(jobId) ?? merged;
  }

  private withUploadJobGroups(job: CoupangUploadJob): CoupangUploadJob {
    const rows = this.db
      .prepare(
        `SELECT shipment_group_id FROM coupang_upload_job_groups
         WHERE upload_job_id = ? ORDER BY shipment_group_id`,
      )
      .all(job.id) as Array<{ shipment_group_id: string }>;
    const shipmentGroupIds = rows.map((row) => row.shipment_group_id);
    if (shipmentGroupIds.length > 0) return { ...job, shipmentGroupIds };
    return job.shipmentGroupId ? { ...job, shipmentGroupIds: [job.shipmentGroupId] } : job;
  }

  private getOrderItems(orderNo: string): FulfillmentOrderItem[] {
    const rows = this.db
      .prepare("SELECT payload_json FROM fulfillment_order_items WHERE order_no = ? ORDER BY sku_code")
      .all(orderNo) as Array<{ payload_json: string }>;
    return rows.map((row) => parseJson<FulfillmentOrderItem>(row.payload_json));
  }

  private getStages(runId: string): StageRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM fulfillment_stage_results WHERE run_id = ? ORDER BY stage")
      .all(runId) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      stage: Number(row.stage) as FulfillmentStage,
      status: row.status as FulfillmentStageStatus,
      message: String(row.message),
      items: parseJson<unknown[]>(String(row.items_json)),
      updatedAt: String(row.updated_at),
    }));
  }

  private transaction<T>(operation: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

}

function uniqueOrders(orders: FulfillmentOrder[]): FulfillmentOrder[] {
  const result = new Map<string, FulfillmentOrder>();
  for (const order of orders) result.set(order.orderNo, structuredClone(order));
  return [...result.values()];
}

function stageStatusToRunStatus(
  status: FulfillmentStageStatus,
  stage: FulfillmentStage,
  workflowVersion: FulfillmentWorkflowVersion,
): FulfillmentRunStatus {
  const finalStage = workflowVersion >= 3 ? 16 : 14;
  if (status === "completed") return stage === finalStage ? "completed" : "running";
  if (status === "partial") return "partial";
  if (status === "blocked") return "blocked";
  return "failed";
}

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

function optionalString(value: unknown): string | undefined {
  return value === null || value === undefined ? undefined : String(value);
}

function optionalStringArray(value: unknown): string[] | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  try {
    const parsed = parseJson<unknown>(value);
    if (!Array.isArray(parsed)) return undefined;
    const values = parsed
      .map((item) => String(item ?? "").trim())
      .filter(Boolean);
    return values.length > 0 ? values : undefined;
  } catch {
    return undefined;
  }
}

function rowToShippingJob(row: Record<string, unknown>): ShippingJob {
  return {
    id: String(row.id),
    runId: String(row.run_id),
    orderNo: String(row.order_no),
    skuCode: String(row.sku_code),
    skuName: String(row.sku_name),
    cartonIndex: Number(row.carton_index),
    shippedQuantity: Number(row.shipped_quantity),
    unitsPerCarton: Number(row.units_per_carton),
    fixTakeNo: String(row.fix_take_no),
    status: row.status as ShippingJob["status"],
    error: optionalString(row.error),
    slipNo: optionalString(row.slip_no),
    shipmentId: optionalString(row.shipment_id),
    logenRegisteredAt: optionalString(row.logen_registered_at),
    waybillPrintedAt: optionalString(row.waybill_printed_at),
    trackingRegisteredAt: optionalString(row.tracking_registered_at),
    documentsPrintedAt: optionalString(row.documents_printed_at),
  };
}

function rowToLogenBatch(row: Record<string, unknown>): LogenBatch {
  const logenOrderNo = optionalString(row.logen_order_no);
  const registrationKeys =
    optionalStringArray(row.registration_keys_json) ??
    (logenOrderNo ? [logenOrderNo] : undefined);
  return {
    id: String(row.id),
    runId: String(row.run_id),
    orderNo: String(row.order_no),
    skuCode: String(row.sku_code),
    skuName: String(row.sku_name),
    orderedQuantity: Number(row.ordered_quantity),
    unitsPerCarton: Number(row.units_per_carton),
    cartonCount: Number(row.carton_count),
    fixTakeNo: String(row.fix_take_no),
    status: row.status as LogenBatch["status"],
    logenOrderNo,
    registrationKeys,
    registrationRecordedAt: optionalString(row.registration_recorded_at),
    waybillStatus:
      (optionalString(row.waybill_status) as LogenBatch["waybillStatus"]) ??
      "not_started",
    waybillMessage: optionalString(row.waybill_message),
    message: optionalString(row.message),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function rowToFulfillmentCarton(row: Record<string, unknown>): FulfillmentCarton {
  return {
    batchId: String(row.batch_id),
    cartonIndex: Number(row.carton_index),
    quantity: Number(row.quantity),
    originalSlipNo: optionalString(row.original_slip_no),
    waybillNo: optionalString(row.waybill_no),
    slipNo: optionalString(row.slip_no),
    status: row.status as FulfillmentCarton["status"],
    message: optionalString(row.message),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function rowToShipmentGroup(row: Record<string, unknown>): ShipmentGroup {
  return {
    id: String(row.id),
    runId: String(row.run_id),
    centerCode: String(row.center_code),
    expectedInboundDate: String(row.expected_inbound_date),
    orderNos: parseJson<string[]>(String(row.order_nos_json)),
    shipmentId: optionalString(row.shipment_id),
    status: row.status as ShipmentGroup["status"],
    message: optionalString(row.message),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function rowToCoupangUploadJob(row: Record<string, unknown>): CoupangUploadJob {
  return {
    id: String(row.id),
    runId: String(row.run_id),
    shipmentGroupId: optionalString(row.shipment_group_id),
    fileName: String(row.file_name),
    filePath: String(row.file_path),
    shipDate: String(row.ship_date),
    shipTime: String(row.ship_time),
    uploadNumber: optionalString(row.upload_number),
    status: row.status as CoupangUploadJob["status"],
    message: optionalString(row.message),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function rowToOrderConfirmationJob(row: Record<string, unknown>): OrderConfirmationJob {
  return {
    runId: String(row.run_id),
    orderNo: String(row.order_no),
    sourceStatus: String(row.source_status),
    status: row.status as OrderConfirmationStatus,
    templateFileName: optionalString(row.template_file_name),
    templateFilePath: optionalString(row.template_file_path),
    preparedFileName: optionalString(row.prepared_file_name),
    preparedFilePath: optionalString(row.prepared_file_path),
    message: optionalString(row.message),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function classificationMessage(
  order: FulfillmentOrder,
  disposition: ClassifiedFulfillmentOrder["disposition"],
  firstSeen: boolean,
  unprocessed: boolean,
): string {
  if (disposition === "already_assigned") {
    return "이미 다른 실행에 배정되어 중복 처리에서 제외했습니다.";
  }
  if (disposition === "needs_confirmation") {
    return firstSeen
      ? "신규 거래처확인요청 발주로, 확정 절차가 필요합니다."
      : "이전 스캔에서도 발견됐지만 실행되지 않은 발주를 다시 표시했습니다.";
  }
  if (disposition === "already_confirmed") {
    return firstSeen
      ? "신규 발주확정 건으로, 확정 절차 없이 후속 처리를 진행할 수 있습니다."
      : "미처리 발주확정 건을 다시 표시했습니다.";
  }
  return unprocessed
    ? `현재 상태(${order.status || "알 수 없음"})는 자동 처리 대상이 아닙니다.`
    : "이미 처리 중인 발주입니다.";
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${label}은 1 이상의 정수여야 합니다.`);
  }
}

function displayLogenMethod(method: LogenIntegrationMethod): string {
  return method === "api" ? "API" : "웹사이트 MCP";
}
