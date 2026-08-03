import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ShipmentWorkbookAdapter } from "../src/shipment-workbook-adapter.js";
import type {
  FulfillmentCarton,
  FulfillmentOrder,
  LogenBatch,
} from "../src/fulfillment-types.js";

const roots: string[] = [];
const AT = "2026-07-30T00:00:00.000Z";

afterEach(async () => {
  while (roots.length > 0) await rm(roots.pop()!, { recursive: true, force: true });
});

describe("ShipmentWorkbookAdapter", () => {
  it("reuses the run+manifest path and creates a new path only when the manifest changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "shipment-workbook-adapter-"));
    roots.push(root);
    const sourceWorkbook = join(root, "source.xlsx");
    const outputRoot = join(root, "output");
    const fakeBuilder = join(root, "fake-builder.mjs");
    await writeFile(sourceWorkbook, "source", "utf8");
    await writeFile(
      fakeBuilder,
      `
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
const output = process.argv[process.argv.indexOf("--output") + 1];
if (existsSync(output)) {
  console.error("builder must not run for an existing deterministic output");
  process.exit(41);
}
const manifest = readFileSync(0, "utf8");
writeFileSync(output, manifest, "utf8");
console.log(JSON.stringify({ fileName: basename(output), filePath: resolve(output) }));
`,
      "utf8",
    );

    const adapter = new ShipmentWorkbookAdapter({
      sourceWorkbook,
      outputRoot,
      pythonExecutable: process.execPath,
      scriptPath: fakeBuilder,
    });
    const input = fixture();
    const first = await adapter.build(input);
    const firstContents = await readFile(first.filePath, "utf8");
    expect(first.fileName).toMatch(/^ShipmentsUpload_run-1_[0-9a-f]{64}\.xlsx$/);
    const repeated = await adapter.build({
      ...input,
      orders: [...input.orders].reverse(),
      batches: [...input.batches].reverse(),
      cartons: [...input.cartons].reverse(),
    });

    expect(repeated).toEqual(first);
    expect(await readFile(repeated.filePath, "utf8")).toBe(firstContents);
    expect((await readdir(outputRoot)).filter((name) => name.endsWith(".xlsx"))).toHaveLength(1);

    const changed = await adapter.build({
      ...input,
      cartons: input.cartons.map((carton) => ({ ...carton, slipNo: "SLIP-CHANGED" })),
    });

    expect(changed.filePath).not.toBe(first.filePath);
    expect((await readdir(outputRoot)).filter((name) => name.endsWith(".xlsx"))).toHaveLength(2);
  });
});

function fixture(): {
  runId: string;
  orders: FulfillmentOrder[];
  batches: LogenBatch[];
  cartons: FulfillmentCarton[];
} {
  const order: FulfillmentOrder = {
    orderNo: "PO-1",
    centerCode: "FC-1",
    centerName: "센터",
    status: "발주확정",
    transportType: "쉽먼트",
    createdAt: AT,
    expectedInboundDate: "2026-08-02",
    items: [{ skuCode: "SKU-1", skuName: "상품", orderedQuantity: 10 }],
  };
  const batch: LogenBatch = {
    id: "batch-1",
    runId: "run-1",
    orderNo: order.orderNo,
    skuCode: order.items[0].skuCode,
    skuName: order.items[0].skuName,
    orderedQuantity: 10,
    unitsPerCarton: 10,
    cartonCount: 1,
    fixTakeNo: "PO-1-SKU-1",
    status: "waybills_printed",
    createdAt: AT,
    updatedAt: AT,
  };
  return {
    runId: "run-1",
    orders: [order],
    batches: [batch],
    cartons: [
      {
        batchId: batch.id,
        cartonIndex: 1,
        quantity: 10,
        slipNo: "SLIP-1",
        status: "waybill_assigned",
        createdAt: AT,
        updatedAt: AT,
      },
    ],
  };
}
