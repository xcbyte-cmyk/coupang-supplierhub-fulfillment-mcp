import { describe, expect, it } from "vitest";
import {
  closeSupplierDatePicker,
  DEFAULT_SUPPLIER_SELECTORS,
  locateFinalAgreementCheckbox,
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

  it("targets only the exact search-button label", () => {
    expect(DEFAULT_SUPPLIER_SELECTORS.orderSearchButton).toBe(
      'button:text-is("검색")',
    );
  });

  it("closes the date popup before search", async () => {
    let visible = true;
    const popup = {
      count: async () => visible ? 1 : 0,
      nth: () => ({ isVisible: async () => visible }),
      first: () => ({
        waitFor: async () => { visible = false; },
      }),
    };
    const page = {
      locator: () => popup,
      keyboard: { press: async (key: string) => expect(key).toBe("Escape") },
    };

    await expect(closeSupplierDatePicker(page as never)).resolves.toBeUndefined();
    expect(visible).toBe(false);
  });

  it("blocks search when the date popup remains open", async () => {
    const popup = {
      count: async () => 1,
      nth: () => ({ isVisible: async () => true }),
      first: () => ({ waitFor: async () => { throw new Error("timeout"); } }),
    };
    const page = {
      locator: () => popup,
      keyboard: { press: async () => undefined },
    };

    await expect(closeSupplierDatePicker(page as never)).rejects.toThrow(
      "날짜 선택창이 닫히지 않았습니다",
    );
  });

  it("retries until the delayed final agreement checkbox is rendered", async () => {
    const finalCheckbox = { isVisible: async () => true };
    let configuredPolls = 0;
    const configured = {
      count: async () => {
        configuredPolls += 1;
        return configuredPolls >= 2 ? 1 : 0;
      },
      nth: () => finalCheckbox,
    };
    const empty = {
      count: async () => 0,
      nth: () => finalCheckbox,
      locator: () => empty,
    };
    const page = {
      locator: () => configured,
      getByRole: () => empty,
      getByText: () => empty,
    };

    await expect(
      locateFinalAgreementCheckbox(
        page as never,
        DEFAULT_SUPPLIER_SELECTORS.confirmationUploadAgreementCheckbox,
      ),
    ).resolves.toBe(finalCheckbox);
    expect(configuredPolls).toBeGreaterThanOrEqual(2);
  });
});
