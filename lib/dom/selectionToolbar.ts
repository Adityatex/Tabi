// lib/dom/selectionToolbar.ts
// The toolbar on selected text: select some words on a page and a small bar
// offers Ask, Explain, Translate and Summarize, and the answer shows in a
// card beside the text, without opening the side panel. "Continue in panel"
// takes the question and answer there.
//
// Like the cue (pageCue.ts), it lives in a closed shadow root on <html>,
// outside <body>: page styles can't reach it, and the agent's snapshot and
// page text never include it. Nothing is sent anywhere until a button is
// pressed. It doesn't show for text being typed (inputs, editors).

import { renderMarkdown } from '@/lib/utils/markdown';
import type { SelectionKind } from '@/lib/api/llmClient';

/** Shortest and longest selection it shows for. */
const MIN_CHARS = 2;
const MAX_CHARS = 6000;
/** Summarize only offers itself for a passage, not a word or two. */
const SUMMARIZE_CHARS = 280;
const GAP = 8;
const CARD_WIDTH = 380;

export interface SelectionToolbarOptions {
  /** Ask the model; resolves with its Markdown answer. */
  run: (kind: SelectionKind, text: string, around: string, question?: string) => Promise<string>;
  /** Open the side panel with this question and answer. */
  onContinue: (question: string, answer: string) => void;
  onHideSite: () => void;
  onTurnOff: () => void;
  onSettings: () => void;
  doc?: Document;
}

export interface SelectionToolbar {
  /** Show for selections (true), or never (false: off, or hidden on this site). */
  setEnabled(on: boolean): void;
  /** "light", "dark", or follow the system. */
  setTheme(theme: 'light' | 'dark' | 'system'): void;
  destroy(): void;
}

const TITLES: Record<SelectionKind, string> = { ask: 'Ask', explain: 'Explain', translate: 'Translate', summarize: 'Summary' };

const ICON = {
  ask: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/></svg>',
  explain: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5"/><path d="M9 18h6"/><path d="M10 22h4"/></svg>',
  translate: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 8 6 6"/><path d="m4 14 6-6 2-3"/><path d="M2 5h12"/><path d="M7 2h1"/><path d="m22 22-5-10-5 10"/><path d="M14 18h6"/></svg>',
  summarize: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 12h-5"/><path d="M15 8h-5"/><path d="M19 17V5a2 2 0 0 0-2-2H4"/><path d="M8 21h12a2 2 0 0 0 2-2v-1a1 1 0 0 0-1-1H11a1 1 0 0 0-1 1v1a2 2 0 1 1-4 0V5a2 2 0 1 0-4 0v2a1 1 0 0 0 1 1h3"/></svg>',
  more: '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>',
  close: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>',
  send: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12 7-7 7 7"/><path d="M12 19V5"/></svg>',
};

/** The Tabi mark, still (as in pageCue.ts), at 14px. */
const MARK = [[0.11, 0.24, 0.27, 0.34], [0.44, 0.08, 0.43, 0.84]]
  .map(([l, t, w, h]) => `<i style="left:${l * 14}px;top:${t * 14}px;width:${w * 14}px;height:${h * 14}px;border-radius:${(w * 14) / 2}px"></i>`).join('');

const LIGHT = '--accent:#2B45D8;--accent-text:#FFFFFF;--accent-soft:#E5E9FB;--raised:#FFFFFF;--surface:#FFFFFF;--bg:#F6F6F4;--border:#E3E3DF;--border-strong:#CFCFCA;--text:#121212;--muted:#5F5F5B;--red:#C2271D;';
const DARK = '--accent:#8394FF;--accent-text:#0B0F33;--accent-soft:#1A2050;--raised:#202023;--surface:#171719;--bg:#0F0F10;--border:#2D2D31;--border-strong:#3D3D42;--text:#F1F1EF;--muted:#9D9DA4;--red:#FF6E61;';

const CSS = `
:host { all: initial; }
.root { ${LIGHT} font: 400 13px/1.45 'Geist Variable', Geist, system-ui, -apple-system, 'Segoe UI', sans-serif; color: var(--text); -webkit-font-smoothing: antialiased; }
@media (prefers-color-scheme: dark) { .root:not(.light) { ${DARK} } }
.root.dark { ${DARK} }
.bar, .card { position: fixed; pointer-events: auto; background: var(--raised); border: 1px solid var(--border); box-shadow: 0 8px 28px rgba(0,0,0,.18); box-sizing: border-box; }
.bar { display: flex; align-items: center; gap: 2px; height: 34px; padding: 0 4px 0 8px; border-radius: 8px; white-space: nowrap; user-select: none; }
.card { width: ${CARD_WIDTH}px; max-width: calc(100vw - 16px); border-radius: 10px; display: flex; flex-direction: column; max-height: min(60vh, 520px); }
[hidden] { display: none !important; }
.mark { position: relative; width: 14px; height: 14px; transform: rotate(15deg); flex: none; margin-right: 4px; }
.mark i { position: absolute; background: var(--accent); }
button { all: unset; box-sizing: border-box; display: inline-flex; align-items: center; gap: 5px; height: 26px; padding: 0 8px; border-radius: 6px;
  font: inherit; font-size: 12.5px; font-weight: 500; cursor: pointer; color: var(--text); }
button:hover { background: var(--bg); }
button:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
button svg { color: var(--muted); flex: none; }
.icon { width: 26px; padding: 0; justify-content: center; }
.sep { width: 1px; height: 18px; background: var(--border); margin: 0 3px; }
.menu { position: fixed; pointer-events: auto; background: var(--raised); border: 1px solid var(--border); border-radius: 8px; padding: 4px;
  box-shadow: 0 8px 24px rgba(0,0,0,.16); display: flex; flex-direction: column; min-width: 190px; }
.menu button { height: 30px; width: 100%; }
.askrow { display: flex; align-items: center; gap: 6px; flex: 1; }
input { all: unset; box-sizing: border-box; flex: 1; min-width: 220px; height: 26px; font: inherit; font-size: 13px; color: var(--text); }
input::placeholder { color: var(--muted); }
.send { width: 26px; padding: 0; justify-content: center; background: var(--accent); color: var(--accent-text); }
.send svg { color: inherit; }
.send:hover { background: var(--accent); opacity: .9; }
.head { display: flex; align-items: center; gap: 6px; padding: 10px 8px 0 12px; }
.title { font-weight: 600; font-size: 12.5px; flex: 1; display: flex; align-items: center; gap: 6px; }
.quote { margin: 6px 12px 0; padding-left: 8px; border-left: 2px solid var(--border-strong); color: var(--muted); font-size: 12px;
  overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
.body { padding: 8px 12px 10px; overflow-y: auto; scrollbar-width: thin; overflow-wrap: anywhere; font-size: 13.5px; line-height: 1.55; }
.status { color: var(--muted); font-size: 12.5px; display: flex; align-items: center; gap: 7px; }
.dot { width: 6px; height: 6px; border-radius: 50%; background: var(--accent); animation: pulse 1s ease-in-out infinite; }
@keyframes pulse { 0%, 100% { opacity: .35 } 50% { opacity: 1 } }
.error { color: var(--red); font-size: 12.5px; }
.foot { display: flex; align-items: center; gap: 4px; padding: 6px 8px; border-top: 1px solid var(--border); }
.foot .grow { flex: 1; }
.primary { color: var(--accent); font-weight: 600; }
.answer > * + * { margin-top: 8px; }
.answer p, .answer ul, .answer ol, .answer h2, .answer h3, .answer h4, .answer pre, .answer blockquote { margin: 0; }
.answer strong { font-weight: 600; }
.answer a { color: var(--accent); }
.answer .md-h1, .answer .md-h2, .answer .md-h3 { font-size: 13.5px; font-weight: 600; }
.answer .md-ul, .answer .md-ol { padding-left: 20px; }
.answer li + li { margin-top: 3px; }
.answer .inline-code, .answer .code-block { font-family: 'Geist Mono Variable', ui-monospace, monospace; font-size: 12px; background: var(--bg); border: 1px solid var(--border); border-radius: 4px; }
.answer .inline-code { padding: 0 3px; }
.answer .code-block { display: block; padding: 6px 8px; white-space: pre-wrap; }
.answer .md-quote { border-left: 2px solid var(--border-strong); padding-left: 8px; color: var(--muted); }
.answer .md-table { overflow-x: auto; border: 1px solid var(--border); border-radius: 4px; }
.answer table { border-collapse: collapse; width: 100%; font-size: 12.5px; }
.answer th, .answer td { padding: 4px 7px; text-align: left; border-top: 1px solid var(--border); }
.answer thead th { border-top: 0; background: var(--bg); }
@media (prefers-reduced-motion: reduce) { .dot { animation: none; } }
`;

/** True if the selection is in something being typed into, or in Tabi's own UI. */
function inEditable(node: Node | null): boolean {
  const el = node && (node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement);
  if (!el) return false;
  return !!el.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"], [role="textbox"], tabi-selection, tabi-cue')
    || (el as HTMLElement).isContentEditable;
}

/** The passage a selection is in: its nearest block's text. */
export function passageAround(range: Range, max = 2000): string {
  const node = range.commonAncestorContainer;
  let el = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
  el = el?.closest('p, li, td, th, blockquote, pre, article, section, div') ?? el;
  const text = ((el as HTMLElement | null)?.innerText ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export function createSelectionToolbar(opts: SelectionToolbarOptions): SelectionToolbar {
  const doc = opts.doc ?? document;
  const win = doc.defaultView ?? window;
  const host = doc.createElement('tabi-selection');
  host.setAttribute('style', 'all: initial; position: fixed; top: 0; left: 0; width: 0; height: 0; z-index: 2147483646; pointer-events: none;');
  const shadow = host.attachShadow({ mode: 'closed' });
  shadow.innerHTML = `<style>${CSS}</style>
    <div class="root">
      <div class="bar" role="toolbar" aria-label="Tabi: selected text" hidden>
        <div class="tools" style="display:contents">
          <span class="mark" aria-hidden="true">${MARK}</span>
          <button type="button" data-action="ask">${ICON.ask}Ask</button>
          <button type="button" data-action="explain">${ICON.explain}Explain</button>
          <button type="button" data-action="translate">${ICON.translate}Translate</button>
          <button type="button" data-action="summarize">${ICON.summarize}Summarize</button>
          <span class="sep" aria-hidden="true"></span>
          <button type="button" class="icon" data-action="more" aria-label="More" aria-haspopup="menu" aria-expanded="false">${ICON.more}</button>
        </div>
        <form class="askrow" hidden>
          <span class="mark" aria-hidden="true">${MARK}</span>
          <input type="text" placeholder="Ask about the selected text" aria-label="Ask about the selected text">
          <button type="submit" class="send" data-action="send" aria-label="Ask">${ICON.send}</button>
        </form>
      </div>
      <div class="menu" role="menu" hidden>
        <button type="button" role="menuitem" data-action="hide-site"></button>
        <button type="button" role="menuitem" data-action="turn-off">Turn off everywhere</button>
        <button type="button" role="menuitem" data-action="settings">Settings…</button>
      </div>
      <div class="card" role="dialog" aria-label="Tabi" hidden>
        <div class="head"><span class="title"></span><button type="button" class="icon" data-action="close" aria-label="Close">${ICON.close}</button></div>
        <div class="quote"></div>
        <div class="body" aria-live="polite"></div>
        <div class="foot">
          <button type="button" data-action="copy">Copy</button>
          <span class="grow"></span>
          <button type="button" class="primary" data-action="continue">Continue in panel</button>
        </div>
      </div>
    </div>`;
  const $ = <T extends Element>(sel: string) => shadow.querySelector(sel) as T;
  const root = $<HTMLElement>('.root');
  const bar = $<HTMLElement>('.bar');
  const tools = $<HTMLElement>('.tools');
  const askRow = $<HTMLFormElement>('.askrow');
  const input = $<HTMLInputElement>('input');
  const menu = $<HTMLElement>('.menu');
  const card = $<HTMLElement>('.card');
  const title = $<HTMLElement>('.title');
  const quote = $<HTMLElement>('.quote');
  const body = $<HTMLElement>('.body');
  const foot = $<HTMLElement>('.foot');
  const button = (action: string) => $<HTMLButtonElement>(`[data-action="${action}"]`);

  let enabled = false;
  /** The selection the bar is for, kept while the user types a question (which clears it). */
  let text = '';
  let rect: DOMRect | null = null;
  /** The passage the selection is in, for context. */
  let around = '';
  /** The question and answer in the card, for Copy and Continue. */
  let current: { question: string; answer?: string } | null = null;
  /** Only the latest request may fill the card. */
  let request = 0;

  const state = () => {
    // For tests: the shadow root is closed
    host.dataset.state = !card.hidden ? (current?.answer !== undefined ? 'answer' : 'card') : !bar.hidden ? 'bar' : 'none';
  };

  const mount = () => { if (!host.isConnected) doc.documentElement.appendChild(host); };

  const hideAll = () => {
    bar.hidden = true;
    menu.hidden = true;
    card.hidden = true;
    askRow.hidden = true;
    tools.style.display = 'contents';
    button('more').setAttribute('aria-expanded', 'false');
    current = null;
    request++;
    host.remove();
    state();
  };

  /** Put an element next to the selection: below it, or above if there's no room below. */
  const place = (el: HTMLElement, anchor: DOMRect, preferAbove: boolean) => {
    const { width, height } = el.getBoundingClientRect();
    const vw = win.innerWidth;
    const vh = win.innerHeight;
    const left = Math.min(Math.max(GAP, anchor.left), Math.max(GAP, vw - width - GAP));
    const above = anchor.top - height - GAP;
    const below = anchor.bottom + GAP;
    const top = preferAbove ? (above >= GAP ? above : Math.min(below, vh - height - GAP)) : (below + height <= vh - GAP ? below : Math.max(GAP, above));
    el.style.left = `${left}px`;
    el.style.top = `${Math.max(GAP, top)}px`;
  };

  const showBar = () => {
    if (!rect) return;
    mount();
    card.hidden = true;
    menu.hidden = true;
    askRow.hidden = true;
    tools.style.display = 'contents';
    button('summarize').hidden = text.length < SUMMARIZE_CHARS;
    bar.hidden = false;
    place(bar, rect, true);
    state();
  };

  const showCard = async (kind: SelectionKind, question?: string) => {
    if (!rect) return;
    const asked = kind === 'ask' ? question! : `${TITLES[kind]}: “${text.length > 60 ? `${text.slice(0, 59)}…` : text}”`;
    current = { question: asked };
    bar.hidden = true;
    menu.hidden = true;
    title.innerHTML = `<span class="mark" aria-hidden="true">${MARK}</span>${kind === 'ask' ? 'Tabi' : TITLES[kind]}`;
    quote.textContent = kind === 'ask' ? `${question} · about “${text}”` : text;
    body.innerHTML = '<div class="status"><span class="dot"></span>Thinking…</div>';
    foot.hidden = true;
    card.hidden = false;
    place(card, rect, false);
    state();
    const mine = ++request;
    try {
      const answer = await opts.run(kind, text, around, question);
      if (mine !== request) return;
      current = { question: asked, answer };
      body.innerHTML = `<div class="answer">${renderMarkdown(answer)}</div>`;
      foot.hidden = false;
    } catch (err) {
      if (mine !== request) return;
      body.innerHTML = '';
      const error = doc.createElement('div');
      error.className = 'error';
      error.textContent = (err as Error)?.message || 'Something went wrong.';
      body.appendChild(error);
    }
    if (!card.hidden) place(card, rect, false);
    state();
  };

  // Keep the page's selection when the bar's buttons are pressed
  bar.addEventListener('mousedown', (e) => { if (!(e.target as Element).closest('input')) e.preventDefault(); });
  menu.addEventListener('mousedown', (e) => e.preventDefault());

  bar.addEventListener('click', (e) => {
    const action = (e.target as Element).closest('button')?.dataset.action;
    if (!action) return;
    if (action === 'ask') {
      tools.style.display = 'none';
      askRow.hidden = false;
      input.value = '';
      if (rect) place(bar, rect, true);
      input.focus();
    } else if (action === 'more') {
      const open = menu.hidden;
      menu.hidden = !open;
      button('more').setAttribute('aria-expanded', String(open));
      if (open) {
        let site = '';
        try { site = new URL(win.location.href).hostname.replace(/^www\./, ''); } catch { /* not a web page */ }
        button('hide-site').textContent = site ? `Don’t show on ${site}` : 'Don’t show on this site';
        place(menu, bar.getBoundingClientRect(), false);
      }
    } else if (action === 'explain' || action === 'translate' || action === 'summarize') {
      showCard(action);
    }
  });
  askRow.addEventListener('submit', (e) => {
    e.preventDefault();
    const question = input.value.trim();
    if (question) showCard('ask', question);
  });
  menu.addEventListener('click', (e) => {
    const action = (e.target as Element).closest('button')?.dataset.action;
    if (!action) return;
    hideAll();
    if (action === 'hide-site') opts.onHideSite();
    else if (action === 'turn-off') opts.onTurnOff();
    else if (action === 'settings') opts.onSettings();
  });
  card.addEventListener('click', (e) => {
    const btn = (e.target as Element).closest('button');
    const action = btn?.dataset.action;
    if (action === 'close') hideAll();
    else if (action === 'copy' && current?.answer) {
      win.navigator.clipboard?.writeText(current.answer).then(() => {
        btn!.textContent = 'Copied';
        setTimeout(() => { btn!.textContent = 'Copy'; }, 1500);
      }).catch(() => {});
    } else if (action === 'continue' && current?.answer !== undefined) {
      opts.onContinue(current.question, current.answer);
      hideAll();
    }
  });

  /** After a selection ends: show the bar for it, if it's text being read. */
  const onSelectionEnd = () => {
    if (!enabled) return;
    // Let the selection settle (a click inside it collapses it a moment later)
    win.setTimeout(() => {
      const selection = win.getSelection();
      const picked = selection && !selection.isCollapsed && selection.rangeCount ? selection.toString().trim() : '';
      if (picked.length < MIN_CHARS || picked.length > MAX_CHARS || inEditable(selection!.anchorNode) || inEditable(selection!.focusNode)) {
        // A click elsewhere: the bar goes, a card with an answer stays until closed
        if (card.hidden) hideAll();
        return;
      }
      const range = selection!.getRangeAt(0);
      const box = range.getBoundingClientRect();
      if (box.width === 0 && box.height === 0) return;
      text = picked;
      around = passageAround(range);
      rect = box;
      showBar();
    }, 10);
  };

  const onMouseUp = (e: MouseEvent) => {
    if (e.button !== 0 || e.composedPath().includes(host)) return;
    onSelectionEnd();
  };
  const onKeyUp = (e: KeyboardEvent) => {
    // Selecting with the keyboard: Shift with arrows, Home/End, or Ctrl+A
    if (e.shiftKey || (e.key === 'a' && (e.ctrlKey || e.metaKey))) onSelectionEnd();
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'Escape' || !host.isConnected) return;
    if (!menu.hidden) { menu.hidden = true; return; }
    hideAll();
  };
  const onMouseDown = (e: MouseEvent) => {
    if (!host.isConnected || e.composedPath().includes(host)) return;
    // A click on the page closes the bar and menu; a card closes too, unless it's still thinking
    if (!card.hidden && current && current.answer === undefined) return;
    hideAll();
  };
  const onScroll = () => {
    // The bar is for where the selection was; a card stays where it is
    if (!bar.hidden && card.hidden && doc.activeElement !== host) hideAll();
  };

  doc.addEventListener('mouseup', onMouseUp, true);
  doc.addEventListener('keyup', onKeyUp, true);
  doc.addEventListener('keydown', onKeyDown, true);
  doc.addEventListener('mousedown', onMouseDown, true);
  win.addEventListener('scroll', onScroll, true);
  state();

  return {
    setEnabled(on) {
      enabled = on;
      if (!on) hideAll();
    },
    setTheme(theme) {
      root.classList.toggle('light', theme === 'light');
      root.classList.toggle('dark', theme === 'dark');
    },
    destroy() {
      hideAll();
      doc.removeEventListener('mouseup', onMouseUp, true);
      doc.removeEventListener('keyup', onKeyUp, true);
      doc.removeEventListener('keydown', onKeyDown, true);
      doc.removeEventListener('mousedown', onMouseDown, true);
      win.removeEventListener('scroll', onScroll, true);
    },
  };
}
