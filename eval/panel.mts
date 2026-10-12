// The end-to-end checks drive Tabi's side panel the way a user does. Chrome
// won't let a test open the real side panel, so the panel page opens in a
// window of its own, pinned to the test's tab (sidepanel.html?tab=<id>). It's
// the same page, the same code and the same messages to the background.

import type { BrowserContext, Page, Worker } from 'playwright';

declare const chrome: any;

/** The extension's id, from its service worker. */
export function extensionId(worker: Worker): string {
  return new URL(worker.url()).host;
}

/** Chrome's id for the tab showing `page`. */
export async function tabIdOf(worker: Worker, page: Page): Promise<number> {
  const url = page.url();
  for (let i = 0; i < 20; i++) {
    const id = await worker.evaluate((u: string) => chrome.tabs.query({}).then((tabs: any[]) => tabs.find((t) => t.url === u)?.id), url);
    if (typeof id === 'number') return id;
    await page.waitForTimeout(100);
  }
  throw new Error(`No tab found for ${url}`);
}

/**
 * Open the side panel for `page`'s tab, in its own small window so the test
 * page stays visible in its own. Returns the panel's page.
 */
export async function openPanel(context: BrowserContext, worker: Worker, page: Page): Promise<Page> {
  const tabId = await tabIdOf(worker, page);
  const opened = context.waitForEvent('page', { predicate: (p) => p.url().includes('/sidepanel.html'), timeout: 15_000 });
  await worker.evaluate((id: number) => chrome.windows.create({
    url: chrome.runtime.getURL(`/sidepanel.html?tab=${id}`), type: 'popup', width: 420, height: 860, focused: false,
  }), tabId);
  const panel = await opened;
  await panel.waitForLoadState('domcontentloaded');
  await panel.locator(`[data-panel-tab="${tabId}"]`).waitFor({ timeout: 15_000 });
  return panel;
}

/** The composer's box. */
export function composer(panel: Page) {
  return panel.getByRole('textbox', { name: 'Ask about this page or tell Tabi what to do' });
}

/** Type into the composer and send, as a user would; `background` runs it in a new tab. */
export async function sendTask(panel: Page, text: string, opts: { background?: boolean } = {}): Promise<void> {
  const box = composer(panel);
  if (opts.background) {
    const chip = panel.getByRole('button', { name: 'Background' });
    if ((await chip.getAttribute('aria-pressed')) !== 'true') await chip.click();
  }
  await box.fill(text);
  await box.press('Enter');
}

/** The current tab's run as the background reports it (what the panel shows), or null. */
export async function runState(panel: Page, tabId?: number): Promise<any> {
  const id = tabId ?? Number(await panel.locator('[data-panel-tab]').getAttribute('data-panel-tab'));
  return panel.evaluate((t: number) => chrome.runtime.sendMessage({ action: 'GET_AGENT_STATE', payload: { tabId: t } }).then((r: any) => r?.data ?? null), id).catch(() => null);
}
