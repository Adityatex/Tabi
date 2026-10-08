// lib/dom/selectionToolbar.ts
// The toolbar on selected text, like Sider's. Select words on a page and a
// small bar offers Ask, Explain, Translate, Summarize and Copy; select words
// you're writing in a text box and it offers Improve, Fix grammar, Shorter,
// a tone, or an edit you describe. The answer streams into a small chat
// window beside the text, where follow-up questions continue the
// conversation; a rewrite can replace the selection or go in below it.
// Alt+J (a manifest command) asks about the selection, or about the page when
// nothing is selected. "Continue in panel" takes the conversation there.
//
// Like the cue (pageCue.ts), it lives in a closed shadow root on <html>,
// outside <body>: page styles can't reach it, and the agent's snapshot and
// page text never include it. Nothing is sent anywhere until the user picks
// an action. Password fields are never touched.

import { renderMarkdown } from '@/lib/utils/markdown';
import { WRITING_ACTIONS, type SelectionAction, type SelectionRequest } from '@/lib/api/llmClient';

/** Shortest and longest selection it shows for. */
const MIN_CHARS = 2;
const MAX_CHARS = 6000;
/** Summarize only offers itself for a passage, not a word or two. */
const SUMMARIZE_CHARS = 280;
const GAP = 8;
const WIN_WIDTH = 400;
/** Text boxes it offers writing tools in (inputs of these types, and textareas). */
const WRITABLE_INPUTS = new Set(['', 'text', 'search', 'url']);
export const TONES = ['Professional', 'Friendly', 'Casual', 'Confident', 'Direct'];

/** What the page script sends for one answer (it adds the page's title, address and language). */
export type StreamRequest = Omit<SelectionRequest, 'title' | 'url' | 'language'>;

export interface SelectionToolbarOptions {
  /** Ask the model; onText gets the answer so far as it streams. Resolves with the whole answer. */
  stream: (request: StreamRequest, onText: (soFar: string) => void, signal: AbortSignal) => Promise<string>;
  /** Open the side panel with this conversation, as questions and answers. */
  onContinue: (pairs: { question: string; answer: string }[]) => void;
  onHideSite: () => void;
  onTurnOff: () => void;
  onTurnOffWriting: () => void;
  onSettings: () => void;
  doc?: Document;
}

export interface SelectionToolbar {
  /** Where it shows: for text being read, and for text being written. */
  setEnabled(on: { reading: boolean; writing: boolean }): void;
  setTheme(theme: 'light' | 'dark' | 'system'): void;
  /** The shortcut: ask about the selection, or about the page if nothing is selected. */
  askShortcut(): void;
  destroy(): void;
}

/** Where the selection is, to answer about it and to put a rewrite back. */
type Target =
  | { kind: 'page' }
  | { kind: 'field'; el: HTMLInputElement | HTMLTextAreaElement; start: number; end: number }
  | { kind: 'editable'; root: HTMLElement; range: Range };

interface Picked {
  text: string;
  around: string;
  rect: DOMRect;
  target: Target;
}

const TITLES: Record<SelectionAction, string> = {
  ask: 'Ask', explain: 'Explain', translate: 'Translate', summarize: 'Summary',
  improve: 'Improve writing', grammar: 'Fix grammar', shorter: 'Make shorter', longer: 'Make longer', tone: 'Change tone', edit: 'Edit',
};

const svg = (body: string, size = 14) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const ICON = {
  ask: svg('<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/>', 13),
  explain: svg('<path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5"/><path d="M9 18h6"/><path d="M10 22h4"/>'),
  translate: svg('<path d="m5 8 6 6"/><path d="m4 14 6-6 2-3"/><path d="M2 5h12"/><path d="M7 2h1"/><path d="m22 22-5-10-5 10"/><path d="M14 18h6"/>'),
  summarize: svg('<path d="M15 12h-5"/><path d="M15 8h-5"/><path d="M19 17V5a2 2 0 0 0-2-2H4"/><path d="M8 21h12a2 2 0 0 0 2-2v-1a1 1 0 0 0-1-1H11a1 1 0 0 0-1 1v1a2 2 0 1 1-4 0V5a2 2 0 1 0-4 0v2a1 1 0 0 0 1 1h3"/>'),
  copy: svg('<rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>'),
  check: svg('<path d="M20 6 9 17l-5-5"/>'),
  improve: svg('<path d="m21.64 3.64-1.28-1.28a1.21 1.21 0 0 0-1.72 0L2.36 18.64a1.21 1.21 0 0 0 0 1.72l1.28 1.28a1.2 1.2 0 0 0 1.72 0L21.64 5.36a1.2 1.2 0 0 0 0-1.72"/><path d="m14 7 3 3"/><path d="M5 6v4"/><path d="M19 14v4"/><path d="M10 2v2"/><path d="M7 8H3"/><path d="M21 16h-4"/><path d="M11 3H9"/>', 13),
  grammar: svg('<path d="m3 15 4-8 4 8"/><path d="M4 13h6"/><path d="m15 11 2 2 4-4"/>', 13),
  shorter: svg('<path d="M4 6h16"/><path d="M4 12h10"/><path d="M4 18h6"/>', 13),
  tone: svg('<path d="M2 10v3"/><path d="M6 6v11"/><path d="M10 3v18"/><path d="M14 8v7"/><path d="M18 5v13"/><path d="M22 10v3"/>', 13),
  edit: svg('<path d="M12 20h9"/><path d="M16.4 3.6a2.1 2.1 0 1 1 3 3L7 19l-4 1 1-4Z"/>', 13),
  more: '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>',
  chevron: svg('<path d="m6 9 6 6 6-6"/>', 11),
  close: svg('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>', 13),
  send: svg('<path d="m5 12 7-7 7 7"/><path d="M12 19V5"/>', 13),
  stop: '<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><rect x="1" y="1" width="8" height="8" rx="1.5" fill="currentColor"/></svg>',
  panel: svg('<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M15 3v18"/>', 13),
  retry: svg('<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>', 13),
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
[hidden] { display: none !important; }
.bar, .win, .menu { position: fixed; pointer-events: auto; background: var(--raised); border: 1px solid var(--border); box-shadow: 0 8px 28px rgba(0,0,0,.18); box-sizing: border-box; }
.bar { display: flex; align-items: center; gap: 1px; height: 34px; padding: 0 3px 0 8px; border-radius: 9px; white-space: nowrap; user-select: none; }
.mark { position: relative; width: 14px; height: 14px; transform: rotate(15deg); flex: none; margin-right: 4px; }
.mark i { position: absolute; background: var(--accent); }
button { all: unset; box-sizing: border-box; display: inline-flex; align-items: center; gap: 5px; height: 28px; padding: 0 8px; border-radius: 6px;
  font: inherit; font-size: 12.5px; font-weight: 500; cursor: pointer; color: var(--text); white-space: nowrap; }
button:hover { background: var(--bg); }
button:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
button svg { color: var(--muted); flex: none; }
button:hover svg { color: var(--text); }
.icon { width: 28px; padding: 0; justify-content: center; }
.sep { width: 1px; height: 18px; background: var(--border); margin: 0 3px; flex: none; }
.group { display: contents; }
.menu { border-radius: 8px; padding: 4px; display: flex; flex-direction: column; min-width: 180px; }
.menu button { height: 30px; width: 100%; }
.win { width: ${WIN_WIDTH}px; max-width: calc(100vw - 16px); border-radius: 12px; display: flex; flex-direction: column; max-height: min(70vh, 560px); }
.head { display: flex; align-items: center; gap: 4px; padding: 8px 6px 4px 12px; cursor: grab; user-select: none; touch-action: none; }
.head:active { cursor: grabbing; }
.title { font-weight: 600; font-size: 12.5px; flex: 1; display: flex; align-items: center; gap: 4px; min-width: 0; }
.title .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.quote { margin: 2px 12px 4px; padding-left: 8px; border-left: 2px solid var(--border-strong); color: var(--muted); font-size: 12px;
  overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
.thread { padding: 6px 12px 4px; overflow-y: auto; scrollbar-width: thin; display: flex; flex-direction: column; gap: 10px; min-height: 0; flex: 1; }
.thread:empty { display: none; }
.msg { overflow-wrap: anywhere; font-size: 13.5px; line-height: 1.55; }
.msg.user { align-self: flex-end; max-width: 85%; background: var(--bg); border: 1px solid var(--border); border-radius: 10px; padding: 6px 10px; font-size: 13px; white-space: pre-wrap; }
.msg.draft { white-space: pre-wrap; background: var(--bg); border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px; }
.status { color: var(--muted); font-size: 12.5px; display: flex; align-items: center; gap: 7px; }
.dot { width: 6px; height: 6px; border-radius: 50%; background: var(--accent); animation: pulse 1s ease-in-out infinite; }
@keyframes pulse { 0%, 100% { opacity: .35 } 50% { opacity: 1 } }
.msg.error { color: var(--red); font-size: 12.5px; }
.actions { display: flex; align-items: center; gap: 2px; padding: 0 8px 4px; flex-wrap: wrap; }
.primary { background: var(--accent); color: var(--accent-text); padding: 0 10px; }
.primary:hover { background: var(--accent); opacity: .92; }
.primary svg { color: inherit; }
.compose { display: flex; align-items: flex-end; gap: 6px; margin: 4px 8px 8px; padding: 5px 5px 5px 10px; border: 1px solid var(--border); border-radius: 9px; background: var(--bg); }
.compose:focus-within { border-color: var(--border-strong); }
textarea { all: unset; box-sizing: border-box; flex: 1; min-height: 22px; max-height: 120px; overflow-y: auto; font: inherit; font-size: 13px; line-height: 1.45; padding: 2px 0;
  color: var(--text); white-space: pre-wrap; overflow-wrap: anywhere; }
textarea::placeholder { color: var(--muted); }
.send { width: 26px; height: 26px; padding: 0; justify-content: center; background: var(--accent); color: var(--accent-text); flex: none; }
.send svg { color: inherit; }
.send:hover { background: var(--accent); opacity: .9; }
.send:disabled { background: var(--border); color: var(--muted); cursor: default; }
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

/** The passage a selection is in: its nearest block's text. */
export function passageAround(range: Range, max = 2000): string {
  const node = range.commonAncestorContainer;
  let el = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
  el = el?.closest('p, li, td, th, blockquote, pre, article, section, div') ?? el;
  const text = ((el as HTMLElement | null)?.innerText ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** Set a field's value so React, Angular and Vue notice (their own setter is on the prototype). */
function setFieldValue(el: HTMLInputElement | HTMLTextAreaElement, value: string, caret: number): void {
  const view = el.ownerDocument.defaultView ?? window;
  const proto = el.tagName === 'TEXTAREA' ? view.HTMLTextAreaElement.prototype : view.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setter) setter.call(el, value);
  else el.value = value;
  try { el.setSelectionRange(caret, caret); } catch { /* not every input type allows it */ }
  el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertReplacementText' }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

/** The element being edited, at the top of its contenteditable region. */
function editingHost(node: Node | null): HTMLElement | null {
  let el = node && (node.nodeType === Node.ELEMENT_NODE ? (node as HTMLElement) : node.parentElement);
  if (!el?.isContentEditable) return null;
  while (el.parentElement?.isContentEditable) el = el.parentElement;
  return el;
}

const isOwnUi = (node: Node | null) => {
  const el = node && (node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement);
  return !!el?.closest('tabi-selection, tabi-cue');
};

export function createSelectionToolbar(opts: SelectionToolbarOptions): SelectionToolbar {
  const doc = opts.doc ?? document;
  const win = doc.defaultView ?? window;
  const host = doc.createElement('tabi-selection');
  host.setAttribute('style', 'all: initial; position: fixed; top: 0; left: 0; width: 0; height: 0; z-index: 2147483646; pointer-events: none;');
  const shadow = host.attachShadow({ mode: 'closed' });
  shadow.innerHTML = `<style>${CSS}</style>
    <div class="root">
      <div class="bar" role="toolbar" aria-label="Tabi: selected text" hidden>
        <span class="mark" aria-hidden="true">${MARK}</span>
        <div class="group" data-mode="read">
          <button type="button" data-action="ask" title="Ask about it (Alt+J)">${ICON.ask}Ask</button>
          <button type="button" class="icon" data-action="explain" title="Explain" aria-label="Explain">${ICON.explain}</button>
          <button type="button" class="icon" data-action="translate" title="Translate" aria-label="Translate">${ICON.translate}</button>
          <button type="button" class="icon" data-action="summarize" title="Summarize" aria-label="Summarize">${ICON.summarize}</button>
          <button type="button" class="icon" data-action="copy" title="Copy" aria-label="Copy">${ICON.copy}</button>
        </div>
        <div class="group" data-mode="write">
          <button type="button" data-action="improve" title="Improve the writing">${ICON.improve}Improve</button>
          <button type="button" data-action="grammar" title="Fix spelling and grammar">${ICON.grammar}Fix grammar</button>
          <button type="button" class="icon" data-action="shorter" title="Make it shorter" aria-label="Make it shorter">${ICON.shorter}</button>
          <button type="button" data-action="tone" title="Change the tone" aria-haspopup="menu" aria-expanded="false">${ICON.tone}Tone${ICON.chevron}</button>
          <button type="button" class="icon" data-action="edit" title="Tell Tabi how to change it (Alt+J)" aria-label="Edit with instructions">${ICON.edit}</button>
        </div>
        <span class="sep" aria-hidden="true"></span>
        <button type="button" class="icon" data-action="more" title="More" aria-label="More" aria-haspopup="menu" aria-expanded="false">${ICON.more}</button>
      </div>
      <div class="menu" role="menu" data-menu="more" hidden>
        <button type="button" role="menuitem" data-action="longer" data-write-only>Make longer</button>
        <button type="button" role="menuitem" data-action="hide-site"></button>
        <button type="button" role="menuitem" data-action="off-writing" data-write-only>Don’t show in text boxes</button>
        <button type="button" role="menuitem" data-action="turn-off">Turn off everywhere</button>
        <button type="button" role="menuitem" data-action="settings">Settings…</button>
      </div>
      <div class="menu" role="menu" data-menu="tone" hidden>
        ${TONES.map((t) => `<button type="button" role="menuitem" data-action="tone-pick" data-tone="${t.toLowerCase()}">${t}</button>`).join('')}
      </div>
      <div class="win" role="dialog" aria-label="Tabi" hidden>
        <div class="head" title="Drag to move">
          <span class="title"><span class="mark" aria-hidden="true">${MARK}</span><span class="name"></span></span>
          <button type="button" class="icon" data-action="continue" title="Continue in the side panel" aria-label="Continue in the side panel">${ICON.panel}</button>
          <button type="button" class="icon" data-action="close" title="Close (Esc)" aria-label="Close">${ICON.close}</button>
        </div>
        <div class="quote"></div>
        <div class="thread" aria-live="polite"></div>
        <div class="actions" hidden>
          <button type="button" class="primary" data-action="replace" data-write-only>Replace</button>
          <button type="button" data-action="insert" data-write-only>Insert below</button>
          <button type="button" data-action="copy-answer">${ICON.copy}Copy</button>
          <button type="button" data-action="retry" title="Try again">${ICON.retry}Retry</button>
        </div>
        <form class="compose">
          <textarea rows="1" aria-label="Ask a follow-up"></textarea>
          <button type="submit" class="send" data-action="send" aria-label="Send">${ICON.send}</button>
        </form>
      </div>
    </div>`;
  const $ = <T extends Element>(sel: string) => shadow.querySelector(sel) as T;
  const root = $<HTMLElement>('.root');
  const bar = $<HTMLElement>('.bar');
  const moreMenu = $<HTMLElement>('[data-menu="more"]');
  const toneMenu = $<HTMLElement>('[data-menu="tone"]');
  const box = $<HTMLElement>('.win');
  const head = $<HTMLElement>('.head');
  const nameEl = $<HTMLElement>('.name');
  const quote = $<HTMLElement>('.quote');
  const thread = $<HTMLElement>('.thread');
  const actions = $<HTMLElement>('.actions');
  const compose = $<HTMLFormElement>('.compose');
  const input = $<HTMLTextAreaElement>('textarea');
  const sendBtn = $<HTMLButtonElement>('.send');
  const button = (action: string) => $<HTMLButtonElement>(`[data-action="${action}"]`);

  let enabled = { reading: false, writing: false };
  /** The selection the bar is for. */
  let picked: Picked | null = null;
  let writing = false;
  /** The conversation in the window (it keeps its own copy of the selection: typing a question clears the page's). */
  let convo: {
    action: SelectionAction;
    picked: Picked;
    tone?: string;
    instruction?: string;
    /** After the first answer: answers and follow-ups, for the model. */
    turns: { role: 'user' | 'assistant'; content: string }[];
    /** Questions and answers as shown, for Continue in panel. */
    pairs: { question: string; answer: string }[];
  } | null = null;
  let streaming: AbortController | null = null;
  /** Moved by the user: it stays open on clicks elsewhere. */
  let pinned = false;

  const mount = () => { if (!host.isConnected) doc.documentElement.appendChild(host); };
  const state = () => {
    // For tests: the shadow root is closed
    const answered = !!convo?.pairs.length && !streaming;
    host.dataset.state = !box.hidden ? (streaming ? 'streaming' : answered ? 'answer' : 'window') : !bar.hidden ? (writing ? 'bar-write' : 'bar') : 'none';
  };
  const closeMenus = () => {
    moreMenu.hidden = true;
    toneMenu.hidden = true;
    button('more').setAttribute('aria-expanded', 'false');
    button('tone').setAttribute('aria-expanded', 'false');
  };
  const hideBar = () => {
    bar.hidden = true;
    closeMenus();
    if (box.hidden) host.remove();
    state();
  };
  const closeAll = () => {
    streaming?.abort();
    streaming = null;
    convo = null;
    pinned = false;
    bar.hidden = true;
    box.hidden = true;
    closeMenus();
    host.remove();
    state();
  };

  /** Put an element by a rectangle: below it, or above if there's no room below (or above first). */
  const place = (el: HTMLElement, anchor: DOMRect, above: boolean) => {
    const { width, height } = el.getBoundingClientRect();
    const vw = win.innerWidth;
    const vh = win.innerHeight;
    const left = Math.min(Math.max(GAP, anchor.left), Math.max(GAP, vw - width - GAP));
    const up = anchor.top - height - GAP;
    const down = anchor.bottom + GAP;
    const top = above ? (up >= GAP ? up : Math.min(down, vh - height - GAP)) : (down + height <= vh - GAP ? down : Math.max(GAP, up));
    el.style.left = `${left}px`;
    el.style.top = `${Math.max(GAP, top)}px`;
  };

  // ---- What's selected

  /** The selection now: text on the page, or text in a text box (with where it is, to put a rewrite back). */
  const readSelection = (point?: { x: number; y: number }): Picked | null => {
    const active = doc.activeElement as HTMLElement | null;
    if (active && (active.tagName === 'TEXTAREA' || (active.tagName === 'INPUT' && WRITABLE_INPUTS.has((active as HTMLInputElement).type.toLowerCase())))) {
      const field = active as HTMLInputElement | HTMLTextAreaElement;
      const start = field.selectionStart ?? 0;
      const end = field.selectionEnd ?? 0;
      if (end - start < MIN_CHARS || field.readOnly || field.disabled) return null;
      const r = field.getBoundingClientRect();
      const rect = point ? new DOMRect(point.x, point.y, 0, 0) : new DOMRect(r.left, r.top, Math.min(r.width, 40), r.height);
      return { text: field.value.slice(start, end), around: field.value.slice(0, 2000), rect, target: { kind: 'field', el: field, start, end } };
    }
    if (active?.tagName === 'INPUT') return null; // passwords, numbers, emails...
    const selection = win.getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount) return null;
    const text = selection.toString().trim();
    if (text.length < MIN_CHARS || text.length > MAX_CHARS || isOwnUi(selection.anchorNode)) return null;
    const range = selection.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return null;
    const editor = editingHost(selection.anchorNode);
    if (editor) return { text, around: (editor.innerText ?? '').slice(0, 2000), rect, target: { kind: 'editable', root: editor, range: range.cloneRange() } };
    return { text, around: passageAround(range), rect, target: { kind: 'page' } };
  };

  const showBar = (p: Picked) => {
    writing = p.target.kind !== 'page';
    if (writing ? !enabled.writing : !enabled.reading) return hideBar();
    picked = p;
    mount();
    closeMenus();
    for (const group of bar.querySelectorAll<HTMLElement>('.group')) group.hidden = group.dataset.mode !== (writing ? 'write' : 'read');
    button('summarize').hidden = writing || p.text.length < SUMMARIZE_CHARS;
    button('copy').innerHTML = ICON.copy;
    bar.hidden = false;
    place(bar, p.rect, true);
    state();
  };

  // ---- The window

  const renderAnswer = (el: HTMLElement, text: string, write: boolean) => {
    if (write) {
      el.className = 'msg draft';
      el.textContent = text;
    } else {
      el.className = 'msg answer';
      el.innerHTML = renderMarkdown(text);
    }
  };

  const addMessage = (cls: string, text?: string) => {
    const el = doc.createElement('div');
    el.className = `msg ${cls}`;
    if (text !== undefined) el.textContent = text;
    thread.appendChild(el);
    thread.scrollTop = thread.scrollHeight;
    return el;
  };

  const setComposer = () => {
    const write = convo ? WRITING_ACTIONS.includes(convo.action) : false;
    const waiting = !!convo && !convo.pairs.length && !streaming && (convo.action === 'ask' || convo.action === 'edit') && !convo.instruction;
    input.placeholder = waiting
      ? (convo!.action === 'edit' ? 'How should Tabi change it?' : convo!.picked.text ? 'Ask about the selected text' : 'Ask about this page')
      : write ? 'Ask for changes, e.g. “more formal”' : 'Ask a follow-up';
    sendBtn.innerHTML = streaming ? ICON.stop : ICON.send;
    sendBtn.setAttribute('aria-label', streaming ? 'Stop' : 'Send');
    sendBtn.disabled = !streaming && !input.value.trim();
  };

  const fitInput = () => {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 120)}px`;
  };

  /** Ask the model for the next answer in the conversation, streaming it into a new message. */
  const request = async (question: string) => {
    if (!convo) return;
    const c = convo;
    const write = WRITING_ACTIONS.includes(c.action);
    actions.hidden = true;
    const el = addMessage('answer');
    el.innerHTML = '<div class="status"><span class="dot"></span>Thinking…</div>';
    const controller = new AbortController();
    streaming = controller;
    setComposer();
    state();
    try {
      const answer = await opts.stream({
        action: c.action, text: c.picked.text, around: c.picked.around, instruction: c.instruction, tone: c.tone, turns: [...c.turns],
      }, (soFar) => {
        if (convo !== c || controller.signal.aborted || !soFar) return;
        const nearBottom = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 60;
        renderAnswer(el, soFar, write);
        if (nearBottom) thread.scrollTop = thread.scrollHeight;
      }, controller.signal);
      if (convo !== c || controller.signal.aborted) return;
      renderAnswer(el, answer, write);
      c.turns.push({ role: 'assistant', content: answer });
      c.pairs.push({ question, answer });
      for (const b of actions.querySelectorAll<HTMLElement>('[data-write-only]')) b.hidden = !write;
      actions.hidden = false;
    } catch (err) {
      if (convo !== c) return;
      if (controller.signal.aborted) {
        if (el.querySelector('.status')) el.remove();
      } else {
        el.className = 'msg error';
        el.textContent = (err as Error)?.message || 'Something went wrong.';
      }
    } finally {
      if (streaming === controller) streaming = null;
      if (convo === c) {
        setComposer();
        state();
      }
    }
  };

  /** Open the window for an action on the selection (ask and edit wait for the user's words first). */
  const start = (action: SelectionAction, extra: { tone?: string } = {}) => {
    const p = picked;
    if (!p) return;
    streaming?.abort();
    streaming = null;
    convo = { action, picked: p, tone: extra.tone, turns: [], pairs: [] };
    bar.hidden = true;
    closeMenus();
    mount();
    thread.textContent = '';
    actions.hidden = true;
    nameEl.textContent = action === 'tone' && extra.tone ? `${extra.tone[0].toUpperCase()}${extra.tone.slice(1)} tone`
      : action === 'ask' && !p.text ? 'Ask about this page' : TITLES[action];
    quote.textContent = p.text || doc.title || win.location.hostname;
    input.value = '';
    fitInput();
    box.hidden = false;
    pinned = false;
    place(box, p.rect, false);
    setComposer();
    state();
    if (action === 'ask' || action === 'edit') input.focus();
    else request(`${nameEl.textContent}: “${p.text.length > 60 ? `${p.text.slice(0, 59)}…` : p.text}”`);
  };

  /** Send what's typed: the first question (ask, edit) or a follow-up. Stops an answer being written. */
  const submit = () => {
    if (!convo) return;
    if (streaming) {
      streaming.abort();
      return;
    }
    const words = input.value.trim();
    if (!words) return;
    input.value = '';
    fitInput();
    addMessage('user', words);
    if (!convo.pairs.length && !convo.instruction && (convo.action === 'ask' || convo.action === 'edit')) convo.instruction = words;
    else convo.turns.push({ role: 'user', content: words });
    request(words);
  };

  /** Put the rewrite back: in place of the selection, or after it. False if it couldn't. */
  const putBack = (text: string, how: 'replace' | 'insert'): boolean => {
    const c = convo;
    const target = c?.picked.target;
    if (!c || !target || target.kind === 'page') return false;
    if (target.kind === 'field') {
      const { el } = target;
      if (!el.isConnected) return false;
      let { start, end } = target;
      // The text box changed since: find the selection again
      if (el.value.slice(start, end) !== c.picked.text) {
        const at = el.value.indexOf(c.picked.text);
        if (at < 0) return false;
        start = at;
        end = at + c.picked.text.length;
      }
      el.focus();
      const insert = how === 'replace' ? text : `${el.tagName === 'TEXTAREA' ? '\n' : ' '}${text}`;
      const from = how === 'replace' ? start : end;
      setFieldValue(el, el.value.slice(0, from) + insert + el.value.slice(end), from + insert.length);
      return el.value.includes(text);
    }
    const { root, range } = target;
    if (!root.isConnected || !range.startContainer.isConnected) return false;
    root.focus();
    const selection = win.getSelection();
    const at = range.cloneRange();
    if (how === 'insert') at.collapse(false);
    selection?.removeAllRanges();
    selection?.addRange(at);
    // Editors (ProseMirror, Slate, Lexical, Gmail) listen for real text insertion
    let ok = false;
    try {
      if (how === 'insert') doc.execCommand('insertParagraph');
      ok = doc.execCommand('insertText', false, text);
    } catch { /* not supported */ }
    if (!ok) {
      at.deleteContents();
      at.insertNode(doc.createTextNode(how === 'insert' ? `\n${text}` : text));
      root.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
    }
    const firstLine = text.split('\n')[0].trim();
    return (root.innerText ?? '').replace(/\s+/g, ' ').includes(firstLine.replace(/\s+/g, ' '));
  };

  const flash = (btn: HTMLButtonElement, label: string) => {
    const before = btn.innerHTML;
    btn.innerHTML = `${ICON.check}${label}`;
    setTimeout(() => { btn.innerHTML = before; }, 1400);
  };

  // ---- Events

  // Keep the page's selection (and a text box's focus) when the bar or a menu is pressed
  for (const el of [bar, moreMenu, toneMenu]) el.addEventListener('mousedown', (e) => e.preventDefault());

  bar.addEventListener('click', (e) => {
    const btn = (e.target as Element).closest('button');
    const action = btn?.dataset.action;
    if (!action || !picked) return;
    if (action === 'more' || action === 'tone') {
      const menu = action === 'more' ? moreMenu : toneMenu;
      const open = menu.hidden;
      closeMenus();
      menu.hidden = !open;
      btn!.setAttribute('aria-expanded', String(open));
      if (open && action === 'more') {
        let site = '';
        try { site = new URL(win.location.href).hostname.replace(/^www\./, ''); } catch { /* not a web page */ }
        button('hide-site').textContent = site ? `Don’t show on ${site}` : 'Don’t show on this site';
        for (const item of moreMenu.querySelectorAll<HTMLElement>('[data-write-only]')) item.hidden = !writing;
      }
      if (open) place(menu, btn!.getBoundingClientRect(), false);
      return;
    }
    if (action === 'copy') {
      win.navigator.clipboard?.writeText(picked.text).then(() => { btn!.innerHTML = ICON.check; }).catch(() => {});
      return;
    }
    start(action as SelectionAction);
  });
  moreMenu.addEventListener('click', (e) => {
    const action = (e.target as Element).closest('button')?.dataset.action;
    if (!action) return;
    if (action === 'longer') return start('longer');
    closeAll();
    if (action === 'hide-site') opts.onHideSite();
    else if (action === 'off-writing') opts.onTurnOffWriting();
    else if (action === 'turn-off') opts.onTurnOff();
    else if (action === 'settings') opts.onSettings();
  });
  toneMenu.addEventListener('click', (e) => {
    const tone = (e.target as HTMLElement).closest('button')?.dataset.tone;
    if (tone) start('tone', { tone });
  });

  box.addEventListener('click', (e) => {
    const btn = (e.target as Element).closest('button');
    const action = btn?.dataset.action;
    if (!action || !convo) return;
    const last = convo.pairs.at(-1)?.answer;
    if (action === 'close') closeAll();
    else if (action === 'continue') {
      if (convo.pairs.length) opts.onContinue(convo.pairs);
      closeAll();
    } else if (action === 'copy-answer' && last) {
      win.navigator.clipboard?.writeText(last).then(() => flash(btn!, 'Copied')).catch(() => {});
    } else if (action === 'retry' && last !== undefined && !streaming) {
      convo.turns.pop();
      const { question } = convo.pairs.pop()!;
      thread.lastElementChild?.remove();
      request(question);
    } else if ((action === 'replace' || action === 'insert') && last) {
      if (putBack(last, action)) closeAll();
      else {
        win.navigator.clipboard?.writeText(last).catch(() => {});
        addMessage('error', 'Couldn’t put it in the text box (it changed, or the page doesn’t allow it). It’s copied: paste it where you want it.');
      }
    }
  });
  compose.addEventListener('submit', (e) => {
    e.preventDefault();
    submit();
  });
  input.addEventListener('input', () => { fitInput(); setComposer(); });
  input.addEventListener('keydown', (e) => {
    e.stopPropagation(); // the page's own shortcuts stay out of it
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      submit();
    } else if (e.key === 'Escape') {
      closeAll();
    }
  });
  input.addEventListener('keyup', (e) => e.stopPropagation());
  input.addEventListener('keypress', (e) => e.stopPropagation());

  // Drag the window by its header; then it stays put, even on clicks elsewhere
  head.addEventListener('pointerdown', (e) => {
    if ((e.target as Element).closest('button')) return;
    e.preventDefault();
    const r = box.getBoundingClientRect();
    const dx = e.clientX - r.left;
    const dy = e.clientY - r.top;
    head.setPointerCapture?.(e.pointerId);
    const move = (ev: PointerEvent) => {
      box.style.left = `${Math.min(Math.max(0, ev.clientX - dx), win.innerWidth - r.width)}px`;
      box.style.top = `${Math.min(Math.max(0, ev.clientY - dy), win.innerHeight - 40)}px`;
      pinned = true;
    };
    const up = () => {
      head.removeEventListener('pointermove', move);
      head.removeEventListener('pointerup', up);
      head.removeEventListener('pointercancel', up);
    };
    head.addEventListener('pointermove', move);
    head.addEventListener('pointerup', up);
    head.addEventListener('pointercancel', up);
  });

  /** After a selection ends: offer the bar for it. */
  const onSelectionEnd = (point?: { x: number; y: number }) => {
    if (!enabled.reading && !enabled.writing) return;
    // Let the selection settle (a click inside it collapses it a moment later)
    win.setTimeout(() => {
      const p = readSelection(point);
      if (p) showBar(p);
      else if (!bar.hidden) hideBar();
    }, 10);
  };

  const onMouseUp = (e: MouseEvent) => {
    if (e.button !== 0 || e.composedPath().includes(host)) return;
    onSelectionEnd({ x: e.clientX, y: e.clientY });
  };
  const onKeyUp = (e: KeyboardEvent) => {
    if (e.composedPath().includes(host)) return;
    // Selecting with the keyboard: Shift with arrows, Home/End, or Ctrl+A
    if (e.shiftKey || (e.key === 'a' && (e.ctrlKey || e.metaKey))) onSelectionEnd();
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'Escape' || !host.isConnected) return;
    if (!moreMenu.hidden || !toneMenu.hidden) return closeMenus();
    if (!box.hidden) closeAll();
    else hideBar();
  };
  const onMouseDown = (e: MouseEvent) => {
    if (!host.isConnected || e.composedPath().includes(host)) return;
    hideBar();
    // The window stays while it's answering, has something typed, or was moved
    if (!box.hidden && !streaming && !pinned && !input.value.trim()) closeAll();
  };
  const onScroll = (e: Event) => {
    if (e.composedPath?.().includes(host)) return;
    // The bar belongs where the selection was; the window stays where it is
    if (!bar.hidden) hideBar();
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
      if (!on.reading && !on.writing) closeAll();
      else if (!bar.hidden && (writing ? !on.writing : !on.reading)) hideBar();
    },
    setTheme(theme) {
      root.classList.toggle('light', theme === 'light');
      root.classList.toggle('dark', theme === 'dark');
    },
    askShortcut() {
      const p = readSelection();
      if (p && (p.target.kind === 'page' ? enabled.reading : enabled.writing)) {
        picked = p;
        writing = p.target.kind !== 'page';
        start(writing ? 'edit' : 'ask');
        return;
      }
      if (!enabled.reading) return;
      // Nothing selected: a question about the page
      const text = (doc.body?.innerText ?? '').replace(/\s+/g, ' ').trim();
      picked = { text: '', around: text.slice(0, 6000), rect: new DOMRect(Math.max(GAP, win.innerWidth / 2 - WIN_WIDTH / 2), 40, 0, 0), target: { kind: 'page' } };
      writing = false;
      start('ask');
    },
    destroy() {
      closeAll();
      doc.removeEventListener('mouseup', onMouseUp, true);
      doc.removeEventListener('keyup', onKeyUp, true);
      doc.removeEventListener('keydown', onKeyDown, true);
      doc.removeEventListener('mousedown', onMouseDown, true);
      win.removeEventListener('scroll', onScroll, true);
    },
  };
}
