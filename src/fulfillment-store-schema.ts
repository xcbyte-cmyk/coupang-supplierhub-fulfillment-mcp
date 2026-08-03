import type { DatabaseSync } from "node:sqlite";

/**
 * Owns the fulfillment SQLite schema and all forward-only compatibility migrations.
 *
 * Callers only need to provide an opened database. Keeping schema evolution behind
 * this interface prevents persistence methods from depending on migration details.
 */
export function migrateFulfillmentDatabase(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS scans (
      id TEXT PRIMARY KEY, look_ahead_days INTEGER NOT NULL,
      date_search_type TEXT, date_from TEXT, date_to TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS scan_orders (
      scan_id TEXT NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
      order_no TEXT NOT NULL, payload_json TEXT NOT NULL, is_new INTEGER,
      is_first_seen INTEGER, is_unprocessed INTEGER, disposition TEXT,
      PRIMARY KEY (scan_id, order_no)
    );
    CREATE TABLE IF NOT EXISTS fulfillment_orders (
      order_no TEXT PRIMARY KEY, payload_json TEXT NOT NULL,
      first_seen_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS fulfillment_order_items (
      order_no TEXT NOT NULL REFERENCES fulfillment_orders(order_no) ON DELETE CASCADE,
      sku_code TEXT NOT NULL, payload_json TEXT NOT NULL,
      PRIMARY KEY (order_no, sku_code)
    );
    CREATE TABLE IF NOT EXISTS fulfillment_runs (
      id TEXT PRIMARY KEY, scan_id TEXT NOT NULL REFERENCES scans(id), selection_key TEXT NOT NULL,
      workflow_version INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL, current_stage INTEGER NOT NULL, created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL, last_error TEXT, logen_integration_method TEXT,
      UNIQUE (scan_id, selection_key)
    );
    CREATE TABLE IF NOT EXISTS fulfillment_run_orders (
      run_id TEXT NOT NULL REFERENCES fulfillment_runs(id) ON DELETE CASCADE,
      order_no TEXT NOT NULL REFERENCES fulfillment_orders(order_no),
      PRIMARY KEY (run_id, order_no)
    );
    CREATE TABLE IF NOT EXISTS fulfillment_run_order_conflicts (
      order_no TEXT NOT NULL,
      run_id TEXT NOT NULL,
      kept_run_id TEXT NOT NULL,
      detected_at TEXT NOT NULL,
      PRIMARY KEY (order_no, run_id)
    );
    CREATE TABLE IF NOT EXISTS fulfillment_stage_results (
      run_id TEXT NOT NULL REFERENCES fulfillment_runs(id) ON DELETE CASCADE,
      stage INTEGER NOT NULL, status TEXT NOT NULL, message TEXT NOT NULL,
      items_json TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY (run_id, stage)
    );
    CREATE TABLE IF NOT EXISTS order_confirmation_jobs (
      run_id TEXT NOT NULL REFERENCES fulfillment_runs(id) ON DELETE CASCADE,
      order_no TEXT NOT NULL REFERENCES fulfillment_orders(order_no),
      source_status TEXT NOT NULL,
      status TEXT NOT NULL,
      template_file_name TEXT,
      template_file_path TEXT,
      prepared_file_name TEXT,
      prepared_file_path TEXT,
      message TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (run_id, order_no)
    );
    CREATE TABLE IF NOT EXISTS product_master (
      sku_code TEXT PRIMARY KEY, sku_name TEXT NOT NULL, units_per_carton INTEGER NOT NULL,
      source TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS center_master (
      center_code TEXT PRIMARY KEY, center_name TEXT NOT NULL, recipient_name TEXT NOT NULL,
      address TEXT NOT NULL, telephone TEXT NOT NULL, mobile TEXT, postal_code TEXT,
      source TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS fulfillment_order_file_centers (
      order_no TEXT PRIMARY KEY REFERENCES fulfillment_orders(order_no) ON DELETE CASCADE,
      center_code TEXT NOT NULL, center_name TEXT NOT NULL,
      recipient_name TEXT NOT NULL, address TEXT NOT NULL, telephone TEXT NOT NULL,
      mobile TEXT, postal_code TEXT, captured_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sender_profile (
      id INTEGER PRIMARY KEY CHECK (id = 1), name TEXT NOT NULL, address TEXT NOT NULL,
      telephone TEXT NOT NULL, mobile TEXT, postal_code TEXT, customer_code TEXT NOT NULL,
      fare_type TEXT NOT NULL, box_type_code TEXT, delivery_fare INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS fulfillment_shipping_jobs (
      id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES fulfillment_runs(id) ON DELETE CASCADE,
      order_no TEXT NOT NULL, sku_code TEXT NOT NULL, sku_name TEXT NOT NULL,
      carton_index INTEGER NOT NULL, shipped_quantity INTEGER NOT NULL,
      units_per_carton INTEGER NOT NULL, fix_take_no TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL, error TEXT, slip_no TEXT, shipment_id TEXT,
      logen_registered_at TEXT, waybill_printed_at TEXT, tracking_registered_at TEXT,
      documents_printed_at TEXT,
      UNIQUE (run_id, order_no, sku_code, carton_index)
    );
    CREATE TABLE IF NOT EXISTS fulfillment_artifacts (
      id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES fulfillment_runs(id) ON DELETE CASCADE,
      type TEXT NOT NULL, status TEXT NOT NULL, order_no TEXT, shipping_job_id TEXT,
      file_name TEXT, file_path TEXT, printer_name TEXT, submitted_at TEXT, message TEXT
    );
    CREATE TABLE IF NOT EXISTS logen_batches (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES fulfillment_runs(id) ON DELETE CASCADE,
      order_no TEXT NOT NULL,
      sku_code TEXT NOT NULL,
      sku_name TEXT NOT NULL,
      ordered_quantity INTEGER NOT NULL CHECK (ordered_quantity > 0),
      units_per_carton INTEGER NOT NULL CHECK (units_per_carton >= 0),
      carton_count INTEGER NOT NULL CHECK (carton_count >= 0),
      fix_take_no TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL,
      logen_order_no TEXT,
      registration_keys_json TEXT,
      registration_recorded_at TEXT,
      waybill_status TEXT NOT NULL DEFAULT 'not_started',
      waybill_message TEXT,
      message TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (run_id, order_no, sku_code)
    );
    CREATE TABLE IF NOT EXISTS fulfillment_cartons (
      batch_id TEXT NOT NULL REFERENCES logen_batches(id) ON DELETE CASCADE,
      carton_index INTEGER NOT NULL CHECK (carton_index > 0),
      quantity INTEGER NOT NULL CHECK (quantity > 0),
      original_slip_no TEXT,
      waybill_no TEXT,
      slip_no TEXT UNIQUE,
      status TEXT NOT NULL,
      message TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (batch_id, carton_index)
    );
    CREATE TABLE IF NOT EXISTS shipment_groups (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES fulfillment_runs(id) ON DELETE CASCADE,
      order_no TEXT NOT NULL,
      center_code TEXT NOT NULL,
      expected_inbound_date TEXT NOT NULL,
      order_nos_json TEXT NOT NULL,
      shipment_id TEXT,
      status TEXT NOT NULL,
      message TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (run_id, order_no)
    );
    CREATE TABLE IF NOT EXISTS coupang_upload_jobs (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES fulfillment_runs(id) ON DELETE CASCADE,
      shipment_group_id TEXT REFERENCES shipment_groups(id) ON DELETE SET NULL,
      file_name TEXT NOT NULL,
      file_path TEXT NOT NULL,
      ship_date TEXT NOT NULL,
      ship_time TEXT NOT NULL,
      upload_number TEXT,
      status TEXT NOT NULL,
      message TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (run_id, file_path, ship_date, ship_time)
    );
    CREATE TABLE IF NOT EXISTS coupang_upload_job_groups (
      upload_job_id TEXT NOT NULL REFERENCES coupang_upload_jobs(id) ON DELETE CASCADE,
      shipment_group_id TEXT NOT NULL REFERENCES shipment_groups(id) ON DELETE CASCADE,
      PRIMARY KEY (upload_job_id, shipment_group_id)
    );
    CREATE INDEX IF NOT EXISTS idx_shipping_jobs_run ON fulfillment_shipping_jobs(run_id);
    CREATE INDEX IF NOT EXISTS idx_artifacts_run ON fulfillment_artifacts(run_id);
    CREATE INDEX IF NOT EXISTS idx_logen_batches_run ON logen_batches(run_id);
    CREATE INDEX IF NOT EXISTS idx_cartons_batch ON fulfillment_cartons(batch_id);
    CREATE INDEX IF NOT EXISTS idx_shipment_groups_run ON shipment_groups(run_id);
    CREATE INDEX IF NOT EXISTS idx_upload_jobs_run ON coupang_upload_jobs(run_id);
    CREATE INDEX IF NOT EXISTS idx_upload_job_groups_group
      ON coupang_upload_job_groups(shipment_group_id);
    CREATE INDEX IF NOT EXISTS idx_confirmation_jobs_run
      ON order_confirmation_jobs(run_id);
  `);

  const scanColumns = db
    .prepare("PRAGMA table_info(scans)")
    .all() as Array<{ name: string }>;
  for (const name of ["date_search_type", "date_from", "date_to"] as const) {
    if (!scanColumns.some((column) => column.name === name)) {
      db.exec(`ALTER TABLE scans ADD COLUMN ${name} TEXT`);
    }
  }
  if (
    scanColumns.some((column) => column.name === "expected_inbound_date_from") &&
    scanColumns.some((column) => column.name === "expected_inbound_date_to")
  ) {
    db.exec(`
      UPDATE scans SET
        date_search_type = COALESCE(date_search_type, 'expected_inbound_date'),
        date_from = COALESCE(date_from, expected_inbound_date_from),
        date_to = COALESCE(date_to, expected_inbound_date_to)
    `);
  }
  db.exec(
    "UPDATE scans SET date_search_type = 'expected_inbound_date' WHERE date_search_type IS NULL",
  );

  const scanOrderColumns = db
    .prepare("PRAGMA table_info(scan_orders)")
    .all() as Array<{ name: string }>;
  for (const [name, definition] of [
    ["is_first_seen", "INTEGER"],
    ["is_unprocessed", "INTEGER"],
    ["disposition", "TEXT"],
  ] as const) {
    if (!scanOrderColumns.some((column) => column.name === name)) {
      db.exec(`ALTER TABLE scan_orders ADD COLUMN ${name} ${definition}`);
    }
  }

  const runColumns = db
    .prepare("PRAGMA table_info(fulfillment_runs)")
    .all() as Array<{ name: string }>;
  if (!runColumns.some((column) => column.name === "logen_integration_method")) {
    db.exec(
      "ALTER TABLE fulfillment_runs ADD COLUMN logen_integration_method TEXT",
    );
  }
  if (!runColumns.some((column) => column.name === "workflow_version")) {
    db.exec(
      "ALTER TABLE fulfillment_runs ADD COLUMN workflow_version INTEGER NOT NULL DEFAULT 1",
    );
  }

  const cartonColumns = db
    .prepare("PRAGMA table_info(fulfillment_cartons)")
    .all() as Array<{ name: string }>;
  for (const name of ["original_slip_no", "waybill_no"] as const) {
    if (!cartonColumns.some((column) => column.name === name)) {
      db.exec(`ALTER TABLE fulfillment_cartons ADD COLUMN ${name} TEXT`);
    }
  }
  // A previous prototype temporarily placed the post-print candidate in
  // slip_no. It was never operator-confirmed, so preserve it only as a
  // candidate and clear the final Supplier Hub number.
  db.exec(`
    UPDATE fulfillment_cartons
    SET waybill_no = COALESCE(waybill_no, slip_no), slip_no = NULL
    WHERE status = 'unknown'
      AND slip_no IS NOT NULL
      AND message LIKE '%사용자 확인%'
  `);
  db.exec(`
    UPDATE fulfillment_shipping_jobs
    SET slip_no = NULL
    WHERE status = 'unknown'
      AND slip_no IS NOT NULL
      AND error LIKE '%사용자 확인%'
  `);

  db.exec(`
    BEGIN IMMEDIATE;
    INSERT OR IGNORE INTO fulfillment_run_order_conflicts
      (order_no, run_id, kept_run_id, detected_at)
    SELECT order_no, run_id, kept_run_id, datetime('now')
    FROM (
      SELECT ro.order_no, ro.run_id,
             FIRST_VALUE(ro.run_id) OVER (
               PARTITION BY ro.order_no ORDER BY r.created_at, ro.run_id
             ) AS kept_run_id,
             ROW_NUMBER() OVER (
               PARTITION BY ro.order_no ORDER BY r.created_at, ro.run_id
             ) AS row_number,
             COUNT(*) OVER (PARTITION BY ro.order_no) AS owner_count
      FROM fulfillment_run_orders ro
      JOIN fulfillment_runs r ON r.id = ro.run_id
    ) ranked
    WHERE owner_count > 1;
    UPDATE fulfillment_runs
    SET status = 'failed',
        last_error = '기존 데이터에서 동일 발주의 중복 실행 배정을 발견해 자동 재개를 차단했습니다.',
        updated_at = datetime('now')
    WHERE id IN (SELECT run_id FROM fulfillment_run_order_conflicts);
    DELETE FROM fulfillment_run_orders
    WHERE EXISTS (
      SELECT 1 FROM fulfillment_run_order_conflicts c
      WHERE c.order_no = fulfillment_run_orders.order_no
        AND c.run_id = fulfillment_run_orders.run_id
        AND c.run_id <> c.kept_run_id
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_run_orders_unique_order
      ON fulfillment_run_orders(order_no);
    COMMIT;
  `);

  const logenSchema = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'logen_batches'")
    .get() as { sql?: string } | undefined;
  if (
    logenSchema?.sql?.includes("units_per_carton > 0") ||
    logenSchema?.sql?.includes("carton_count > 0")
  ) {
    db.exec("PRAGMA foreign_keys = OFF;");
    try {
      db.exec(`
        BEGIN IMMEDIATE;
        CREATE TABLE logen_batches_v3 (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL REFERENCES fulfillment_runs(id) ON DELETE CASCADE,
          order_no TEXT NOT NULL,
          sku_code TEXT NOT NULL,
          sku_name TEXT NOT NULL,
          ordered_quantity INTEGER NOT NULL CHECK (ordered_quantity > 0),
          units_per_carton INTEGER NOT NULL CHECK (units_per_carton >= 0),
          carton_count INTEGER NOT NULL CHECK (carton_count >= 0),
          fix_take_no TEXT NOT NULL UNIQUE,
          status TEXT NOT NULL,
          logen_order_no TEXT,
          message TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE (run_id, order_no, sku_code)
        );
        INSERT INTO logen_batches_v3
          (id, run_id, order_no, sku_code, sku_name, ordered_quantity, units_per_carton,
           carton_count, fix_take_no, status, logen_order_no, message, created_at, updated_at)
        SELECT id, run_id, order_no, sku_code, sku_name, ordered_quantity, units_per_carton,
               carton_count, fix_take_no, status, logen_order_no, message, created_at, updated_at
        FROM logen_batches;
        DROP TABLE logen_batches;
        ALTER TABLE logen_batches_v3 RENAME TO logen_batches;
        COMMIT;
      `);
    } catch (error) {
      try {
        db.exec("ROLLBACK;");
      } catch {
        // The migration may have failed before BEGIN; preserve the original error.
      }
      throw error;
    } finally {
      db.exec("PRAGMA foreign_keys = ON;");
    }
  }

  const logenBatchColumns = db
    .prepare("PRAGMA table_info(logen_batches)")
    .all() as Array<{ name: string }>;
  if (!logenBatchColumns.some((column) => column.name === "registration_keys_json")) {
    db.exec("ALTER TABLE logen_batches ADD COLUMN registration_keys_json TEXT");
  }
  if (!logenBatchColumns.some((column) => column.name === "registration_recorded_at")) {
    db.exec("ALTER TABLE logen_batches ADD COLUMN registration_recorded_at TEXT");
  }
  if (!logenBatchColumns.some((column) => column.name === "waybill_status")) {
    db.exec(
      "ALTER TABLE logen_batches ADD COLUMN waybill_status TEXT NOT NULL DEFAULT 'not_started'",
    );
  }
  if (!logenBatchColumns.some((column) => column.name === "waybill_message")) {
    db.exec("ALTER TABLE logen_batches ADD COLUMN waybill_message TEXT");
  }
  db.exec(`
    UPDATE logen_batches
    SET registration_keys_json = json_array(logen_order_no)
    WHERE registration_keys_json IS NULL
      AND logen_order_no IS NOT NULL
      AND trim(logen_order_no) <> ''
    ;
    UPDATE logen_batches
    SET registration_recorded_at = updated_at
    WHERE registration_recorded_at IS NULL
      AND registration_keys_json IS NOT NULL
    ;
    UPDATE logen_batches
    SET waybill_status = CASE
      WHEN status IN ('waybills_printed', 'completed') THEN 'submitted'
      ELSE 'not_started'
    END
    WHERE waybill_status IS NULL OR trim(waybill_status) = ''
    ;
    UPDATE logen_batches
    SET waybill_status = 'submitted'
    WHERE status IN ('waybills_printed', 'completed')
      AND waybill_status = 'not_started'
  `);

  const shipmentColumns = db
    .prepare("PRAGMA table_info(shipment_groups)")
    .all() as Array<{ name: string }>;
  if (!shipmentColumns.some((column) => column.name === "order_no")) {
    db.exec("PRAGMA foreign_keys = OFF;");
    try {
      db.exec(`
        BEGIN IMMEDIATE;
        CREATE TEMP TABLE shipment_group_v5_map (
          old_id TEXT NOT NULL,
          new_id TEXT NOT NULL,
          order_no TEXT NOT NULL,
          item_index INTEGER NOT NULL,
          PRIMARY KEY (old_id, new_id)
        );
        INSERT INTO shipment_group_v5_map (old_id, new_id, order_no, item_index)
        SELECT g.id,
               CASE
                 WHEN CAST(j.key AS INTEGER) = 0 THEN g.id
                 ELSE g.id || '-po-' || CAST(j.key AS TEXT)
               END,
               CAST(j.value AS TEXT),
               CAST(j.key AS INTEGER)
        FROM shipment_groups g, json_each(g.order_nos_json) j;
        CREATE TABLE shipment_groups_v5 (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL REFERENCES fulfillment_runs(id) ON DELETE CASCADE,
          order_no TEXT NOT NULL,
          center_code TEXT NOT NULL,
          expected_inbound_date TEXT NOT NULL,
          order_nos_json TEXT NOT NULL,
          shipment_id TEXT,
          status TEXT NOT NULL,
          message TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE (run_id, order_no)
        );
        INSERT INTO shipment_groups_v5
          (id, run_id, order_no, center_code, expected_inbound_date, order_nos_json,
           shipment_id, status, message, created_at, updated_at)
        SELECT m.new_id, g.run_id, m.order_no,
               g.center_code, g.expected_inbound_date, json_array(m.order_no),
               CASE WHEN json_array_length(g.order_nos_json) = 1 THEN g.shipment_id ELSE NULL END,
               CASE WHEN json_array_length(g.order_nos_json) = 1 THEN g.status ELSE 'unknown' END,
               CASE
                 WHEN json_array_length(g.order_nos_json) = 1 THEN g.message
                 ELSE '기존 다중 발주 쉽먼트 그룹은 자동 재처리하지 않습니다.'
               END,
               g.created_at, g.updated_at
        FROM shipment_groups g
        JOIN shipment_group_v5_map m ON m.old_id = g.id;
        INSERT OR IGNORE INTO coupang_upload_job_groups
          (upload_job_id, shipment_group_id)
        SELECT relation.upload_job_id, mapping.new_id
        FROM coupang_upload_job_groups relation
        JOIN shipment_group_v5_map mapping
          ON mapping.old_id = relation.shipment_group_id;
        INSERT OR IGNORE INTO coupang_upload_job_groups
          (upload_job_id, shipment_group_id)
        SELECT job.id, mapping.new_id
        FROM coupang_upload_jobs job
        JOIN shipment_group_v5_map mapping
          ON mapping.old_id = job.shipment_group_id;
        DROP TABLE shipment_groups;
        ALTER TABLE shipment_groups_v5 RENAME TO shipment_groups;
        DROP TABLE shipment_group_v5_map;
        COMMIT;
      `);
    } catch (error) {
      try {
        db.exec("ROLLBACK;");
      } catch {
        // The migration may have failed before BEGIN; preserve the original error.
      }
      throw error;
    } finally {
      db.exec("PRAGMA foreign_keys = ON;");
    }
  }

  db.exec(`
    BEGIN IMMEDIATE;
    CREATE TEMP TABLE IF NOT EXISTS fulfillment_v3_migration_runs (
      run_id TEXT PRIMARY KEY,
      has_logen_progress INTEGER NOT NULL
    );
    DELETE FROM fulfillment_v3_migration_runs;
    INSERT INTO fulfillment_v3_migration_runs (run_id, has_logen_progress)
    SELECT r.id,
           CASE WHEN EXISTS (
             SELECT 1 FROM fulfillment_stage_results s
             WHERE s.run_id = r.id
               AND s.stage BETWEEN 11 AND 14
               AND s.status IN ('completed', 'partial', 'unknown')
           ) OR EXISTS (
             SELECT 1 FROM logen_batches b
             WHERE b.run_id = r.id
               AND (b.logen_order_no IS NOT NULL
                    OR b.status IN ('registered', 'waybills_printed', 'completed', 'unknown'))
           ) THEN 1 ELSE 0 END
    FROM fulfillment_runs r
    WHERE r.workflow_version = 2
      AND r.status NOT IN ('completed', 'released');

    UPDATE fulfillment_stage_results
    SET stage = stage + 100
    WHERE run_id IN (SELECT run_id FROM fulfillment_v3_migration_runs)
      AND stage BETWEEN 11 AND 14;
    UPDATE fulfillment_stage_results
    SET stage = CASE stage
      WHEN 111 THEN 13
      WHEN 112 THEN 14
      WHEN 113 THEN 15
      WHEN 114 THEN 16
      ELSE stage
    END
    WHERE run_id IN (SELECT run_id FROM fulfillment_v3_migration_runs)
      AND stage BETWEEN 111 AND 114;

    INSERT OR IGNORE INTO fulfillment_stage_results
      (run_id, stage, status, message, items_json, updated_at)
    SELECT run_id, 11, 'completed',
           '기존 실행에서 로젠 로그인 완료 상태를 이어받았습니다.', '[]', datetime('now')
    FROM fulfillment_v3_migration_runs WHERE has_logen_progress = 1;
    INSERT OR IGNORE INTO fulfillment_stage_results
      (run_id, stage, status, message, items_json, updated_at)
    SELECT run_id, 12, 'completed',
           '기존 실행에서 주문등록/출력(단건) 화면 이동 상태를 이어받았습니다.', '[]', datetime('now')
    FROM fulfillment_v3_migration_runs WHERE has_logen_progress = 1;

    UPDATE fulfillment_runs
    SET workflow_version = 3,
        current_stage = CASE
          WHEN current_stage < 11 THEN current_stage
          WHEN (SELECT has_logen_progress FROM fulfillment_v3_migration_runs m WHERE m.run_id = fulfillment_runs.id) = 0 THEN 10
          WHEN current_stage = 11 THEN 13
          WHEN current_stage = 12 THEN 14
          WHEN current_stage = 13 THEN 15
          WHEN current_stage = 14 THEN 16
          ELSE current_stage
        END,
        status = CASE
          WHEN current_stage >= 11
           AND (SELECT has_logen_progress FROM fulfillment_v3_migration_runs m WHERE m.run_id = fulfillment_runs.id) = 0
            THEN 'running'
          ELSE status
        END,
        last_error = CASE
          WHEN current_stage >= 11
           AND (SELECT has_logen_progress FROM fulfillment_v3_migration_runs m WHERE m.run_id = fulfillment_runs.id) = 0
            THEN NULL
          ELSE last_error
        END,
        updated_at = datetime('now')
    WHERE id IN (SELECT run_id FROM fulfillment_v3_migration_runs);
    DROP TABLE fulfillment_v3_migration_runs;
    COMMIT;
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_logen_batches_run ON logen_batches(run_id);
    CREATE INDEX IF NOT EXISTS idx_shipment_groups_run ON shipment_groups(run_id);
    CREATE INDEX IF NOT EXISTS idx_confirmation_jobs_run
      ON order_confirmation_jobs(run_id);
    PRAGMA user_version = 10;
  `);
}

