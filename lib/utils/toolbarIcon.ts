// The toolbar icon: the mark in one colour (dark ink on a light toolbar,
// light ink on a dark one), never animated, with an amber dot while a task
// needs you. Chrome has no light/dark icons in the manifest, so pages report
// the colour scheme and the background worker swaps the icon.
// Icons: public/icons, made by `npm run icons`.

export type Scheme = 'light' | 'dark';

/** The path dictionary for chrome.action.setIcon. */
export function toolbarIconPaths(scheme: Scheme, needsYou: boolean): Record<string, string> {
  const name = `toolbar-${scheme}${needsYou ? '-waiting' : ''}`;
  return { 16: `/icons/${name}-16.png`, 32: `/icons/${name}-32.png` };
}

/** Tabs whose task is waiting for the user (an approval, a check-in, or it looks stuck). */
export class Attention {
  private tabs = new Set<number>();

  /** Track a tab's latest run status; returns true if "anything needs you" changed. */
  update(tabId: number, status: string | undefined): boolean {
    const before = this.tabs.size > 0;
    if (status === 'paused') this.tabs.add(tabId);
    else this.tabs.delete(tabId);
    return before !== this.tabs.size > 0;
  }

  get needed(): boolean {
    return this.tabs.size > 0;
  }
}

/** From a page: tell the worker the colour scheme now and whenever it changes. */
export function reportColorScheme(): void {
  const query = matchMedia('(prefers-color-scheme: dark)');
  const report = () => browser.runtime.sendMessage({ action: 'COLOR_SCHEME', payload: query.matches ? 'dark' : 'light' }).catch(() => {});
  report();
  query.addEventListener('change', report);
}
