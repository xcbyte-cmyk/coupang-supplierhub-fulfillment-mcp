export type FulfillmentExperience = "beginner" | "expert";

/** Both experiences use the same controls, API contracts and persisted run. */
export function renderFulfillmentPage(html: string, experience: FulfillmentExperience): string {
  return html.replace('<body data-experience="expert">', `<body data-experience="${experience}">`)
    .replace("<title>Supplier Hub Fulfillment</title>", `<title>발주·배송 ${experience === "beginner" ? "초보자용" : "전문가용"}</title>`);
}
