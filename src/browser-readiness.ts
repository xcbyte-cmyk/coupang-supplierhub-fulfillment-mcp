import type { Locator, Page } from "playwright-core";

export async function waitForTableIdle(page: Page): Promise<void> {
  // Target the site's table loading indicator, not unrelated network traffic.
  await page.locator(".ant-spin-spinning:visible, [aria-busy='true']:visible").first()
    .waitFor({ state: "hidden", timeout: 15_000 });
}

export async function rowSignature(rows: Locator): Promise<string> {
  return JSON.stringify(await rows.allTextContents());
}

/** A next-page click must change the rows before the caller may collect them. */
export async function waitForChangedRows(page: Page, rows: Locator, previous: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    await waitForTableIdle(page);
    const current = await rowSignature(rows);
    if (current !== previous && (JSON.parse(current) as string[]).some(text => text.trim())) {
      await new Promise(resolve => setTimeout(resolve, 200));
      await waitForTableIdle(page);
      if (await rowSignature(rows) === current) return;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error("다음 페이지의 목록 갱신을 확인하지 못했습니다. 이전 목록을 결과에 추가하지 않았습니다.");
}

/** Poll observations only. Never retry a click, upload, save or print. */
export async function waitForVisibleCandidates(locator: Locator, timeoutMs = 5_000): Promise<Locator[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const visible: Locator[] = [];
    for (let index = 0, count = await locator.count(); index < count; index++) {
      const candidate = locator.nth(index);
      if (await candidate.isVisible()) visible.push(candidate);
    }
    // Multiple candidates are ambiguous; do not choose the first or hide the error.
    if (visible.length || Date.now() >= deadline) return visible;
    await new Promise(resolve => setTimeout(resolve, Math.min(100, Math.max(0, deadline - Date.now()))));
  }
}

/** Share only in-flight initialization. A failed attempt can be tried again. */
export class SingleFlight<T> {
  private pending?: Promise<T>;
  run(start: () => Promise<T>): Promise<T> {
    if (this.pending) return this.pending;
    const pending = Promise.resolve().then(start).finally(() => {
      if (this.pending === pending) this.pending = undefined;
    });
    this.pending = pending;
    return pending;
  }
}
