// Light, dark, or the system's setting, for the side panel, Settings and
// History. Saved in chrome.storage.local and mirrored in localStorage, which
// all three pages share and can read before the first paint, so a page never
// flashes the wrong colours. The toolbar icon and the on-page cue follow the
// browser and the page, not this.

export type Theme = 'system' | 'light' | 'dark';
export const THEME_KEY = 'tabi_theme';
export const THEMES: [Theme, string][] = [['system', 'System'], ['light', 'Light'], ['dark', 'Dark']];

const valid = (value: unknown): value is Theme => value === 'system' || value === 'light' || value === 'dark';

/** data-theme="light|dark" on <html> overrides the system's setting (assets/tabi.css). */
export function applyTheme(theme: Theme, root: HTMLElement = document.documentElement): void {
  if (theme === 'system') delete root.dataset.theme;
  else root.dataset.theme = theme;
}

function cache(theme: Theme): void {
  try { localStorage.setItem(THEME_KEY, theme); } catch { /* storage blocked: the saved setting still applies */ }
}

/** Apply the saved theme now, and again whenever it changes in any page. */
export function initTheme(): void {
  try {
    const cached = localStorage.getItem(THEME_KEY);
    if (valid(cached)) applyTheme(cached);
  } catch { /* fall through to the saved setting */ }
  browser.storage.local.get(THEME_KEY).then((stored) => {
    const theme = valid(stored[THEME_KEY]) ? stored[THEME_KEY] : 'system';
    applyTheme(theme);
    cache(theme);
  }).catch(() => {});
  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !(THEME_KEY in changes)) return;
    const theme = valid(changes[THEME_KEY].newValue) ? changes[THEME_KEY].newValue : 'system';
    applyTheme(theme);
    cache(theme);
  });
}

export async function loadTheme(): Promise<Theme> {
  const stored = await browser.storage.local.get(THEME_KEY);
  return valid(stored[THEME_KEY]) ? stored[THEME_KEY] : 'system';
}

export async function saveTheme(theme: Theme): Promise<void> {
  await browser.storage.local.set({ [THEME_KEY]: theme });
}
