// Whether the toolbar on selected text (lib/dom/selectionToolbar.ts) shows,
// and the sites it stays off. On by default. Read by the content script on
// every page and changed from the toolbar's own menu or Settings.

import { matchesRule, normalizeSite } from '@/lib/agent/sites';

export const SELECTION_KEY = 'tabi_selection';

export interface SelectionPrefs {
  enabled: boolean;
  /** Writing tools (Improve, Fix grammar...) on text selected in text boxes. */
  writing: boolean;
  /** Sites (and their subdomains) it doesn't show on. */
  hiddenOn: string[];
}

export const DEFAULT_SELECTION: SelectionPrefs = { enabled: true, writing: true, hiddenOn: [] };

export function cleanSelectionPrefs(raw: unknown): SelectionPrefs {
  const r = (raw ?? {}) as Partial<SelectionPrefs>;
  return {
    enabled: r.enabled !== false,
    writing: r.writing !== false,
    hiddenOn: Array.isArray(r.hiddenOn) ? r.hiddenOn.filter((s): s is string => typeof s === 'string' && !!s) : [],
  };
}

/** Whether the toolbar shows on this page. */
export function selectionShowsOn(prefs: SelectionPrefs, url: string): boolean {
  if (!prefs.enabled) return false;
  const site = normalizeSite(url);
  return !site || !prefs.hiddenOn.some((rule) => matchesRule(site, rule));
}

/** Where it shows on this page: for text being read, and for text being written in a text box. */
export function selectionModesOn(prefs: SelectionPrefs, url: string): { reading: boolean; writing: boolean } {
  const on = selectionShowsOn(prefs, url);
  return { reading: on, writing: on && prefs.writing };
}

export async function loadSelectionPrefs(): Promise<SelectionPrefs> {
  return cleanSelectionPrefs((await browser.storage.local.get(SELECTION_KEY))[SELECTION_KEY]);
}

/** Change the prefs: turn it (or its writing tools) on or off, or hide it on a site (`hide`) or show it there again (`show`). */
export async function updateSelectionPrefs(change: { enabled?: boolean; writing?: boolean; hide?: string; show?: string }): Promise<SelectionPrefs> {
  const prefs = await loadSelectionPrefs();
  if (change.enabled !== undefined) prefs.enabled = change.enabled;
  if (change.writing !== undefined) prefs.writing = change.writing;
  const hide = change.hide ? normalizeSite(change.hide) : null;
  if (hide && !prefs.hiddenOn.includes(hide)) prefs.hiddenOn.push(hide);
  if (change.show) prefs.hiddenOn = prefs.hiddenOn.filter((s) => s !== change.show);
  await browser.storage.local.set({ [SELECTION_KEY]: prefs });
  return prefs;
}
