// components/useOpenShortcut.ts
// The keyboard shortcut that opens Tabi, as the browser has it now. Only the
// user can set it, on the browser's own shortcuts page (an extension can
// suggest one at install, not change it), so pages read it rather than
// assume the manifest's suggestion, and read it again when they come back
// into view, e.g. from that page.
import { useEffect, useState } from 'react';

declare const navigator: Navigator & { brave?: unknown };

/** The manifest command that opens the side panel (the toolbar button's action). */
const OPEN_COMMAND = '_execute_action';

/** "Alt+T", or '' when none is set (or the browser took it for one of its own). */
export async function openShortcut(): Promise<string> {
  const commands = await browser.commands.getAll();
  return commands.find((c) => c.name === OPEN_COMMAND)?.shortcut ?? '';
}

/** The browser's page for extension shortcuts: Chrome's, or Edge's and Brave's own. */
export function shortcutsPage(): string {
  if (/\bEdg\//.test(navigator.userAgent)) return 'edge://extensions/shortcuts';
  if (navigator.brave) return 'brave://extensions/shortcuts';
  return 'chrome://extensions/shortcuts';
}

/** The current shortcut; undefined until it has been read. */
export function useOpenShortcut(): string | undefined {
  const [shortcut, setShortcut] = useState<string>();
  useEffect(() => {
    const read = () => { openShortcut().then(setShortcut).catch(() => setShortcut('')); };
    read();
    const onVisible = () => { if (document.visibilityState === 'visible') read(); };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', read);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', read);
    };
  }, []);
  return shortcut;
}
