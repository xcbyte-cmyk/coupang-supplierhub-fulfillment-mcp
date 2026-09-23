export type FulfillmentStage =
  | 1
  | 2
  | 3
  | 4
  | 5
  | 6
  | 7
  | 8
  | 9
  | 10
  | 11
  | 12
  | 13
  | 14
  | 15
  | 16;

export type FulfillmentWorkflowVersion = 1 | 2 | 3;

export type FulfillmentStageStatus =
  | "completed"
  | "partial"
  | "blocked"
  | "failed"
  | "unknown";

export type FulfillmentRunStatus =
  | "created"
  | "running"
  | "completed"
  | "partial"
  | "blocked"
  | "failed"
  | "released";

export type FulfillmentDataSource = "auto" | "backend" | "order_file";

/** The Logen execution channel selected for one fulfillment run. */
export type LogenIntegrationMethod = "api" | "website_mcp";

export type FulfillmentAgent =
  | "supplierhub_agent"
  | "logen_agent"
  | "fulfillment_coordinator";

export interface FulfillmentStageReply<T = unknown> {
  runId?: string;
  scanId?: string;
  stage: FulfillmentStage;
  status: FulfillmentStageStatus;
  items: T[];
  message: string;
  nextTool?: string;
  agent?: FulfillmentAgent;
}

export interface FulfillmentOrderItem {
  skuCode: string;
  skuName: string;
  orderedQuantity: number;
  barcode?: string;
  unitsPerCarton?: number;
  source?: "supplierhub" | "order_file" | "backend" | "demo";
}

export interface FulfillmentOrder {
  orderNo: string;
  centerCode: string;
  centerName: string;
  status: string;
  transportType: string;
  createdAt: string;
  expectedInboundDate: string;
  items: FulfillmentOrderItem[];
  /** Optional best-effort recipient data imported from an order workbook. */
  centerMaster?: CenterMaster;
}

export interface FulfillmentOrderQuery {
  lookAheadDays: 7 | 30;
  dateSearchType?: "expected_inbound_date" | "order_date";
  dateFrom?: string;
  dateTo?: string;
}

export type FulfillmentOrderDisposition =
  | "needs_confirmation"
  | "already_confirmed"
  | "already_assigned"
  | "unsupported_status";

export interface ClassifiedFulfillmentOrder {
  order: FulfillmentOrder;
  disposition: FulfillmentOrderDisposition;
  firstSeen: boolean;
  unprocessed: boolean;
  message: string;
}

export type OrderConfirmationStatus =
  | "pending"
  | "downloaded"
  | "prepared"
  | "uploaded"
  | "confirmed"
  | "failed"
  | "unknown";

export interface OrderConfirmationJob {
  runId: string;
  orderNo: string;
  sourceStatus: string;
  status: OrderConfirmationStatus;
  templateFileName?: string;
  templateFilePath?: string;
  preparedFileName?: string;
  preparedFilePath?: string;
  message?: string;
  createdAt: string;
  updatedAt: string;
}

export interface DownloadedOrderConfirmationTemplate {
  fileName: string;
  filePath: string;
  orderNos: string[];
}

export interface PreparedOrderConfirmationWorkbook {
  fileName: string;
  filePath: string;
  orderNos: string[];
  changedRows: number;
}

export interface OrderConfirmationUploadResult {
  status: "confirmed" | "partial" | "failed" | "unknown";
  confirmedOrderNos: string[];
  unresolvedOrderNos: string[];
  message: string;
}

export interface ScanSnapshot {
  id: string;
  lookAheadDays: 7 | 30;
  dateSearchType: "expected_inbound_date" | "order_date";
  dateFrom?: string;
  dateTo?: string;
  createdAt: string;
  orders: FulfillmentOrder[];
}

export interface StageRecord {
  stage: FulfillmentStage;
  status: FulfillmentStageStatus;
  message: string;
  items: unknown[];
  updatedAt: string;
}

export type ArtifactType =
  | "order_file"
  | "order_print"
  | "waybill_print"
  | "shipment_label"
  | "shipment_statement";

export type ArtifactStatus = "downloaded" | "submitted" | "failed" | "unknown";

export interface FulfillmentArtifact {
  id: string;
  runId: string;
  type: ArtifactType;
  status: ArtifactStatus;
  orderNo?: string;
  shippingJobId?: string;
  fileName?: string;
  filePath?: string;
  printerName?: string;
  submittedAt?: string;
  message?: string;
}

export interface ShippingJob {
  id: string;
  runId: string;
  orderNo: string;
  skuCode: string;
  skuName: string;
  cartonIndex: number;
  shippedQuantity: number;
  unitsPerCarton: number;
  fixTakeNo: string;
  status:
    | "ready"
    | "blocked"
    | "registered"
    | "waybill_printed"
    | "tracking_registered"
    | "documents_printed"
    | "failed"
    | "unknown";
  error?: string;
  slipNo?: string;
  shipmentId?: string;
  logenRegisteredAt?: string;
  waybillPrintedAt?: string;
  trackingRegisteredAt?: string;
  documentsPrintedAt?: string;
}

export interface LogenWaybillNumberConfirmation {
  batchId: string;
  cartonIndex: number;
  selectedSource: "original" | "waybill";
}

export interface ProductMaster {
  skuCode: string;
  skuName: string;
  unitsPerCarton: number;
  source: "backend" | "order_file" | "demo";
  updatedAt: string;
}

export interface ProductUnitsUpdate {
  skuCode: string;
  unitsPerCarton: number;
  expectedUnitsPerCarton: number | null;
  expectedUpdatedAt: string | null;
}

export interface RegistrationPreviewInput {
  runId: string;
  dataSource: FulfillmentDataSource;
  logenMethod?: LogenIntegrationMethod;
  draftUnits?: Array<{ skuCode: string; unitsPerCarton: number }>;
}

export interface CenterMaster {
  centerCode: string;
  centerName: string;
  recipientName: string;
  address: string;
  telephone: string;
  mobile?: string;
  postalCode?: string;
  source: "backend" | "order_file" | "demo";
  updatedAt: string;
}

export interface SenderProfile {
  name: string;
  address: string;
  telephone: string;
  mobile?: string;
  postalCode?: string;
  customerCode: string;
  fareType: string;
  boxTypeCode?: string;
  deliveryFare: number;
  updatedAt: string;
}

/** Sender identity found in a Supplier Hub order workbook. */
export interface OrderFileSenderProfile {
  name: string;
  address: string;
  telephone: string;
  mobile?: string;
  postalCode?: string;
  /** Present only when the workbook explicitly contains a Logen customer code. */
  customerCode?: string;
}

export type LogenBatchStatus =
  | "ready"
  | "blocked"
  | "registered"
  | "waybills_printed"
  | "completed"
  | "failed"
  | "unknown";

export type LogenWaybillStatus =
  | "not_started"
  | "in_flight"
  | "submitted"
  | "failed"
  | "unknown";

/** One Logen registration unit for a purchase-order SKU. */
export interface LogenBatch {
  id: string;
  runId: string;
  orderNo: string;
  skuCode: string;
  skuName: string;
  orderedQuantity: number;
  unitsPerCarton: number;
  cartonCount: number;
  fixTakeNo: string;
  status: LogenBatchStatus;
  /** API order number, or the stable IBSheet reservation-row key for website MCP. */
  logenOrderNo?: string;
  /** Ordered IBSheet reservation-row keys. Website MCP may create one row per carton. */
  registrationKeys?: string[];
  /** Timestamp at which stage 13 durably recorded the reservation identifiers. */
  registrationRecordedAt?: string;
  /** Stage-14 state, kept separate so print failures cannot erase stage-13 registration. */
  waybillStatus?: LogenWaybillStatus;
  waybillMessage?: string;
  message?: string;
  createdAt: string;
  updatedAt: string;
}

export type FulfillmentCartonStatus =
  | "ready"
  | "waybill_assigned"
  | "uploaded"
  | "completed"
  | "failed"
  | "unknown";

/** One physical carton belonging to a PO+SKU Logen batch. */
export interface FulfillmentCarton {
  batchId: string;
  cartonIndex: number;
  quantity: number;
  /** Original number shown by Logen after a reissue. This is only a candidate. */
  originalSlipNo?: string;
  /** Current waybill number shown by Logen. This is only a candidate. */
  waybillNo?: string;
  /** Final number explicitly selected by the operator for Supplier Hub. */
  slipNo?: string;
  status: FulfillmentCartonStatus;
  message?: string;
  createdAt: string;
  updatedAt: string;
}

export type ShipmentGroupStatus =
  | "ready"
  | "created"
  | "tracking_uploaded"
  | "documents_printed"
  | "completed"
  | "blocked"
  | "failed"
  | "unknown";

/** One Supplier Hub shipment per purchase order. `orderNos` is kept for storage compatibility. */
export interface ShipmentGroup {
  id: string;
  runId: string;
  centerCode: string;
  expectedInboundDate: string;
  orderNos: string[];
  shipmentId?: string;
  status: ShipmentGroupStatus;
  message?: string;
  createdAt: string;
  updatedAt: string;
}

export type CoupangUploadJobStatus =
  | "prepared"
  | "uploaded"
  | "confirmed"
  | "failed"
  | "unknown";

/** One Supplier Hub shipment-upload file submission. */
export interface CoupangUploadJob {
  id: string;
  runId: string;
  shipmentGroupId?: string;
  shipmentGroupIds?: string[];
  fileName: string;
  filePath: string;
  shipDate: string;
  shipTime: string;
  uploadNumber?: string;
  status: CoupangUploadJobStatus;
  message?: string;
  createdAt: string;
  updatedAt: string;
}

export interface FulfillmentRun {
  id: string;
  scanId: string;
  workflowVersion: FulfillmentWorkflowVersion;
  status: FulfillmentRunStatus;
  currentStage: FulfillmentStage | 0;
  createdAt: string;
  updatedAt: string;
  lastError?: string;
  /** Bound at stage 11 in workflow v3 (stage 11 in v2) so Logen channels cannot mix. */
  logenIntegrationMethod?: LogenIntegrationMethod;
  orders: FulfillmentOrder[];
  shippingJobs: ShippingJob[];
  artifacts: FulfillmentArtifact[];
  stages: StageRecord[];
  /** Present for the integrated v2 fulfillment model. Optional for legacy callers. */
  logenBatches?: LogenBatch[];
  cartons?: FulfillmentCarton[];
  shipmentGroups?: ShipmentGroup[];
  coupangUploadJobs?: CoupangUploadJob[];
  orderConfirmationJobs?: OrderConfirmationJob[];
}

export interface FulfillmentConnectionResult {
  status: "ready" | "login_required" | "blocked" | "error";
  message: string;
  url?: string;
}

export interface FulfillmentOrderListResult {
  connection: FulfillmentConnectionResult;
  orders: FulfillmentOrder[];
}

export interface DownloadedOrderFile {
  orderNo: string;
  fileName: string;
  filePath: string;
  items?: FulfillmentOrderItem[];
  /** Best-effort center data read from the downloaded order file. */
  center?: CenterMaster;
  /** Best-effort sender data read from the downloaded order file. */
  sender?: OrderFileSenderProfile;
}

export type LogenAction = "register" | "print";

export interface LogenExecutionContext {
  integrationMethod: LogenIntegrationMethod;
  /** Explicit recovery-only permission. Normal runs never reprint a printed Logen row. */
  forceReprint?: boolean;
  /** Exact receiver name used to reconcile a saved website order whose row keys were not recorded. */
  recipientNamesByBatchId?: Readonly<Record<string, string>>;
}

export interface LogenReadiness {
  ready: boolean;
  message: string;
}

export interface PrintSubmission {
  success: boolean;
  status?: "submitted" | "failed" | "unknown";
  submittedFiles: string[];
  message: string;
}

export interface ShipmentTrackingResult {
  orderNo: string;
  shipmentId?: string;
  slipNos: string[];
  success: boolean;
  message: string;
}

export interface ShipmentDocumentResult {
  orderNo: string;
  shipmentId: string;
  documents: Array<{
    type: "shipment_label" | "shipment_statement";
    fileName: string;
    filePath: string;
  }>;
}

export interface LogenRegistrationResult {
  shippingJobId: string;
  fixTakeNo: string;
  success: boolean;
  status?: "registered" | "failed" | "unknown";
  /** Actual reservation number issued by the Logen single-order screen. */
  logenOrderNo?: string;
  /** All reservation-row keys created by the website screen, in carton order. */
  registrationKeys?: string[];
  message: string;
}

export interface LogenWaybillResult {
  shippingJobId: string;
  fixTakeNo: string;
  slipNo?: string;
  success: boolean;
  status?: "submitted" | "failed" | "unknown";
  message: string;
}

export interface LogenBatchRegistrationResult {
  batchId: string;
  fixTakeNo: string;
  success: boolean;
  status?: "registered" | "failed" | "unknown";
  logenOrderNo?: string;
  registrationKeys?: string[];
  message: string;
}

export interface LogenBatchWaybillResult {
  batchId: string;
  fixTakeNo: string;
  slipNos: string[];
  registrationKeys?: string[];
  numberCandidates?: Array<{
    cartonIndex: number;
    originalSlipNo?: string;
    waybillNo?: string;
  }>;
  success: boolean;
  status: "submitted" | "failed" | "unknown";
  message: string;
}

export interface LogenBatchWaybillInspectionResult {
  batchId: string;
  registrationKeys: string[];
  printState: "unprinted" | "printed" | "mixed" | "unknown";
  success: boolean;
  message: string;
}

export interface LogenBatchPort {
  registerBatches(
    batches: LogenBatch[],
    sender: SenderProfile,
    centersByOrder: Record<string, CenterMaster>,
    context?: LogenExecutionContext,
  ): Promise<LogenBatchRegistrationResult[]>;
  printBatchWaybills(
    batches: LogenBatch[],
    printerName: string,
    context?: LogenExecutionContext,
  ): Promise<LogenBatchWaybillResult[]>;
  inspectBatchWaybills?(
    batches: LogenBatch[],
    context?: LogenExecutionContext,
  ): Promise<LogenBatchWaybillInspectionResult[]>;
  getReadiness?(
    action: LogenAction,
    context: LogenExecutionContext,
  ): Promise<LogenReadiness> | LogenReadiness;
  close?(): Promise<void>;
}

export interface ParcelUploadSubmission {
  status: "prepared" | "confirmed" | "failed" | "unknown";
  uploadNumber?: string;
  message: string;
}

export interface SupplierHubShipmentUploadInput {
  fileName: string;
  filePath: string;
  expectedInboundDate: string;
  shipDate: string;
  shipTime: string;
  /** false이면 파일 첨부와 요약까지만 확인하고 외부 업로드는 제출하지 않는다. */
  submit?: boolean;
  shipLocationLabel?: string;
  expectedGroupCount: number;
  shipmentGroups: Array<{
    orderNo: string;
    centerCode: string;
    expectedInboundDate: string;
  }>;
}

export interface SupplierHubShipmentSummary {
  shipmentId: string;
  orderNo: string;
  centerCode: string;
  expectedInboundDate: string;
}

export interface SupplierHubShipmentPort {
  uploadTrackingWorkbook(
    input: SupplierHubShipmentUploadInput,
  ): Promise<ParcelUploadSubmission>;
  inspectTrackingWorkbook?(
    fileName: string,
  ): Promise<ParcelUploadSubmission | undefined>;
  listShipmentSummaries(
    expectedInboundDate: string,
    orderNos?: string[],
  ): Promise<SupplierHubShipmentSummary[]>;
  getShipmentDocuments(input: {
    shipmentId: string;
    centerCode: string;
    expectedInboundDate: string;
    outputDir: string;
  }): Promise<ShipmentDocumentResult["documents"]>;
  close?(): Promise<void>;
}

export interface ShipmentWorkbookPort {
  build(input: {
    runId: string;
    orders: FulfillmentOrder[];
    batches: LogenBatch[];
    cartons: FulfillmentCarton[];
  }): Promise<{ fileName: string; filePath: string }>;
}

export interface OrderConfirmationWorkbookPort {
  prepare(input: {
    runId: string;
    sourceFileName: string;
    sourceFilePath: string;
    orderNos: string[];
  }): Promise<PreparedOrderConfirmationWorkbook>;
}

export interface SupplierHubFulfillmentPort {
  open(): Promise<FulfillmentConnectionResult>;
  listOrders(query: FulfillmentOrderQuery): Promise<FulfillmentOrderListResult>;
  downloadOrderConfirmationTemplate(
    runId: string,
    orders: FulfillmentOrder[],
  ): Promise<DownloadedOrderConfirmationTemplate>;
  uploadOrderConfirmationWorkbook(input: {
    runId: string;
    fileName: string;
    filePath: string;
    orderNos: string[];
  }): Promise<OrderConfirmationUploadResult>;
  getOrderStatuses(orderNos: string[]): Promise<Record<string, string>>;
  downloadOrderFiles(
    runId: string,
    orders: FulfillmentOrder[],
  ): Promise<DownloadedOrderFile[]>;
  registerShipmentTracking(
    orderNo: string,
    slipNos: string[],
  ): Promise<ShipmentTrackingResult>;
  getShipmentDocuments(
    orderNo: string,
    shipmentId?: string,
  ): Promise<ShipmentDocumentResult>;
  close?(): Promise<void>;
}

export interface LogenPort {
  openRegistration?(
    context?: LogenExecutionContext,
  ): Promise<FulfillmentConnectionResult>;
  openSingleOrderRegistration?(
    context?: LogenExecutionContext,
  ): Promise<FulfillmentConnectionResult>;
  openWaybill?(
    context?: LogenExecutionContext,
  ): Promise<FulfillmentConnectionResult>;
  registerOrders(jobs: ShippingJob[], sender: SenderProfile, centers: CenterMaster[]): Promise<LogenRegistrationResult[]>;
  printWaybills(jobs: ShippingJob[], printerName: string): Promise<LogenWaybillResult[]>;
  close?(): Promise<void>;
}

export interface FulfillmentPrinterPort {
  print(input: {
    files: Array<{
      fileName: string;
      filePath: string;
      documentType?: "shipment_label" | "shipment_statement";
    }>;
    printerName: string;
    copies: number;
    kind: "order" | "shipment";
  }): Promise<PrintSubmission>;
}
