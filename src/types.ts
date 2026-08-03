export type WorkflowMode = "demo" | "live";

export type OrderStage =
  | "baseline"
  | "discovered"
  | "awaiting_approval"
  | "preparing"
  | "printing"
  | "printed"
  | "held"
  | "failed";

export type BatchStatus =
  | "awaiting_approval"
  | "preparing"
  | "printing"
  | "completed"
  | "held"
  | "failed";

export interface SupplierOrder {
  orderNo: string;
  poType: string;
  orderType: string;
  status: string;
  createdAt: string;
  transportType: string;
  firstSkuName: string;
  skuCount: number;
  center: string;
  quantity: number;
  expectedInboundDate: string;
  source: WorkflowMode;
}

export interface ManagedOrder extends SupplierOrder {
  stage: OrderStage;
  firstSeenAt: string;
  updatedAt: string;
  batchId?: string;
  fileHash?: string;
  printedAt?: string;
  lastError?: string;
}

export interface PreparedFile {
  orderNo: string;
  fileName: string;
  filePath: string;
  sha256: string;
  sizeBytes: number;
}

export interface PrintBatch {
  id: string;
  orderNos: string[];
  status: BatchStatus;
  createdAt: string;
  updatedAt: string;
  files: PreparedFile[];
  printerName: string;
  copies: number;
  error?: string;
}

export interface WorkflowSettings {
  mode: WorkflowMode;
  scheduleEnabled: boolean;
  intervalMinutes: number;
  windowStart: string;
  windowEnd: string;
  printerName: string;
  copies: number;
  lookAheadDays: number;
  firstLiveScanIsBaseline: boolean;
}

export interface WorkflowLog {
  id: string;
  at: string;
  level: "info" | "warning" | "error" | "success";
  event: string;
  message: string;
}

export interface WorkflowState {
  version: 1;
  initialized: boolean;
  settings: WorkflowSettings;
  orders: ManagedOrder[];
  batches: PrintBatch[];
  logs: WorkflowLog[];
  lastScanAt?: string;
  lastSuccessfulScanAt?: string;
  lastError?: string;
}

export interface ConnectionStatus {
  status: "ready" | "login_required" | "error";
  message: string;
  url?: string;
}

export interface PrintResult {
  success: boolean;
  submittedFiles: string[];
  message: string;
}

export interface DashboardSummary {
  newOrders: number;
  awaitingApproval: number;
  printing: number;
  completed: number;
  failed: number;
}

export interface WorkflowDashboard {
  settings: WorkflowSettings;
  summary: DashboardSummary;
  orders: ManagedOrder[];
  batches: PrintBatch[];
  logs: WorkflowLog[];
  initialized: boolean;
  lastScanAt?: string;
  lastSuccessfulScanAt?: string;
  lastError?: string;
  connection: {
    mode: WorkflowMode;
    supplierHub: "demo" | "unknown" | "login_required" | "ready" | "error";
    printer: "dry_run" | "configured";
  };
}

export interface WorkflowReply {
  message: string;
  dashboard: WorkflowDashboard;
}

export interface ScanResult {
  orders: SupplierOrder[];
  connection: ConnectionStatus;
}

export interface SupplierHubPort {
  openLogin(): Promise<ConnectionStatus>;
  scan(settings: WorkflowSettings): Promise<ScanResult>;
  prepare(orderNos: string[], batchId: string): Promise<PreparedFile[]>;
  close?(): Promise<void>;
}

export interface PrinterPort {
  print(files: PreparedFile[], settings: WorkflowSettings): Promise<PrintResult>;
}

export interface StateStore {
  read(): Promise<WorkflowState>;
  update(mutator: (state: WorkflowState) => WorkflowState | void): Promise<WorkflowState>;
}
