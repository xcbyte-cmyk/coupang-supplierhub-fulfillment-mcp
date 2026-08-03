import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { FulfillmentStore } from "../src/fulfillment-store.js";

describe("FulfillmentStore migration", () => {
  it("preserves v2 batches and cartons while allowing blocked zero-carton records", () => {
    const directory = mkdtempSync(join(tmpdir(), "fulfillment-store-v2-"));
    const databasePath = join(directory, "fulfillment.db");
    try {
      const legacy = new DatabaseSync(databasePath);
      legacy.exec(`
        PRAGMA foreign_keys = ON;
        CREATE TABLE scans (
          id TEXT PRIMARY KEY, look_ahead_days INTEGER NOT NULL, created_at TEXT NOT NULL
        );
        CREATE TABLE fulfillment_runs (
          id TEXT PRIMARY KEY, scan_id TEXT NOT NULL REFERENCES scans(id),
          selection_key TEXT NOT NULL, status TEXT NOT NULL, current_stage INTEGER NOT NULL,
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_error TEXT,
          UNIQUE (scan_id, selection_key)
        );
        CREATE TABLE logen_batches (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL REFERENCES fulfillment_runs(id) ON DELETE CASCADE,
          order_no TEXT NOT NULL, sku_code TEXT NOT NULL, sku_name TEXT NOT NULL,
          ordered_quantity INTEGER NOT NULL CHECK (ordered_quantity > 0),
          units_per_carton INTEGER NOT NULL CHECK (units_per_carton > 0),
          carton_count INTEGER NOT NULL CHECK (carton_count > 0),
          fix_take_no TEXT NOT NULL UNIQUE, status TEXT NOT NULL,
          logen_order_no TEXT, message TEXT, created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL, UNIQUE (run_id, order_no, sku_code)
        );
        CREATE TABLE fulfillment_cartons (
          batch_id TEXT NOT NULL REFERENCES logen_batches(id) ON DELETE CASCADE,
          carton_index INTEGER NOT NULL CHECK (carton_index > 0),
          quantity INTEGER NOT NULL CHECK (quantity > 0), slip_no TEXT UNIQUE,
          status TEXT NOT NULL, message TEXT, created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL, PRIMARY KEY (batch_id, carton_index)
        );
        INSERT INTO scans VALUES ('SCAN', 7, '2026-07-30T00:00:00.000Z');
        INSERT INTO fulfillment_runs
          (id, scan_id, selection_key, status, current_stage, created_at, updated_at)
        VALUES ('RUN', 'SCAN', '["PO-1"]', 'running', 8,
                '2026-07-30T00:00:00.000Z', '2026-07-30T00:00:00.000Z');
        INSERT INTO logen_batches VALUES
          ('BATCH-1', 'RUN', 'PO-1', 'SKU-1', '상품', 20, 10, 2,
           'PO-1-SKU-1-hash', 'registered', 'LOGEN-1', NULL,
           '2026-07-30T00:00:00.000Z', '2026-07-30T00:00:00.000Z');
        INSERT INTO fulfillment_cartons VALUES
          ('BATCH-1', 1, 10, '11111111111', 'waybill_assigned', NULL,
           '2026-07-30T00:00:00.000Z', '2026-07-30T00:00:00.000Z');
        PRAGMA user_version = 2;
      `);
      legacy.close();

      const store = new FulfillmentStore(databasePath);
      expect(store.getLogenBatches("RUN")).toMatchObject([
        {
          id: "BATCH-1",
          status: "registered",
          cartonCount: 2,
          registrationKeys: ["LOGEN-1"],
          waybillStatus: "not_started",
        },
      ]);
      expect(store.getFulfillmentCartons("BATCH-1")).toMatchObject([
        { cartonIndex: 1, slipNo: "11111111111", status: "waybill_assigned" },
      ]);
      expect(() =>
        store.saveLogenBatches([
          {
            id: "BATCH-BLOCKED",
            runId: "RUN",
            orderNo: "PO-2",
            skuCode: "SKU-2",
            skuName: "입수량 누락 상품",
            orderedQuantity: 5,
            unitsPerCarton: 0,
            cartonCount: 0,
            fixTakeNo: "PO-2-SKU-2-hash",
            status: "blocked",
            message: "입수수량이 없습니다.",
            createdAt: "2026-07-30T00:00:00.000Z",
            updatedAt: "2026-07-30T00:00:00.000Z",
          },
        ]),
      ).not.toThrow();
      store.close();

      const migrated = new DatabaseSync(databasePath);
      const version = migrated.prepare("PRAGMA user_version").get() as {
        user_version: number;
      };
      const foreignKeyFailures = migrated.prepare("PRAGMA foreign_key_check").all();
      const schema = migrated
        .prepare("SELECT sql FROM sqlite_master WHERE name = 'logen_batches'")
        .get() as { sql: string };
      expect(version.user_version).toBe(10);
      expect(foreignKeyFailures).toEqual([]);
      expect(schema.sql).toContain("units_per_carton >= 0");
      expect(
        migrated.prepare("SELECT COUNT(*) AS count FROM logen_batches").get(),
      ).toMatchObject({ count: 2 });
      migrated.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("moves only unfinished v2 runs to the safe v3 stage layout", () => {
    const directory = mkdtempSync(join(tmpdir(), "fulfillment-store-v3-runs-"));
    const databasePath = join(directory, "fulfillment.db");
    try {
      const legacy = new DatabaseSync(databasePath);
      legacy.exec(`
        CREATE TABLE scans (
          id TEXT PRIMARY KEY, look_ahead_days INTEGER NOT NULL, created_at TEXT NOT NULL
        );
        CREATE TABLE fulfillment_runs (
          id TEXT PRIMARY KEY, scan_id TEXT NOT NULL REFERENCES scans(id),
          selection_key TEXT NOT NULL, workflow_version INTEGER NOT NULL,
          status TEXT NOT NULL, current_stage INTEGER NOT NULL,
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_error TEXT,
          logen_integration_method TEXT, UNIQUE (scan_id, selection_key)
        );
        CREATE TABLE fulfillment_stage_results (
          run_id TEXT NOT NULL REFERENCES fulfillment_runs(id) ON DELETE CASCADE,
          stage INTEGER NOT NULL, status TEXT NOT NULL, message TEXT NOT NULL,
          items_json TEXT NOT NULL, updated_at TEXT NOT NULL,
          PRIMARY KEY (run_id, stage)
        );
        INSERT INTO scans VALUES ('SCAN', 7, '2026-08-01T00:00:00.000Z');
        INSERT INTO fulfillment_runs VALUES
          ('RUN-BLOCKED', 'SCAN', '["PO-B"]', 2, 'blocked', 11,
           '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z', 'login', 'website_mcp');
        INSERT INTO fulfillment_runs VALUES
          ('RUN-PROGRESS', 'SCAN', '["PO-P"]', 2, 'failed', 12,
           '2026-08-01T01:00:00.000Z', '2026-08-01T01:00:00.000Z', 'unknown', 'website_mcp');
        INSERT INTO fulfillment_runs VALUES
          ('RUN-DONE', 'SCAN', '["PO-D"]', 2, 'completed', 14,
           '2026-08-01T02:00:00.000Z', '2026-08-01T02:00:00.000Z', NULL, 'website_mcp');
        INSERT INTO fulfillment_stage_results VALUES
          ('RUN-BLOCKED', 11, 'blocked', 'login blocked', '[]', '2026-08-01T00:00:00.000Z');
        INSERT INTO fulfillment_stage_results VALUES
          ('RUN-PROGRESS', 11, 'completed', 'registered', '[]', '2026-08-01T01:00:00.000Z');
        INSERT INTO fulfillment_stage_results VALUES
          ('RUN-PROGRESS', 12, 'unknown', 'print unknown', '[]', '2026-08-01T01:00:01.000Z');
        INSERT INTO fulfillment_stage_results VALUES
          ('RUN-DONE', 14, 'completed', 'done', '[]', '2026-08-01T02:00:00.000Z');
      `);
      legacy.close();

      const store = new FulfillmentStore(databasePath);
      expect(store.getRun("RUN-BLOCKED")).toMatchObject({
        workflowVersion: 3,
        currentStage: 10,
        status: "running",
      });
      expect(store.getRun("RUN-BLOCKED").stages.map((stage) => stage.stage)).toEqual([13]);
      expect(store.getRun("RUN-PROGRESS")).toMatchObject({
        workflowVersion: 3,
        currentStage: 14,
      });
      expect(store.getRun("RUN-PROGRESS").stages.map((stage) => [stage.stage, stage.status])).toEqual([
        [11, "completed"],
        [12, "completed"],
        [13, "completed"],
        [14, "unknown"],
      ]);
      expect(store.getRun("RUN-DONE")).toMatchObject({
        workflowVersion: 2,
        currentStage: 14,
        status: "completed",
      });
      store.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("splits legacy multi-PO shipment groups and preserves confirmed upload scope", () => {
    const directory = mkdtempSync(join(tmpdir(), "fulfillment-store-v4-groups-"));
    const databasePath = join(directory, "fulfillment.db");
    try {
      const legacy = new DatabaseSync(databasePath);
      legacy.exec(`
        PRAGMA foreign_keys = ON;
        CREATE TABLE scans (
          id TEXT PRIMARY KEY, look_ahead_days INTEGER NOT NULL, created_at TEXT NOT NULL
        );
        CREATE TABLE fulfillment_runs (
          id TEXT PRIMARY KEY, scan_id TEXT NOT NULL REFERENCES scans(id),
          selection_key TEXT NOT NULL, status TEXT NOT NULL, current_stage INTEGER NOT NULL,
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_error TEXT,
          UNIQUE (scan_id, selection_key)
        );
        CREATE TABLE shipment_groups (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL REFERENCES fulfillment_runs(id) ON DELETE CASCADE,
          center_code TEXT NOT NULL, expected_inbound_date TEXT NOT NULL,
          order_nos_json TEXT NOT NULL, shipment_id TEXT, status TEXT NOT NULL,
          message TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
          UNIQUE (run_id, center_code, expected_inbound_date)
        );
        CREATE TABLE coupang_upload_jobs (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL REFERENCES fulfillment_runs(id) ON DELETE CASCADE,
          shipment_group_id TEXT REFERENCES shipment_groups(id) ON DELETE SET NULL,
          file_name TEXT NOT NULL, file_path TEXT NOT NULL, ship_date TEXT NOT NULL,
          ship_time TEXT NOT NULL, upload_number TEXT, status TEXT NOT NULL,
          message TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
          UNIQUE (run_id, file_path, ship_date, ship_time)
        );
        CREATE TABLE coupang_upload_job_groups (
          upload_job_id TEXT NOT NULL REFERENCES coupang_upload_jobs(id) ON DELETE CASCADE,
          shipment_group_id TEXT NOT NULL REFERENCES shipment_groups(id) ON DELETE CASCADE,
          PRIMARY KEY (upload_job_id, shipment_group_id)
        );
        INSERT INTO scans VALUES ('SCAN', 7, '2026-07-30T00:00:00.000Z');
        INSERT INTO fulfillment_runs
          (id, scan_id, selection_key, status, current_stage, created_at, updated_at)
        VALUES ('RUN', 'SCAN', '["PO-A","PO-B"]', 'partial', 10,
                '2026-07-30T00:00:00.000Z', '2026-07-30T00:00:00.000Z');
        INSERT INTO shipment_groups VALUES
          ('GROUP-OLD', 'RUN', 'FC-A', '2026-08-01', '["PO-A","PO-B"]', NULL,
           'created', 'legacy', '2026-07-30T00:00:00.000Z', '2026-07-30T00:00:00.000Z');
        INSERT INTO coupang_upload_jobs VALUES
          ('UPLOAD', 'RUN', 'GROUP-OLD', 'upload.xlsx', 'C:/upload.xlsx',
           '2026-07-30', '16:00', 'UP-1', 'confirmed', 'confirmed',
           '2026-07-30T00:00:00.000Z', '2026-07-30T00:00:00.000Z');
        INSERT INTO coupang_upload_job_groups VALUES ('UPLOAD', 'GROUP-OLD');
        PRAGMA user_version = 4;
      `);
      legacy.close();

      const store = new FulfillmentStore(databasePath);
      expect(store.getShipmentGroups("RUN").map((group) => group.orderNos)).toEqual([
        ["PO-A"],
        ["PO-B"],
      ]);
      expect(store.getCoupangUploadJob("UPLOAD")).toMatchObject({
        status: "confirmed",
        shipmentGroupIds: ["GROUP-OLD", "GROUP-OLD-po-1"],
      });
      store.close();

      const migrated = new DatabaseSync(databasePath);
      expect(migrated.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      migrated.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("quarantines duplicate legacy run ownership before adding the unique claim index", () => {
    const directory = mkdtempSync(join(tmpdir(), "fulfillment-store-duplicate-runs-"));
    const databasePath = join(directory, "fulfillment.db");
    try {
      const legacy = new DatabaseSync(databasePath);
      legacy.exec(`
        PRAGMA foreign_keys = ON;
        CREATE TABLE scans (
          id TEXT PRIMARY KEY, look_ahead_days INTEGER NOT NULL, created_at TEXT NOT NULL
        );
        CREATE TABLE fulfillment_orders (
          order_no TEXT PRIMARY KEY, payload_json TEXT NOT NULL,
          first_seen_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE TABLE fulfillment_runs (
          id TEXT PRIMARY KEY, scan_id TEXT NOT NULL REFERENCES scans(id),
          selection_key TEXT NOT NULL, status TEXT NOT NULL, current_stage INTEGER NOT NULL,
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_error TEXT,
          UNIQUE (scan_id, selection_key)
        );
        CREATE TABLE fulfillment_run_orders (
          run_id TEXT NOT NULL REFERENCES fulfillment_runs(id) ON DELETE CASCADE,
          order_no TEXT NOT NULL REFERENCES fulfillment_orders(order_no),
          PRIMARY KEY (run_id, order_no)
        );
        INSERT INTO scans VALUES ('SCAN-A', 7, '2026-07-30T00:00:00.000Z');
        INSERT INTO scans VALUES ('SCAN-B', 7, '2026-07-30T01:00:00.000Z');
        INSERT INTO fulfillment_orders VALUES
          ('PO-1', '{"orderNo":"PO-1","centerCode":"FC","centerName":"센터","status":"발주확정","transportType":"쉽먼트","createdAt":"2026-07-30T00:00:00.000Z","expectedInboundDate":"2026-08-01","items":[]}',
           '2026-07-30T00:00:00.000Z', '2026-07-30T00:00:00.000Z');
        INSERT INTO fulfillment_runs
          (id, scan_id, selection_key, status, current_stage, created_at, updated_at)
        VALUES ('RUN-A', 'SCAN-A', '["PO-1"]', 'running', 4,
                '2026-07-30T00:00:00.000Z', '2026-07-30T00:00:00.000Z');
        INSERT INTO fulfillment_runs
          (id, scan_id, selection_key, status, current_stage, created_at, updated_at)
        VALUES ('RUN-B', 'SCAN-B', '["PO-1"]', 'running', 4,
                '2026-07-30T01:00:00.000Z', '2026-07-30T01:00:00.000Z');
        INSERT INTO fulfillment_run_orders VALUES ('RUN-A', 'PO-1');
        INSERT INTO fulfillment_run_orders VALUES ('RUN-B', 'PO-1');
        PRAGMA user_version = 4;
      `);
      legacy.close();

      const store = new FulfillmentStore(databasePath);
      expect(store.getRun("RUN-A")).toMatchObject({ status: "failed", workflowVersion: 1 });
      expect(store.getRun("RUN-A").orders).toHaveLength(1);
      expect(store.getRun("RUN-B")).toMatchObject({ status: "failed", orders: [] });
      expect(store.getAutomaticResumeRunIds()).toEqual([]);
      store.close();

      const migrated = new DatabaseSync(databasePath);
      expect(
        migrated.prepare("SELECT COUNT(*) AS count FROM fulfillment_run_order_conflicts").get(),
      ).toMatchObject({ count: 2 });
      expect(migrated.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      migrated.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
