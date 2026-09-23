import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
for (const candidate of [
  join(projectRoot, ".env"),
  resolve(projectRoot, "..", "..", ".env"),
]) {
  if (existsSync(candidate)) process.loadEnvFile(candidate);
}

const customerCode = nonEmpty(process.env.LOGEN_CUSTOMER_CODE);
const userId = nonEmpty(process.env.LOGEN_API_USER_ID) ?? customerCode;
const secretKey =
  nonEmpty(process.env.LOGEN_API_SECRET_KEY) ??
  nonEmpty(process.env.LOGEN_REST_API);
const environment = process.env.LOGEN_API_ENVIRONMENT === "live" ? "live" : "test";
const baseUrl =
  environment === "live"
    ? "https://openapi.ilogen.com/lrm02b-edi/edi"
    : "https://topenapi.ilogen.com/lrm02b-edi/edi";
const endpoint = `${baseUrl}/registerOrderData`;

const missing = [];
if (!userId) missing.push("LOGEN_API_USER_ID 또는 LOGEN_CUSTOMER_CODE");
if (!customerCode) missing.push("LOGEN_CUSTOMER_CODE");
if (!secretKey) missing.push("LOGEN_API_SECRET_KEY 또는 LOGEN_REST_API");
if (missing.length > 0) {
  output({
    status: "blocked",
    environment,
    orderPayloadCount: 0,
    message: `필수 설정이 없습니다: ${missing.join(", ")}`,
  });
  process.exitCode = 2;
} else {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        secretKey,
      },
      body: JSON.stringify({ userId, data: [] }),
      signal: controller.signal,
    });
    const raw = await response.text();
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = undefined;
    }
    output({
      status: response.ok ? "connected" : "blocked",
      environment,
      endpoint,
      httpStatus: response.status,
      apiStatus: parsed?.sttsCd,
      apiMessage: parsed?.sttsMsg,
      resultCount: Array.isArray(parsed?.data) ? parsed.data.length : 0,
      orderPayloadCount: 0,
      message: response.ok
        ? "개발계 HTTPS·방화벽·인증키 응답을 확인했습니다. 주문 데이터는 전송하지 않았습니다."
        : "로젠 API가 요청을 거부했습니다. 방화벽 허용 IP와 인증키 상태를 확인하세요.",
    });
    if (!response.ok) process.exitCode = 2;
  } catch (error) {
    output({
      status: "blocked",
      environment,
      endpoint,
      orderPayloadCount: 0,
      reason: error?.name === "AbortError" ? "timeout" : "connection_error",
      networkCode: error?.cause?.code,
      networkMessage: error?.cause?.message,
      message:
        error?.name === "AbortError"
          ? "20초 동안 개발계 응답이 없습니다. 로젠 방화벽 IP 허용이 완료되지 않았을 가능성이 큽니다."
          : String(error?.message ?? error),
    });
    process.exitCode = 2;
  } finally {
    clearTimeout(timeout);
  }
}

function nonEmpty(value) {
  const normalized = value?.trim();
  return normalized || undefined;
}

function output(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}
