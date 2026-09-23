import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registerFulfillmentMcpTools, type FulfillmentWorkflowMcpPort } from "./fulfillment-mcp.js";
import type { WorkflowReply } from "./types.js";
import type { SupplierHubWorkflow } from "./workflow-module.js";

const UI_URI = "ui://supplierhub-workflow/dashboard-v1.html";
const dashboardOutputSchema = { dashboard: z.record(z.unknown()) };

interface WorkflowMcpServerOptions {
  workflow: SupplierHubWorkflow;
  fulfillmentWorkflow: FulfillmentWorkflowMcpPort;
  dashboardHtml: string;
}

export function createWorkflowMcpServer({
  workflow,
  fulfillmentWorkflow,
  dashboardHtml,
}: WorkflowMcpServerOptions): McpServer {
  const server = new McpServer(
    { name: "coupang-supplierhub-workflow", version: "0.1.0" },
    {
      instructions:
        "Use get_workflow_dashboard first. Scanning never confirms orders. Printing requires a prepared batch and the exact confirmation phrase returned by prepare_print_batch.",
    },
  );

  registerAppResource(server, "supplierhub-workflow-dashboard", UI_URI, {}, async () => ({
    contents: [
      {
        uri: UI_URI,
        mimeType: RESOURCE_MIME_TYPE,
        text: dashboardHtml,
        _meta: {
          ui: {
            prefersBorder: false,
            csp: { connectDomains: [], resourceDomains: [] },
          },
        },
      },
    ],
  }));

  registerAppTool(
    server,
    "get_workflow_dashboard",
    {
      title: "Supplier Hub workflow dashboard",
      description:
        "Use this when the user wants to open or review the Private Label order and printing workflow dashboard.",
      inputSchema: {},
      outputSchema: dashboardOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      _meta: { ui: { resourceUri: UI_URI } },
    },
    async () => mcpReply(await workflow.getStatus()),
  );

  registerAppTool(
    server,
    "open_supplierhub_login",
    {
      title: "Open Supplier Hub login",
      description:
        "Use this when the operator needs to open the dedicated Chrome profile and sign in to Supplier Hub.",
      inputSchema: {},
      outputSchema: dashboardOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      _meta: { ui: { resourceUri: UI_URI } },
    },
    async () => mcpReply(await workflow.openLogin()),
  );

  registerAppTool(
    server,
    "scan_private_label_orders",
    {
      title: "Scan Private Label orders",
      description:
        "Use this to read the Supplier Hub Private Label purchase-order list and record newly discovered order numbers without confirming orders.",
      inputSchema: {},
      outputSchema: dashboardOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      _meta: { ui: { resourceUri: UI_URI } },
    },
    async () => mcpReply(await workflow.scan("manual")),
  );

  registerAppTool(
    server,
    "update_workflow_settings",
    {
      title: "Update workflow settings",
      description:
        "Use this to change demo/live mode, scan cadence, active hours, printer, copies, or date range.",
      inputSchema: {
        mode: z.enum(["demo", "live"]).optional(),
        scheduleEnabled: z.boolean().optional(),
        intervalMinutes: z.number().int().min(5).max(1440).optional(),
        windowStart: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
        windowEnd: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
        printerName: z.string().min(1).max(200).optional(),
        copies: z.number().int().min(1).max(5).optional(),
        lookAheadDays: z.union([z.literal(7), z.literal(30)]).optional(),
        firstLiveScanIsBaseline: z.boolean().optional(),
      },
      outputSchema: dashboardOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      _meta: { ui: { resourceUri: UI_URI } },
    },
    async (args) => mcpReply(await workflow.updateSettings(args)),
  );

  registerAppTool(
    server,
    "prepare_print_batch",
    {
      title: "Prepare print batch",
      description:
        "Use this after the operator selects new orders. It creates an approval-gated print batch but does not download or print yet.",
      inputSchema: {
        orderNos: z.array(z.string().min(1)).min(1).max(100),
      },
      outputSchema: dashboardOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      _meta: { ui: { resourceUri: UI_URI } },
    },
    async ({ orderNos }) => mcpReply(await workflow.preparePrintBatch(orderNos)),
  );

  registerAppTool(
    server,
    "hold_print_batch",
    {
      title: "Hold print batch",
      description: "Use this to hold an approval-pending print batch without printing it.",
      inputSchema: { batchId: z.string().min(1) },
      outputSchema: dashboardOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      _meta: { ui: { resourceUri: UI_URI } },
    },
    async ({ batchId }) => mcpReply(await workflow.holdBatch(batchId)),
  );

  registerAppTool(
    server,
    "print_batch",
    {
      title: "Print approved batch",
      description:
        "Use this only after explicit operator approval. It downloads, validates, and physically prints the batch. confirmation must equal PRINT plus the batch id.",
      inputSchema: {
        batchId: z.string().min(1),
        confirmation: z.string().min(1),
      },
      outputSchema: dashboardOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      _meta: { ui: { resourceUri: UI_URI } },
    },
    async ({ batchId, confirmation }) =>
      mcpReply(await workflow.printBatch(batchId, confirmation)),
  );

  registerFulfillmentMcpTools(server, fulfillmentWorkflow);

  return server;
}

function mcpReply(reply: WorkflowReply) {
  return {
    content: [{ type: "text" as const, text: reply.message }],
    structuredContent: { dashboard: reply.dashboard },
  };
}
