import type { IncomingHttpHeaders } from "node:http";

export function isAllowedUiRequest(
  headers: IncomingHttpHeaders,
  host: string,
  port: number,
): boolean {
  if (headers["x-workflow-ui"] !== "supplierhub-dashboard") return false;
  const origin = headers.origin;
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    const allowedHosts = new Set([host, "localhost", "127.0.0.1", "[::1]"]);
    return (
      parsed.protocol === "http:" &&
      parsed.port === String(port) &&
      allowedHosts.has(parsed.hostname)
    );
  } catch {
    return false;
  }
}
