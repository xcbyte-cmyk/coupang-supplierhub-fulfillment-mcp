import AdmZip from "adm-zip";
import type {
  CenterMaster,
  FulfillmentOrder,
  FulfillmentOrderItem,
  OrderFileSenderProfile,
} from "./fulfillment-types.js";

export interface ShipmentWorkbookData {
  orders: FulfillmentOrder[];
  sender?: OrderFileSenderProfile;
}

/**
 * Reads the Supplier Hub shipment workbook as data. It deliberately does not
 * validate workbook structure, hashes, row counts, or PO/file-name matching.
 */
export function readOrdersFromShipmentWorkbook(filePath: string): FulfillmentOrder[] {
  return readShipmentWorkbookData(filePath).orders;
}

/**
 * Reads order rows and the sender identity from the same Supplier Hub workbook.
 * Sender extraction supports both table headers and label/value print layouts.
 */
export function readShipmentWorkbookData(filePath: string): ShipmentWorkbookData {
  const zip = new AdmZip(filePath);
  const sharedStrings = readSharedStrings(zip);
  const grouped = new Map<string, FulfillmentOrder>();
  let sender: Partial<OrderFileSenderProfile> = {};

  for (const entry of zip.getEntries()) {
    const normalized = entry.entryName.replaceAll("\\", "/");
    if (!/^xl\/worksheets\/[^/]+\.xml$/i.test(normalized)) continue;
    const rows = readWorksheetRows(entry.getData().toString("utf8"), sharedStrings);
    sender = {
      ...sender,
      ...readSenderFromRows(rows, sender),
      ...readPrintLayoutSender(rows),
    };
    const headerIndex = rows.findIndex((row) => {
      const values = [...row.values()].map(String);
      return values.some((value) => /PO ID|발주번호/i.test(value)) &&
        values.some((value) => /SKU ID|상품번호/i.test(value));
    });
    if (headerIndex < 0) {
      const printOrder = readPrintLayoutOrder(rows);
      if (printOrder) grouped.set(printOrder.orderNo, printOrder);
      continue;
    }

    const header = rows[headerIndex];
    const columns = locateColumns(header);
    if (columns.orderNo === undefined || columns.skuCode === undefined) continue;
    for (const row of rows.slice(headerIndex + 1)) {
      const orderNo = textValue(cell(row, columns.orderNo));
      const skuCode = textValue(cell(row, columns.skuCode));
      if (!orderNo || !skuCode) continue;
      const orderedQuantity = numberValue(cell(row, columns.confirmedQuantity));
      if (!Number.isFinite(orderedQuantity) || orderedQuantity <= 0) continue;
      const shippedQuantity = numberValue(cell(row, columns.shippedQuantity));
      const centerName = textValue(cell(row, columns.center)) || "미지정 센터";
      const centerMaster = readCenterMaster(row, columns, centerName);
      const existing = grouped.get(orderNo) ?? {
        orderNo,
        centerCode: centerName,
        centerName,
        status: "발주확정",
        transportType: textValue(cell(row, columns.transportType)) || "쉽먼트",
        createdAt: "",
        expectedInboundDate: textValue(cell(row, columns.expectedInboundDate)),
        items: [],
        centerMaster,
      };
      if (!existing.centerMaster && centerMaster) existing.centerMaster = centerMaster;
      const existingItem = existing.items.find((item) => item.skuCode === skuCode);
      if (existingItem) {
        if (!existingItem.unitsPerCarton && shippedQuantity > 0) {
          existingItem.unitsPerCarton = shippedQuantity;
        }
      } else {
        const item: FulfillmentOrderItem = {
          skuCode,
          skuName: textValue(cell(row, columns.skuName)) || skuCode,
          barcode: textValue(cell(row, columns.barcode)) || undefined,
          orderedQuantity,
          unitsPerCarton: shippedQuantity > 0 ? shippedQuantity : undefined,
          source: "order_file",
        };
        existing.items.push(item);
      }
      grouped.set(orderNo, existing);
    }
  }
  return {
    orders: [...grouped.values()],
    sender: completeSender(sender),
  };
}

function readPrintLayoutSender(
  rows: Array<Map<number, string>>,
): Partial<OrderFileSenderProfile> {
  const name = normalizeVendorName(valueAfterLabel(rows, /^거래처명$/i));
  const address = valueAfterLabel(rows, /^회송지주소$/i);
  const telephone = valueAfterLabel(rows, /^전화번호$/i);
  const mobile = valueAfterLabel(rows, /^회송담당자연락처$/i);
  return {
    name: name || undefined,
    address: address || undefined,
    telephone: telephone || mobile || undefined,
    mobile: mobile || undefined,
  };
}

function readPrintLayoutOrder(
  rows: Array<Map<number, string>>,
): FulfillmentOrder | undefined {
  const orderNo = valueAfterLabel(rows, /^발주번호$/i);
  if (!orderNo) return undefined;

  const centerHeaderIndex = rows.findIndex((row) => {
    const values = [...row.values()].map(textValue);
    return values.some((value) => value === "물류센터") &&
      values.some((value) => value === "주소") &&
      values.some((value) => value === "입고예정일시");
  });
  const centerHeader = centerHeaderIndex >= 0 ? rows[centerHeaderIndex] : undefined;
  const centerColumns = centerHeader
    ? locatePrintColumns(centerHeader, {
        center: /^물류센터$/i,
        address: /^주소$/i,
        recipientTelephone: /^택배수령담당자$/i,
      })
    : {};
  const expectedInboundDateColumns = centerHeader
    ? [...centerHeader.entries()]
        .filter(([, value]) => /^입고예정일시$/i.test(textValue(value)))
        .map(([column]) => column)
    : [];
  const centerRow = centerHeaderIndex >= 0
    ? rows.slice(centerHeaderIndex + 1).find((row) =>
        Boolean(textValue(cell(row, centerColumns.center))),
      )
    : undefined;
  const centerName = textValue(cell(centerRow ?? new Map(), centerColumns.center)) || "미지정 센터";
  const centerAddress = stripContactSuffix(
    textValue(cell(centerRow ?? new Map(), centerColumns.address)),
  );
  const centerTelephone = textValue(
    cell(centerRow ?? new Map(), centerColumns.recipientTelephone),
  );
  const expectedInboundDate = normalizeWorkbookDate(
    expectedInboundDateColumns
      .map((column) => textValue(cell(centerRow ?? new Map(), column)))
      .find(Boolean) ?? "",
  );
  const centerMaster = centerAddress && centerTelephone
    ? {
        centerCode: centerName,
        centerName,
        recipientName: centerName,
        address: centerAddress,
        telephone: centerTelephone,
        source: "order_file" as const,
        updatedAt: new Date().toISOString(),
      }
    : undefined;

  const productHeaderIndex = rows.findIndex((row) => {
    const values = [...row.values()].map(textValue);
    return values.some((value) => value === "상품코드") &&
      values.some((value) => value.includes("상품명")) &&
      values.some((value) => value === "발주수량");
  });
  const items: FulfillmentOrderItem[] = [];
  if (productHeaderIndex >= 0) {
    const productColumns = locatePrintColumns(rows[productHeaderIndex], {
      number: /^No\.?$/i,
      skuCode: /^상품코드$/i,
      skuName: /^상품명/i,
      orderedQuantity: /^발주수량$/i,
    });
    const productRows = rows.slice(productHeaderIndex + 1);
    for (let index = 0; index < productRows.length; index += 1) {
      const row = productRows[index];
      const firstValue = textValue(cell(row, productColumns.number));
      if (firstValue === "합계") break;
      const skuCode = textValue(cell(row, productColumns.skuCode));
      const orderedQuantity = numberValue(cell(row, productColumns.orderedQuantity));
      if (!skuCode || !orderedQuantity) continue;
      const skuName = textValue(cell(row, productColumns.skuName)) || skuCode;
      const detailRow = productRows[index + 1];
      const detailValue = detailRow
        ? textValue(cell(detailRow, productColumns.skuName))
        : "";
      items.push({
        skuCode,
        skuName,
        barcode: detailValue && detailValue !== skuName ? detailValue : undefined,
        orderedQuantity,
        source: "order_file",
      });
    }
  }

  return {
    orderNo,
    centerCode: centerName,
    centerName,
    status: "발주확정",
    transportType: "쉽먼트",
    createdAt: "",
    expectedInboundDate,
    items,
    centerMaster,
  };
}

function locatePrintColumns<T extends string>(
  header: Map<number, string>,
  patterns: Record<T, RegExp>,
): Partial<Record<T, number>> {
  const result: Partial<Record<T, number>> = {};
  for (const [name, pattern] of Object.entries(patterns) as Array<[T, RegExp]>) {
    const match = [...header.entries()].find(([, value]) => pattern.test(textValue(value)));
    if (match) result[name] = match[0];
  }
  return result;
}

function valueAfterLabel(
  rows: Array<Map<number, string>>,
  labelPattern: RegExp,
): string {
  for (const row of rows) {
    const entries = [...row.entries()].sort(([left], [right]) => left - right);
    const labelIndex = entries.findIndex(([, value]) => labelPattern.test(textValue(value)));
    if (labelIndex < 0) continue;
    const value = entries
      .slice(labelIndex + 1)
      .map(([, candidate]) => textValue(candidate))
      .find(Boolean);
    if (value) return value;
  }
  return "";
}

function normalizeVendorName(value: string): string {
  return textValue(value)
    .replace(/^\[[^\]]+\]\s*/, "")
    .replace(/^[^_]+_/, "")
    .replace(/\s*\(CPLB\)\s*$/i, "")
    .trim();
}

function stripContactSuffix(value: string): string {
  return textValue(value).replace(/\s*\(택배수령담당자\s*:[^)]+\)\s*$/i, "").trim();
}

function normalizeWorkbookDate(value: string): string {
  const match = /^(\d{4})[/-](\d{2})[/-](\d{2})/.exec(textValue(value));
  return match ? `${match[1]}-${match[2]}-${match[3]}` : textValue(value);
}

type SenderField = keyof OrderFileSenderProfile;

const senderLabelPatterns: Array<[SenderField, RegExp]> = [
  [
    "name",
    /^(?:송하인(?:명|성명|상호)?|보내는(?:분|사람)(?:명|성명)?|출고지(?:명|업체명)?|판매자명|공급사명|업체명|회사명|상호)$/i,
  ],
  [
    "address",
    /^(?:(?:송하인|보내는(?:분|사람)|출고지|판매자|공급사|업체)(?:주소|소재지)|송하주소)$/i,
  ],
  [
    "telephone",
    /^(?:(?:송하인|보내는(?:분|사람)|출고지|판매자|공급사|업체)(?:전화번호|전화|연락처|TEL)|송하전화)$/i,
  ],
  [
    "mobile",
    /^(?:송하인|보내는(?:분|사람)|출고지|판매자|공급사|업체)(?:휴대폰번호|휴대전화|휴대폰|핸드폰)$/i,
  ],
  [
    "postalCode",
    /^(?:송하인|보내는(?:분|사람)|출고지|판매자|공급사|업체)(?:우편번호|우편번호코드)$/i,
  ],
  ["customerCode", /^(?:로젠)(?:거래처코드|고객코드|고객번호)$/i],
];

function readSenderFromRows(
  rows: Array<Map<number, string>>,
  initial: Partial<OrderFileSenderProfile>,
): Partial<OrderFileSenderProfile> {
  const result: Partial<OrderFileSenderProfile> = { ...initial };
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const entries = [...rows[rowIndex].entries()].sort(([left], [right]) => left - right);
    for (const [column, rawValue] of entries) {
      const inline = splitSenderLabelValue(rawValue);
      const field = inline?.field ?? senderFieldForLabel(rawValue);
      if (!field || result[field]) continue;
      const value = inline?.value || senderValueNear(rows, rowIndex, column);
      if (value) result[field] = value;
    }
  }
  return result;
}

function splitSenderLabelValue(
  rawValue: string,
): { field: SenderField; value: string } | undefined {
  const match = /^(.+?)\s*[:：]\s*(.+)$/.exec(textValue(rawValue));
  if (!match) return undefined;
  const field = senderFieldForLabel(match[1]);
  const value = textValue(match[2]);
  return field && value ? { field, value } : undefined;
}

function senderFieldForLabel(rawValue: string): SenderField | undefined {
  const label = textValue(rawValue)
    .replace(/[\s_[\](){},.·/\\-]+/g, "")
    .replace(/[:：]+$/, "");
  return senderLabelPatterns.find(([, pattern]) => pattern.test(label))?.[0];
}

function senderValueNear(
  rows: Array<Map<number, string>>,
  rowIndex: number,
  column: number,
): string | undefined {
  const sameRow = [...rows[rowIndex].entries()]
    .filter(([candidateColumn]) => candidateColumn > column)
    .sort(([left], [right]) => left - right)
    .map(([, value]) => textValue(value))
    .find(Boolean);
  if (sameRow && !senderFieldForLabel(sameRow)) return sameRow;

  for (let offset = 1; offset <= 3 && rowIndex + offset < rows.length; offset += 1) {
    const below = textValue(rows[rowIndex + offset].get(column));
    if (below && !senderFieldForLabel(below)) return below;
  }
  return undefined;
}

function completeSender(
  candidate: Partial<OrderFileSenderProfile>,
): OrderFileSenderProfile | undefined {
  const telephone = textValue(candidate.telephone) || textValue(candidate.mobile);
  if (!candidate.name || !candidate.address || !telephone) return undefined;
  return {
    name: textValue(candidate.name),
    address: textValue(candidate.address),
    telephone,
    mobile: textValue(candidate.mobile) || undefined,
    postalCode: textValue(candidate.postalCode) || undefined,
    customerCode: textValue(candidate.customerCode) || undefined,
  };
}

function readSharedStrings(zip: AdmZip): string[] {
  const entry = zip.getEntry("xl/sharedStrings.xml");
  if (!entry) return [];
  const xml = entry.getData().toString("utf8");
  return [...xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map((match) =>
    [...match[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)]
      .map((text) => decodeXml(text[1]))
      .join(""),
  );
}

function readWorksheetRows(xml: string, sharedStrings: string[]): Array<Map<number, string>> {
  const rows: Array<Map<number, string>> = [];
  for (const rowMatch of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const row = new Map<number, string>();
    for (const cellMatch of rowMatch[1].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
      const attributes = cellMatch[1];
      const body = cellMatch[2];
      const reference = /\br="([A-Z]+)\d+"/i.exec(attributes)?.[1];
      if (!reference) continue;
      const column = columnNumber(reference);
      const type = /\bt="([^"]+)"/i.exec(attributes)?.[1];
      let value = "";
      if (type === "inlineStr") {
        value = [...body.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)]
          .map((match) => decodeXml(match[1]))
          .join("");
      } else {
        const raw = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? "";
        value = type === "s" ? sharedStrings[Number(raw)] ?? "" : decodeXml(raw);
      }
      row.set(column, value);
    }
    rows.push(row);
  }
  return rows;
}

function locateColumns(header: Map<number, string>) {
  const find = (pattern: RegExp) =>
    [...header.entries()].find(([, value]) => pattern.test(String(value)))?.[0];
  return {
    orderNo: find(/PO ID|발주번호/i),
    center: find(/FC\)|센터|물류센터/i),
    transportType: find(/Transport Type|입고유형/i),
    expectedInboundDate: find(/EDD|입고예정/i),
    skuCode: find(/SKU ID|상품번호/i),
    barcode: find(/SKU Barcode|바코드/i),
    skuName: find(/SKU Name|상품이름|상품명/i),
    confirmedQuantity: find(/Confirmed Qty|확정수량/i),
    shippedQuantity: find(/Shipped Qty|출고수량/i),
    recipientName: find(/수하인명|수취인명|받는\s*분|받는\s*사람|센터\s*수취인/i),
    recipientAddress: find(/수하인\s*주소|수취\s*주소|배송지\s*주소|센터\s*주소/i),
    recipientTelephone: find(
      /수하인\s*(?:전화|연락처)|수취인\s*(?:전화|연락처)|받는\s*분\s*(?:전화|연락처)|센터\s*(?:전화|연락처)/i,
    ),
    recipientMobile: find(/수하인\s*휴대폰|수취인\s*휴대폰|받는\s*분\s*휴대폰/i),
    recipientPostalCode: find(/수하인\s*우편번호|수취\s*우편번호|배송지\s*우편번호/i),
  };
}

function readCenterMaster(
  row: Map<number, string>,
  columns: ReturnType<typeof locateColumns>,
  centerName: string,
): CenterMaster | undefined {
  const address = textValue(cell(row, columns.recipientAddress));
  const telephone = textValue(cell(row, columns.recipientTelephone));
  const mobile = textValue(cell(row, columns.recipientMobile));
  if (!address || (!telephone && !mobile)) return undefined;
  return {
    centerCode: centerName,
    centerName,
    recipientName: textValue(cell(row, columns.recipientName)) || centerName,
    address,
    telephone: telephone || mobile,
    mobile: mobile || undefined,
    postalCode: textValue(cell(row, columns.recipientPostalCode)) || undefined,
    source: "order_file",
    updatedAt: new Date().toISOString(),
  };
}

function columnNumber(letters: string): number {
  let result = 0;
  for (const character of letters.toUpperCase()) {
    result = result * 26 + character.charCodeAt(0) - 64;
  }
  return result;
}

function textValue(value: unknown): string {
  return value === null || value === undefined ? "" : String(value).trim();
}

function cell(row: Map<number, string>, column: number | undefined): string | undefined {
  return column === undefined ? undefined : row.get(column);
}

function numberValue(value: unknown): number {
  const parsed = Number(String(value ?? "").replaceAll(",", "").trim());
  return Number.isFinite(parsed) ? parsed : 0;
}

function decodeXml(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_match, code) =>
      String.fromCodePoint(Number.parseInt(code, 16)),
    )
    .replace(/&#(\d+);/g, (_match, code) =>
      String.fromCodePoint(Number.parseInt(code, 10)),
    )
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}
