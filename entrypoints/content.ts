// Tabi in the page: eyes and hands, the cue while a task runs here, and the
// toolbar on selected text (lib/dom/selectionToolbar.ts). The
// agent runner in the background reads the page (AGENT_SNAPSHOT) and acts on
// it (AGENT_EXECUTE) through this script, and the side panel asks it for the
// page's text or the selection. Cross-origin frames have their
// own script (frame.content.ts).

import { createPageSnapshot } from '@/lib/agent/frames';
import { executeAction } from '@/lib/agent/actionExecutor';
import { viewportMarks, describeElement, resolveElement, commitTarget, getElementById } from '@/lib/agent/domSnapshot';
import { extractVisibleText } from '@/lib/dom/extractVisibleText';
import { highlightText } from '@/lib/dom/highlightText';
import { reportColorScheme } from '@/lib/utils/toolbarIcon';
import { createPageCue, cueOf } from '@/lib/dom/pageCue';
import { createSelectionToolbar } from '@/lib/dom/selectionToolbar';
import { SELECTION_KEY, cleanSelectionPrefs, selectionModesOn, updateSelectionPrefs, type SelectionPrefs } from '@/lib/utils/selectionPrefs';
import { THEME_KEY } from '@/lib/utils/theme';

/** How long the cue steps aside while the background takes a screenshot for the model. */
const SCREENSHOT_MS = 1500;

export default defineContentScript({
  matches: ['<all_urls>'],

  main() {
    // The toolbar icon's ink follows the browser's light or dark theme
    reportColorScheme();

    // The cue (glow, pill, outline) while a task runs in this tab; a page
    // loaded mid-task asks what is going on
    const cue = createPageCue({
      onStop: () => { browser.runtime.sendMessage({ action: 'STOP_AGENT' }).catch(() => {}); },
      onReview: () => { browser.runtime.sendMessage({ action: 'OPEN_PANEL' }).catch(() => {}); },
      find: (id) => getElementById(id),
    });
    browser.runtime.sendMessage({ action: 'GET_AGENT_STATE' })
      .then((res: any) => cue.set(cueOf(res?.data)))
      .catch(() => {});

    // The toolbar on selected text: Ask, Explain, Translate, Summarize on text
    // being read; Improve, Fix grammar, tone... on text in a text box. Answers
    // stream into a small chat window on the page. On unless the user turned
    // it off, or off for this site.
    let language = 'English';
    try {
      language = new Intl.DisplayNames(['en'], { type: 'language' }).of(navigator.language.split('-')[0]) ?? language;
    } catch { /* an unusual locale: English */ }
    const selection = createSelectionToolbar({
      // One connection per answer: the background streams it back, and closing it stops the request
      stream: (request, onText, signal) => new Promise<string>((resolve, reject) => {
        const port = browser.runtime.connect({ name: 'tabi-selection' });
        let settled = false;
        const finish = (fn: () => void) => {
          if (settled) return;
          settled = true;
          fn();
          try { port.disconnect(); } catch { /* already closed */ }
        };
        port.onMessage.addListener((m: any) => {
          if (m?.type === 'text') onText(String(m.text ?? ''));
          else if (m?.type === 'done') finish(() => resolve(String(m.text ?? '')));
          else if (m?.type === 'error') finish(() => reject(new Error(m.message || 'Tabi couldn’t answer that.')));
        });
        port.onDisconnect.addListener(() => finish(() => reject(new Error('Tabi stopped answering. Reload the page and try again.'))));
        signal.addEventListener('abort', () => finish(() => reject(new Error('Stopped'))));
        port.postMessage({ type: 'start', request: { ...request, language, title: document.title, url: location.href } });
      }),
      onContinue: (pairs) => {
        browser.runtime.sendMessage({ action: 'OPEN_PANEL', payload: { answers: pairs } }).catch(() => {});
      },
      onHideSite: () => { updateSelectionPrefs({ hide: location.href }).catch(() => {}); },
      onTurnOff: () => { updateSelectionPrefs({ enabled: false }).catch(() => {}); },
      onTurnOffWriting: () => { updateSelectionPrefs({ writing: false }).catch(() => {}); },
      onSettings: () => { browser.runtime.sendMessage({ action: 'OPEN_SETTINGS', payload: { section: 'appearance' } }).catch(() => {}); },
    });
    const applySelectionPrefs = (prefs: SelectionPrefs) => selection.setEnabled(selectionModesOn(prefs, location.href));
    const applyTheme = (theme: unknown) => selection.setTheme(theme === 'light' || theme === 'dark' ? theme : 'system');
    browser.storage.local.get([SELECTION_KEY, THEME_KEY]).then((stored) => {
      applySelectionPrefs(cleanSelectionPrefs(stored[SELECTION_KEY]));
      applyTheme(stored[THEME_KEY]);
    }).catch(() => {});
    browser.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (SELECTION_KEY in changes) applySelectionPrefs(cleanSelectionPrefs(changes[SELECTION_KEY].newValue));
      if (THEME_KEY in changes) applyTheme(changes[THEME_KEY].newValue);
    });

    browser.runtime.onMessage.addListener((message: any, _sender, sendResponse) => {
      switch (message?.action) {
        case 'AGENT_PING':
          sendResponse({ ok: true });
          return;
        case 'SELECTION_SHORTCUT':
          // Alt+J (or the user's own key): ask about the selection, or about the page
          selection.askShortcut();
          sendResponse({ ok: true });
          return;
        case 'TABI_CUE':
          cue.set(message.state ?? null);
          sendResponse({ ok: true });
          return;
        case 'AGENT_SNAPSHOT':
          // A screenshot follows: the model sees the page, not the cue
          if (message.visual) cue.hideFor(SCREENSHOT_MS);
          // visual: also say where the numbered elements are, for a screenshot
          createPageSnapshot()
            .then(snapshot => sendResponse({
              text: snapshot.text,
              ...(message.visual ? {
                visual: {
                  marks: viewportMarks(),
                  viewport: { width: window.innerWidth, height: window.innerHeight },
                },
              } : {}),
            }))
            .catch(err => sendResponse({ text: `(could not read the page: ${err?.message ?? err})` }));
          return true; // async response
        case 'AGENT_EXECUTE':
          // The pill never sits on what the agent is about to click
          if (typeof message.payload?.elementId === 'number') cue.avoid(getElementById(message.payload.elementId));
          executeAction(message.payload)
            .then(result => sendResponse(result))
            .catch(err => sendResponse(`❌ ${err?.message ?? err}`));
          return true;
        case 'AGENT_DESCRIBE':
          // Workflows: an element's lasting description, recorded before acting on it
          sendResponse(describeElement(Number(message.id)));
          return;
        case 'AGENT_COMMIT_TARGET':
          // What a click or Enter would set off, to ask the user first if it can't be undone
          sendResponse(commitTarget(message.payload ?? {}));
          return;
        case 'AGENT_RESOLVE':
          // Workflows: find a recorded element again (after AGENT_SNAPSHOT)
          sendResponse({ id: resolveElement(message.target) });
          return;
        case 'PAGE_TEXT':
          // Answers and summaries in the side panel
          sendResponse({ text: extractVisibleText(), title: document.title });
          return;
        case 'HIGHLIGHT_TEXT':
          // A source of an answer, clicked in the side panel
          sendResponse({ found: highlightText(String(message.text ?? '')) });
          return;
        case 'PAGE_SELECTION':
          sendResponse({ text: window.getSelection()?.toString().trim() ?? '' });
          return;
      }
    });
  },
});
