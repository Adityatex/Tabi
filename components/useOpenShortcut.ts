// Tabi's keyboard shortcuts (open Tabi, ask about the selection), as the browser has them now. Only the
// user can set it, on the browser's own shortcuts page (an extension can
// suggest one at install, not change it), so pages read it rather than
// assume the manifest's suggestion, and read it again when they come back
// into view, e.g. from that page.
import { useEffect, useState } from 'react';

declare const navigator: Navigator & { brave?: unknown };

/** The manifest command that opens the side panel (the toolbar button's action). */
const OPEN_COMMAND = '_execute_action';

/** The command that asks about the selected text (lib/dom/selectionToolbar.ts). */
export const ASK_COMMAND = 'ask-selection';

/** "Alt+T", or '' when none is set (or the browser took it for one of its own). */
async function commandShortcut(name: string = OPEN_COMMAND): Promise<string> {
  const commands = await browser.commands.getAll();
  return commands.find((c) => c.name === name)?.shortcut ?? '';
}

/** The browser's page for extension shortcuts: Chrome's, or Edge's and Brave's own. */
export function shortcutsPage(): string {
  if (/\bEdg\//.test(navigator.userAgent)) return 'edge://extensions/shortcuts';
  if (navigator.brave) return 'brave://extensions/shortcuts';
  return 'chrome://extensions/shortcuts';
}

/** A command's current shortcut (opening Tabi, by default); undefined until it has been read. */
export function useOpenShortcut(name: string = OPEN_COMMAND): string | undefined {
  const [shortcut, setShortcut] = useState<string>();
  useEffect(() => {
    const read = () => { commandShortcut(name).then(setShortcut).catch(() => setShortcut('')); };
    read();
    const onVisible = () => { if (document.visibilityState === 'visible') read(); };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', read);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', read);
    };
  }, [name]);
  return shortcut;
}
