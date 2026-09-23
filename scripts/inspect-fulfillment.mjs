import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { planFulfillment } from "../dist/fulfillment-planning.js";
import { readShipmentWorkbookData } from "../dist/xlsx-order-reader.js";

// Deliberately use DatabaseSync(readOnly), not FulfillmentStore: inspection must
// not run migrations, seed masters, change stage results or contact an adapter.
const { values } = parseArgs({
  options: {
    run: { type: "string" },
    db: { type: "string" },
    "data-source": { type: "string", default: "auto" },
    "carton-units": { type: "string", multiple: true, default: [] },
    help: { type: "boolean" },
  },
});

if (values.help) {
  console.log("사용법: npm run inspect:fulfillment -- --run RUN_ID [--data-source auto|backend|order_file] [--carton-units SKU=수량]");
  console.log("--carton-units는 계산 비교용 가정입니다. DB 저장·외부 주문·인쇄는 실행하지 않습니다.");
  process.exit(0);
}
if (!values.run) throw new Error("확인할 실행을 --run RUN_ID로 지정하세요.");
if (!["auto", "backend", "order_file"].includes(values["data-source"])) {
  throw new Error("--data-source는 auto, backend, order_file 중 하나여야 합니다.");
}

const assumptions = new Map();
for (const input of values["carton-units"]) {
  const match = /^([^=]+)=([1-9]\d*)$/.exec(input);
  if (!match || !Number.isSafeInteger(Number(match[2]))) {
    throw new Error("--carton-units는 SKU=양의정수 형식으로 지정하세요.");
  }
  if (assumptions.has(match[1])) throw new Error(`SKU ${match[1]}의 가정이 중복됐습니다.`);
  assumptions.set(match[1], Number(match[2]));
}

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const dbPath = resolve(projectRoot, values.db ?? "data/fulfillment.db");
const db = new DatabaseSync(dbPath, { readOnly: true });
try {
  const run = db.prepare("SELECT id, status, current_stage, workflow_version, logen_integration_method, last_error FROM fulfillment_runs WHERE id = ?").get(values.run);
  if (!run) throw new Error(`실행 ${values.run}을 찾을 수 없습니다.`);
  const orders = db.prepare("SELECT o.payload_json FROM fulfillment_orders o JOIN fulfillment_run_orders r ON r.order_no = o.order_no WHERE r.run_id = ? ORDER BY o.order_no").all(run.id).map(row => JSON.parse(row.payload_json));
  const itemQuery = db.prepare("SELECT payload_json FROM fulfillment_order_items WHERE order_no = ? ORDER BY sku_code");
  const productQuery = db.prepare("SELECT units_per_carton, source, updated_at FROM product_master WHERE sku_code = ?");
  const sourceDetails = [];
  const resolvedOrders = orders.map(order => ({
    ...order,
    items: itemQuery.all(order.orderNo).map(row => {
      const item = JSON.parse(row.payload_json);
      const stored = productQuery.get(item.skuCode);
      const backendUnits = stored?.source !== "demo" ? positiveInteger(stored?.units_per_carton) : undefined;
      const fileUnits = positiveInteger(item.unitsPerCarton);
      const source = values["data-source"];
      const selectedUnits = source === "backend" ? backendUnits : source === "order_file" ? fileUnits : backendUnits ?? fileUnits;
      const assumedUnits = assumptions.get(item.skuCode);
      sourceDetails.push({
        orderNo: order.orderNo,
        skuCode: item.skuCode,
        skuName: item.skuName,
        orderedQuantity: item.orderedQuantity,
        backendUnits: backendUnits ?? null,
        backendSource: stored?.source ?? null,
        orderFileUnits: fileUnits ?? null,
        assumedUnits: assumedUnits ?? null,
        effectiveUnits: assumedUnits ?? selectedUnits ?? null,
        effectiveSource: assumedUnits ? "simulation_only" : selectedUnits ? (source === "order_file" || !backendUnits ? "order_file" : "backend") : "missing",
      });
      return { ...item, unitsPerCarton: assumedUnits ?? selectedUnits };
    }),
  }));
  for (const sku of assumptions.keys()) {
    if (!sourceDetails.some(item => item.skuCode === sku)) throw new Error(`실행에 없는 SKU ${sku}의 가정은 적용하지 않습니다.`);
  }
  const artifacts = db.prepare("SELECT order_no, file_name, file_path FROM fulfillment_artifacts WHERE run_id = ? AND type = 'order_file' AND status = 'downloaded'").all(run.id);
  const files = artifacts.filter(file => file.file_path?.toLowerCase().endsWith(".xlsx")).map(file => {
    try {
      const workbook = readShipmentWorkbookData(file.file_path);
      return {
        orderNo: file.order_no,
        fileName: file.file_name,
        items: (workbook.orders.find(order => order.orderNo === file.order_no)?.items ?? []).map(item => ({
          skuCode: item.skuCode, orderedQuantity: item.orderedQuantity, unitsPerCarton: item.unitsPerCarton ?? null,
        })),
      };
    } catch (error) {
      return { orderNo: file.order_no, fileName: file.file_name, error: error instanceof Error ? error.message : String(error) };
    }
  });
  const plan = planFulfillment({ runId: run.id, orders: resolvedOrders, now: new Date().toISOString() });
  const stages = db.prepare("SELECT stage, status, message, updated_at FROM fulfillment_stage_results WHERE run_id = ? ORDER BY stage").all(run.id);
  console.log(JSON.stringify({
    inspectedAt: new Date().toISOString(),
    readOnly: true,
    run,
    dataSource: values["data-source"],
    products: sourceDetails,
    downloadedOrderFiles: files,
    plan: {
      status: plan.batches.every(batch => batch.status === "ready") && plan.batches.length ? "carton_plan_ready" : "blocked",
      batchCount: plan.batches.length,
      cartonCount: plan.cartons.length,
      batches: plan.batches.map(batch => ({ orderNo: batch.orderNo, skuCode: batch.skuCode, orderedQuantity: batch.orderedQuantity, unitsPerCarton: batch.unitsPerCarton, cartonCount: batch.cartonCount, status: batch.status, message: batch.message })),
      note: "카톤 계산 결과입니다. 로젠 로그인·수취 정보·운임·외부 저장·출력 성공을 의미하지 않습니다.",
    },
    stages,
    databaseWrites: 0,
    externalRequests: 0,
    assumptionsAppliedToProduction: false,
  }, null, 2));
} finally {
  db.close();
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : undefined;
}
