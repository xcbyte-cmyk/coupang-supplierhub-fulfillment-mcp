import { describe, expect, it } from "vitest";
import {
  DEFAULT_SUPPLIER_SELECTORS,
  SUPPLIER_PRIVATE_LABEL_URL,
  SUPPLIERHUB_LOGIN_BUTTON_NAME,
} from "../src/fulfillment-adapters.js";

describe("Supplier Hub Private Label URL", () => {
  it("uses the dedicated Private Label order-list route", () => {
    expect(SUPPLIER_PRIVATE_LABEL_URL).toBe(
      "https://supplier.coupang.com/po-web/cplb/po/list",
    );
  });

  it("recognizes the actual Private Label h3 heading", () => {
    expect(DEFAULT_SUPPLIER_SELECTORS.readyHeading).toContain(
      'h3:has-text("Private Label 발주 리스트")',
    );
  });

  it("targets only the exact Korean login button", () => {
    expect(SUPPLIERHUB_LOGIN_BUTTON_NAME).toBe("로그인");
  });

  it("targets the actual expected inbound date inputs", () => {
    expect(DEFAULT_SUPPLIER_SELECTORS.dateSearchTypeInput).toContain(
      'label:text-is("기간검색")',
    );
    expect(DEFAULT_SUPPLIER_SELECTORS.inboundDateStartInput).toContain(
      'placeholder="Start date"',
    );
    expect(DEFAULT_SUPPLIER_SELECTORS.inboundDateEndInput).toContain(
      'placeholder="End date"',
    );
  });
});
