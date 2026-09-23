import { describe, expect, it } from "vitest";
import { resolveLogenOpenApiEnvironment } from "../src/logen-api-environment.js";

describe("Logen Open API environment", () => {
  it("accepts LOGEN_REST_API and falls back to the customer code for userId", () => {
    expect(
      resolveLogenOpenApiEnvironment({
        LOGEN_REST_API: "rest-secret",
        LOGEN_CUSTOMER_CODE: "37720630",
      }),
    ).toEqual({
      environment: "test",
      userId: "37720630",
      customerCode: "37720630",
      secretKey: "rest-secret",
    });
  });

  it("prefers the canonical API settings when both names exist", () => {
    expect(
      resolveLogenOpenApiEnvironment({
        LOGEN_API_ENVIRONMENT: "live",
        LOGEN_API_USER_ID: "12345678",
        LOGEN_CUSTOMER_CODE: "37720630",
        LOGEN_API_SECRET_KEY: "canonical-secret",
        LOGEN_REST_API: "legacy-secret",
      }),
    ).toEqual({
      environment: "live",
      userId: "12345678",
      customerCode: "37720630",
      secretKey: "canonical-secret",
    });
  });
});
