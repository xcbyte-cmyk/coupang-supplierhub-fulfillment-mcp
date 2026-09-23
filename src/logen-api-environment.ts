import type { LogenOpenApiConfig } from "./logen-api-adapter.js";

export type LogenOpenApiEnvironmentConfig = Pick<
  LogenOpenApiConfig,
  "environment" | "userId" | "customerCode" | "secretKey"
>;

/** Resolve the official Logen API settings while preserving the existing local alias. */
export function resolveLogenOpenApiEnvironment(
  environment: NodeJS.ProcessEnv,
): LogenOpenApiEnvironmentConfig {
  const customerCode = nonEmpty(environment.LOGEN_CUSTOMER_CODE);
  return {
    environment: environment.LOGEN_API_ENVIRONMENT === "live" ? "live" : "test",
    userId: nonEmpty(environment.LOGEN_API_USER_ID) ?? customerCode,
    customerCode,
    secretKey:
      nonEmpty(environment.LOGEN_API_SECRET_KEY) ??
      nonEmpty(environment.LOGEN_REST_API),
  };
}

function nonEmpty(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}
