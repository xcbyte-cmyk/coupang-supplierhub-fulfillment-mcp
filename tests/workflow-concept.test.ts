import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const conceptPath = fileURLToPath(
  new URL("../public/workflow-concept.html", import.meta.url),
);
const html = readFileSync(conceptPath, "utf8");

const expectedTools = [
  "open_supplierhub",
  "list_private_label_orders",
  "compare_new_orders",
  "select_orders_for_fulfillment",
  "download_order_confirmation_template",
  "prepare_order_confirmation_workbook",
  "upload_and_confirm_private_label_orders",
  "download_order_files",
  "print_order_files",
  "record_print_result",
  "open_logen_login",
  "open_logen_single_order_registration",
  "register_logen_delivery_order",
  "print_logen_waybill",
  "register_supplierhub_shipment_tracking",
  "print_supplierhub_shipment_documents",
];

describe("workflow concept prototype", () => {
  it("shows the sixteen planned workflow stages and MCP names", () => {
    expect(html.match(/data-flow-step=/g)).toHaveLength(16);
    for (const tool of expectedTools) expect(html).toContain(tool);
  });

  it("stays a static idea document without interactive or connected controls", () => {
    expect(html).not.toMatch(/<(button|input|select|textarea|form)\b/i);
    expect(html).not.toMatch(/<script\b/i);
    expect(html).not.toContain("localStorage");
    expect(html).not.toContain("fetch(");
    expect(html).not.toContain("/api/tools/");
  });

  it("does not introduce duplicate element ids", () => {
    const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
