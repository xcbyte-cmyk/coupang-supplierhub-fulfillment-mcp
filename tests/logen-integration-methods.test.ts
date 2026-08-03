import { describe, expect, it } from "vitest";
import { LogenAgent } from "../src/fulfillment-mode-router.js";
import { LogenOpenApiAdapter } from "../src/logen-api-adapter.js";
import type {
  CenterMaster,
  LogenBatch,
  LogenBatchPort,
  LogenBatchRegistrationResult,
  LogenBatchWaybillResult,
  LogenExecutionContext,
  LogenPort,
  LogenRegistrationResult,
  LogenWaybillResult,
  SenderProfile,
  ShippingJob,
} from "../src/fulfillment-types.js";

const AT = "2026-07-30T06:00:00.000Z";

describe("Logen integration methods", () => {
  it("reports exactly which Open API prerequisites are missing", () => {
    const adapter = new LogenOpenApiAdapter({ environment: "test" });

    expect(adapter.getReadiness("register", { integrationMethod: "api" })).toEqual({
      ready: false,
      message:
        "필수 API 설정이 없습니다: LOGEN_API_USER_ID, LOGEN_CUSTOMER_CODE, LOGEN_API_SECRET_KEY",
    });
  });

  it("registers a PO-SKU batch through the official test API contract", async () => {
    const requests: Array<{ url: string; init: RequestInit; body: Record<string, unknown> }> = [];
    const adapter = new LogenOpenApiAdapter({
      environment: "test",
      userId: "99999999",
      customerCode: "99999999",
      secretKey: "test-secret",
      now: () => new Date(AT),
      fetchImpl: async (input, init) => {
        requests.push({
          url: String(input),
          init: init ?? {},
          body: JSON.parse(String(init?.body)) as Record<string, unknown>,
        });
        return new Response(
          JSON.stringify({
            sttsCd: "SUCCESS",
            sttsMsg: "1건 성공",
            data: [{ fixTakeNo: "PO-1-SKU-1", resultCd: "TRUE", resultMsg: null }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });

    const result = await adapter.registerBatches(
      [batch()],
      sender(),
      { "PO-1": center("저장 주소") },
      { integrationMethod: "api" },
    );

    expect(result).toMatchObject([
      { batchId: "batch-1", success: true, status: "registered" },
    ]);
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe(
      "https://topenapi.ilogen.com/lrm02b-edi/edi/registerOrderData",
    );
    expect(new Headers(requests[0].init.headers).get("secretKey")).toBe("test-secret");
    expect(requests[0].body).toMatchObject({
      userId: "99999999",
      data: [
        {
          custCd: "99999999",
          takeDt: "20260730",
          fixTakeNo: "PO-1-SKU-1",
          rcvCustAddr: "저장 주소",
          qty: 2,
        },
      ],
    });
  });

  it("keeps API invoice printing blocked until the popup MCP is calibrated", () => {
    const adapter = new LogenOpenApiAdapter({
      environment: "test",
      userId: "99999999",
      customerCode: "99999999",
      secretKey: "test-secret",
    });

    const readiness = adapter.getReadiness("print", { integrationMethod: "api" });

    expect(readiness.ready).toBe(false);
    expect(readiness.message).toContain("외부 출력 팝업");
  });

  it("routes live calls to the API or website MCP adapter selected by the Logen Agent", async () => {
    const demo = new RecordingChannel("demo");
    const api = new RecordingChannel("api");
    const website = new RecordingChannel("website_mcp");
    const agent = new LogenAgent(
      async () => "live",
      demo,
      { api, website_mcp: website },
    );
    const batches = [batch()];

    await agent.registerBatches(batches, sender(), { "PO-1": center("API 주소") }, {
      integrationMethod: "api",
    });
    await agent.registerBatches(batches, sender(), { "PO-1": center("웹 주소") }, {
      integrationMethod: "website_mcp",
    });

    expect(api.registerContexts).toEqual(["api"]);
    expect(website.registerContexts).toEqual(["website_mcp"]);
    expect(demo.registerContexts).toEqual([]);
  });
});

class RecordingChannel implements LogenPort, LogenBatchPort {
  registerContexts: string[] = [];

  constructor(private readonly name: string) {}

  getReadiness() {
    return { ready: true, message: `${this.name} ready` };
  }

  async registerBatches(
    batches: LogenBatch[],
    _sender: SenderProfile,
    _centers: Record<string, CenterMaster>,
    context?: LogenExecutionContext,
  ): Promise<LogenBatchRegistrationResult[]> {
    this.registerContexts.push(context?.integrationMethod ?? "none");
    return batches.map((item) => ({
      batchId: item.id,
      fixTakeNo: item.fixTakeNo,
      success: true,
      status: "registered",
      message: this.name,
    }));
  }

  async printBatchWaybills(
    batches: LogenBatch[],
  ): Promise<LogenBatchWaybillResult[]> {
    return batches.map((item) => ({
      batchId: item.id,
      fixTakeNo: item.fixTakeNo,
      slipNos: ["12345678901", "12345678902"],
      success: true,
      status: "submitted",
      message: this.name,
    }));
  }

  async registerOrders(_jobs: ShippingJob[]): Promise<LogenRegistrationResult[]> {
    return [];
  }

  async printWaybills(_jobs: ShippingJob[]): Promise<LogenWaybillResult[]> {
    return [];
  }
}

function batch(): LogenBatch {
  return {
    id: "batch-1",
    runId: "run-1",
    orderNo: "PO-1",
    skuCode: "SKU-1",
    skuName: "상품 1",
    orderedQuantity: 20,
    unitsPerCarton: 10,
    cartonCount: 2,
    fixTakeNo: "PO-1-SKU-1",
    status: "ready",
    createdAt: AT,
    updatedAt: AT,
  };
}

function sender(): SenderProfile {
  return {
    name: "테스트 공급사",
    address: "경기도 광주시 송하인로 1",
    telephone: "031-000-0000",
    customerCode: "99999999",
    fareType: "030",
    deliveryFare: 0,
    updatedAt: AT,
  };
}

function center(address: string): CenterMaster {
  return {
    centerCode: "FC-1",
    centerName: "센터 1",
    recipientName: "센터 담당자",
    address,
    telephone: "031-111-1111",
    source: "backend",
    updatedAt: AT,
  };
}
