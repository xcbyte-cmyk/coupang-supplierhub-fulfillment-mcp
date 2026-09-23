/** Shared transport only. Review gates and workflow state stay in app.js. */
function createWorkflowApi(fetchImpl = (...args) => fetch(...args)) {
  async function request(path, options = {}) {
    const response = await fetchImpl(path, {
      ...options,
      headers: { "x-workflow-ui": "supplierhub-dashboard", ...options.headers },
    });
    const text = await response.text();
    let payload;
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      throw new Error(response.ok ? "서버 응답을 읽지 못했습니다. 다시 확인하세요." : text || `HTTP ${response.status}`);
    }
    if (!response.ok) throw new Error(payload?.error || `HTTP ${response.status}`);
    return payload;
  }

  return {
    getStatus: () => request("/api/fulfillment/status"),
    postTool: (tool, input = {}, options = {}) => request(`/api/fulfillment/tools/${encodeURIComponent(tool)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
      signal: options.signal,
    }),
  };
}
