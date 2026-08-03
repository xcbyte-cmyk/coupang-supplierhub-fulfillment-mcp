import { describe, expect, it } from "vitest";

import { shipmentDocumentPlacement } from "../src/fulfillment-adapters.js";

describe("Supplier Hub shipment print policy", () => {
  it("keeps shipment labels at their actual 4x6 size on A4", () => {
    expect(
      shipmentDocumentPlacement({
        fileName: "49040509_창원1_Label.pdf",
        documentType: "shipment_label",
      }),
    ).toBe("actual");
  });

  it("uses the full A4 page for shipment statements", () => {
    expect(
      shipmentDocumentPlacement({
        fileName: "49040509_창원1_내역서.pdf",
        documentType: "shipment_statement",
      }),
    ).toBe("full_page");
  });

  it("blocks an unclassified shipment PDF before printing", () => {
    expect(() =>
      shipmentDocumentPlacement({ fileName: "49040509_창원1.pdf" }),
    ).toThrow("쉽먼트 문서 종류를 판별할 수 없습니다");
  });
});
