// lib/agent/actionExecutor.ts
// Executes structured actions on the DOM returned by the LLM agent

import { getElementById, getRemoteRef, findElements, formatWithGroup, pageText, shadowRootOf, type RemoteRef } from '@/lib/agent/domSnapshot';
import { keyParams, normalizeKey } from '@/lib/agent/keys';
import { extract, formatExtraction } from '@/lib/agent/extract';
import { EDITOR_MARK, codeEditorRoot, judgePaste, sameCode, visibleCode, type EditorResult } from '@/lib/agent/codeEditor';

export interface AgentAction {
  action: 'click' | 'type' | 'clear_and_type' | 'select' | 'navigate' | 'scroll' | 'read' | 'wait' | 'done' | 'press_key' | 'find' | 'note' | 'use_skill' | 'extract' | 'run_code';
  elementId?: number;
  text?: string;
  url?: string;
  direction?: 'up' | 'down';
  key?: string;
  summary?: string;
  value?: string;
  /** extract: the fields to collect, e.g. ["name", "price", "RAM"]. */
  fields?: string[];
  /** extract: also read each item's own page for fields the list doesn't show. */
  follow?: boolean;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Scripted key event (fallback when trusted input isn't available). */
function makeKeyEvent(type: 'keydown' | 'keypress' | 'keyup', rawKey: string): KeyboardEvent {
  const { key, code, keyCode } = keyParams(rawKey);
  const event = new KeyboardEvent(type, { key, code, bubbles: true, cancelable: true, composed: true });
  // Legacy keyCode/which (many sites still check `e.keyCode === 13`) can't be
  // set through the constructor
  Object.defineProperty(event, 'keyCode', { get: () => keyCode });
  Object.defineProperty(event, 'which', { get: () => keyCode });
  return event;
}

// Elements can live in iframes, which have their own window and constructors,
// so `el instanceof HTMLInputElement` is false there. Check tag names instead
// and use the element's own window.
function winOf(el: Element): Window & typeof globalThis {
  return (el.ownerDocument.defaultView ?? window) as Window & typeof globalThis;
}

// ---------------------------------------------------------------- trusted input
// Real mouse/keyboard input via the background's Chrome DevTools Protocol
// session (lib/agent/trustedInput.ts). Pages see isTrusted === true. When it's
// unavailable (turned off, another debugger attached, unit tests), callers fall
// back to scripted DOM events.

/**
 * When this script runs inside a cross-origin iframe on behalf of the top page,
 * where that frame sits in the top-level viewport. Trusted clicks are dispatched
 * in top-level coordinates, so the frame's local coordinates are shifted by it.
 */
let frameOffset: { x: number; y: number } | null = null;

export function setFrameOffset(offset: { x: number; y: number } | null): void {
  frameOffset = offset;
}

type TrustedRequest =
  | { kind: 'click'; x: number; y: number }
  | { kind: 'type'; text: string }
  | { kind: 'key'; key: string };

/** Longest wait for the background; typing long text as keystrokes takes a while. */
const TRUSTED_TIMEOUT_MS = 15_000;

async function requestTrusted(payload: TrustedRequest): Promise<boolean> {
  try {
    // Never let a stuck background stall an action; fall back to scripted events
    const res = await Promise.race([
      browser.runtime.sendMessage({ action: 'TRUSTED_INPUT', payload }),
      new Promise<null>(resolve => setTimeout(() => resolve(null), TRUSTED_TIMEOUT_MS)),
    ]);
    return res?.success === true;
  } catch {
    return false;
  }
}

/** Center of `el` in the top-level viewport, or null if it's not on screen. */
function viewportCenter(el: Element): { x: number; y: number } | null {
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return null;
  let x = rect.left + rect.width / 2;
  let y = rect.top + rect.height / 2;
  // Add the offsets of any (same-origin) iframes the element is nested in
  for (let frame = winOf(el).frameElement; frame; frame = winOf(frame).frameElement) {
    const fr = frame.getBoundingClientRect();
    x += fr.left + frame.clientLeft;
    y += fr.top + frame.clientTop;
  }
  if (x < 0 || y < 0 || x >= window.innerWidth || y >= window.innerHeight) return null;
  return { x, y };
}

/** Topmost element at a viewport point, looking into shadow roots and iframes. */
function deepElementFromPoint(x: number, y: number): Element | null {
  let hit = document.elementFromPoint(x, y);
  let ox = 0;
  let oy = 0;
  for (let depth = 0; hit && depth < 20; depth++) {
    const shadow = shadowRootOf(hit);
    const inner = shadow?.elementFromPoint(x - ox, y - oy);
    if (inner && inner !== hit) {
      hit = inner;
      continue;
    }
    const frameDoc = hit.tagName === 'IFRAME' ? (hit as HTMLIFrameElement).contentDocument : null;
    if (frameDoc) {
      const fr = hit.getBoundingClientRect();
      ox += fr.left + hit.clientLeft;
      oy += fr.top + hit.clientTop;
      const inFrame = frameDoc.elementFromPoint(x - ox, y - oy);
      if (inFrame) {
        hit = inFrame;
        continue;
      }
    }
    break;
  }
  return hit;
}

/** Parent across shadow-root and iframe boundaries. */
function composedParent(node: Element): Element | null {
  if (node.parentElement) return node.parentElement;
  const root = node.getRootNode();
  if (root.nodeType === Node.DOCUMENT_FRAGMENT_NODE) return (root as ShadowRoot).host;
  return winOf(node).frameElement;
}

/** Whether a click at the hit element reaches `target` (it's the target, inside it, or wraps it). */
function reaches(hit: Element, target: Element): boolean {
  for (let n: Element | null = hit; n; n = composedParent(n)) {
    if (n === target) return true;
    // Styled checkboxes/radios hide the input behind its <label for=...>;
    // clicking the label is how a user toggles it
    if (n.tagName === 'LABEL' && (n as HTMLLabelElement).control === target) return true;
  }
  return hit.contains(target);
}

function shortLabel(el: Element): string {
  const text = norm((el as HTMLElement).innerText ?? el.textContent ?? '').slice(0, 30);
  return `<${el.tagName.toLowerCase()}>${text ? ` "${text}"` : ''}`;
}

interface ClickReport {
  trusted: boolean;
  /** Set when something else sat on top of the element (e.g. a cookie banner). */
  coveredBy?: string;
}

const NON_TEXT_INPUT_TYPES = new Set([
  'button', 'submit', 'reset', 'checkbox', 'radio', 'file', 'image', 'color', 'range', 'hidden',
]);

function isTextField(el: Element): el is HTMLInputElement | HTMLTextAreaElement {
  if (el.tagName === 'TEXTAREA') return true;
  return el.tagName === 'INPUT' && !NON_TEXT_INPUT_TYPES.has((el as HTMLInputElement).type);
}

/** Set an input/textarea value in a way React/Angular/Vue notice. */
function setFieldValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  // Frameworks track the value through the prototype setter, so call that one
  // rather than the instance property, which they may have overridden.
  const win = winOf(el);
  const proto = el.tagName === 'TEXTAREA' ? win.HTMLTextAreaElement.prototype : win.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setter) setter.call(el, value);
  else el.value = value;

  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
}

/**
 * Put the caret where typing should go: at the end to append, or select all
 * existing content so typing replaces it.
 */
function placeCaret(el: HTMLElement, clear: boolean): void {
  el.focus();
  if (isTextField(el)) {
    if (clear) {
      // Empty it outright: number/email inputs don't allow selecting their
      // text, so select-then-type would append ("1" + "2" = "12")
      if (el.value) setFieldValue(el, '');
      return;
    }
    try {
      el.setSelectionRange(el.value.length, el.value.length);
    } catch { /* number/email inputs don't support selection ranges */ }
    return;
  }
  if (el.isContentEditable) {
    const doc = el.ownerDocument;
    const range = doc.createRange();
    range.selectNodeContents(el);
    if (!clear) range.collapse(false); // caret at the end → append
    const selection = doc.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }
}

/**
 * Type into a contenteditable editor (Slack, Gmail, X, Notion, ...). These
 * ignore `.value`; they react to text insertion at the caret, which
 * execCommand('insertText') performs, firing the beforeinput/input events
 * editor frameworks (ProseMirror, Slate, Lexical, Draft) listen for.
 */
function insertIntoEditable(el: HTMLElement, text: string, clear: boolean): void {
  const doc = el.ownerDocument;
  placeCaret(el, clear);

  let inserted = false;
  try {
    inserted = doc.execCommand('insertText', false, text);
  } catch { /* unsupported → fallback below */ }
  if (!inserted) {
    if (clear) el.textContent = '';
    el.append(doc.createTextNode(text));
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
  }
}

const norm = (s: string) => s.replace(/\s+/g, ' ').trim();

/**
 * Click like a user: scroll into view, then a trusted mouse click at the
 * element's center. Falls back to a scripted click when trusted input is
 * unavailable, or when something covers the element (a trusted click would
 * land on the overlay instead).
 */
async function clickElement(el: HTMLElement): Promise<ClickReport> {
  // Instant, not smooth: the click coordinates must be read after scrolling ends
  el.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'center' });
  await sleep(150);

  const point = viewportCenter(el);
  if (point) {
    const hit = deepElementFromPoint(point.x, point.y);
    if (hit && !reaches(hit, el)) {
      scriptedClick(el);
      return { trusted: false, coveredBy: shortLabel(hit) };
    }
    const x = point.x + (frameOffset?.x ?? 0);
    const y = point.y + (frameOffset?.y ?? 0);
    if (await requestTrusted({ kind: 'click', x, y })) return { trusted: true };
  }
  scriptedClick(el);
  return { trusted: false };
}

/** Press/release, then exactly ONE click; a second would re-toggle checkboxes. */
function scriptedClick(el: HTMLElement): void {
  const win = winOf(el);
  const pointerInit = { bubbles: true, cancelable: true, composed: true, view: win };
  el.dispatchEvent(new win.PointerEvent('pointerdown', pointerInit));
  el.dispatchEvent(new win.MouseEvent('mousedown', pointerInit));
  el.focus();
  el.dispatchEvent(new win.PointerEvent('pointerup', pointerInit));
  el.dispatchEvent(new win.MouseEvent('mouseup', pointerInit));
  el.click();
}

const OPTION_SELECTOR = '[role="option"], [role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"], [role="treeitem"]';

function isShown(el: Element): boolean {
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return false;
  const style = winOf(el).getComputedStyle(el);
  return style.display !== 'none' && style.visibility !== 'hidden';
}

/** Visible options of the popup a custom dropdown opened. */
function findPopupOptions(trigger: HTMLElement): HTMLElement[] {
  // Prefer the list the trigger says it controls; else any visible options in
  // the same document or shadow root (popups are often portaled to <body>)
  const root = trigger.getRootNode() as Document | ShadowRoot;
  const doc = trigger.ownerDocument;
  const ids = [trigger.getAttribute('aria-controls'), trigger.getAttribute('aria-owns')]
    .join(' ').split(/\s+/).filter(Boolean);
  const scopes: ParentNode[] = ids
    .map(id => root.getElementById?.(id) ?? doc.getElementById(id))
    .filter((x): x is HTMLElement => !!x);
  if (scopes.length === 0) {
    scopes.push(root);
    if (root !== doc) scopes.push(doc);
  }
  const found = new Set<HTMLElement>();
  for (const scope of scopes) {
    scope.querySelectorAll<HTMLElement>(OPTION_SELECTOR).forEach(o => { if (isShown(o)) found.add(o); });
  }
  return [...found];
}

/** Match the model's choice by value, then exact label, then partial label. */
function matchOption<T>(items: T[], text: (t: T) => string, value: (t: T) => string, wanted: string): T | undefined {
  const w = wanted.trim().toLowerCase();
  return items.find(o => value(o).toLowerCase() === w)
    || items.find(o => norm(text(o)).toLowerCase() === w)
    || items.find(o => w !== '' && norm(text(o)).toLowerCase().includes(w));
}

const textOf = (el: HTMLElement) => norm(el.innerText ?? el.textContent ?? '');

/**
 * select on a non-native dropdown (combobox, listbox button, menu button):
 * open it, click the matching option, then confirm the choice stuck.
 */
async function selectCustom(trigger: HTMLElement, elementId: number, wanted: string): Promise<string> {
  // The model may have targeted an option directly
  if (trigger.matches(OPTION_SELECTOR)) {
    await clickElement(trigger);
    return `✅ Chose "${textOf(trigger)}" [${elementId}]`;
  }

  let options = findPopupOptions(trigger);
  if (options.length === 0) {
    await clickElement(trigger);
    await sleep(300);
    options = findPopupOptions(trigger);
  }
  if (options.length === 0) {
    return `❌ Element [${elementId}] is not a dropdown: clicking it showed no options. Click the element that opens the list, then choose an option.`;
  }

  const option = matchOption(options, textOf, o => o.getAttribute('data-value') ?? '', wanted);
  if (!option) {
    const available = options.slice(0, 15).map(o => `"${textOf(o)}"`).join(', ');
    return `❌ No option matching "${wanted}" in dropdown [${elementId}]. Options: ${available}`;
  }
  const label = textOf(option);
  await clickElement(option);
  await sleep(200);

  // Confirm: the option is marked selected, or the trigger now shows it
  const shows = (s: string) => s.toLowerCase().includes(label.toLowerCase());
  const confirmed = option.getAttribute('aria-selected') === 'true'
    || option.getAttribute('aria-checked') === 'true'
    || shows(textOf(trigger))
    || shows((trigger as HTMLInputElement).value ?? '');
  return confirmed
    ? `✅ Selected "${label}" in dropdown [${elementId}]`
    : `⚠️ Clicked option "${label}" in dropdown [${elementId}] but could not confirm it was selected`;
}

/**
 * Type into a field and report what actually happened. Reading the result back
 * matters: reporting "✅ Typed" when nothing changed made the agent claim tasks
 * were done when they weren't.
 */
/** Date and time inputs: the format their value takes, whatever the page shows. */
const DATE_FORMATS: Record<string, [RegExp, string]> = {
  date: [/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD, e.g. 2026-10-07'],
  time: [/^\d{2}:\d{2}(:\d{2})?$/, 'HH:MM in 24 hours, e.g. 14:30'],
  'datetime-local': [/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/, 'YYYY-MM-DDTHH:MM, e.g. 2026-10-07T14:30'],
  month: [/^\d{4}-\d{2}$/, 'YYYY-MM, e.g. 2026-10'],
  week: [/^\d{4}-W\d{2}$/, 'YYYY-Www, e.g. 2026-W41'],
};

/**
 * A date or time input takes its value in one fixed format, but typing into it
 * goes through the browser's locale (dd/mm/yyyy or mm/dd/yyyy, AM/PM): set the
 * value instead, and say which format when it's wrong.
 */
async function typeDate(el: HTMLInputElement, elementId: number, text: string): Promise<string> {
  const [pattern, format] = DATE_FORMATS[el.type];
  const value = text.trim();
  if (!pattern.test(value)) return `❌ Element [${elementId}] is a ${el.type} field: type the value as ${format}.`;
  el.scrollIntoView({ behavior: 'instant', block: 'center' });
  el.focus();
  setFieldValue(el, value);
  el.blur();
  return el.value
    ? `✅ Set ${el.type} field [${elementId}] to ${el.value}`
    : `❌ The ${el.type} field [${elementId}] didn't accept "${value}" (it may be outside the allowed range).`;
}

/** Set (or, without `text`, read) a code editor's content in the page's main world; see setCodeInPage. */
async function codeInPage(root: HTMLElement, text: string | null, clear: boolean): Promise<EditorResult> {
  root.setAttribute(EDITOR_MARK, '');
  try {
    const res = await Promise.race([
      browser.runtime.sendMessage({ action: 'CODE_EDITOR', payload: { text, clear } }),
      sleep(5000).then(() => null),
    ]);
    return res?.success ? res.data : { ok: false, why: res?.error ?? 'no response' };
  } catch (err) {
    return { ok: false, why: (err as Error).message };
  } finally {
    root.removeAttribute(EDITOR_MARK);
  }
}

const lineCount = (code: string) => code.replace(/\r\n?/g, '\n').trimEnd().split('\n').length;

/**
 * Type into a code editor (see lib/agent/codeEditor.ts): through the editor's
 * API when the page exposes it, else as a paste, never as keystrokes.
 */
async function typeCode(root: HTMLElement, elementId: number, text: string, clear: boolean): Promise<string> {
  const lines = lineCount(text);
  const what = lines > 1 ? `${lines} lines of code` : `"${text.substring(0, 40)}"`;
  const done = (how = '') => clear ? `✅ Replaced the code in code editor [${elementId}] with ${what}${how}` : `✅ Added ${what} to code editor [${elementId}]${how}`;
  root.scrollIntoView({ behavior: 'instant', block: 'center' });

  const before = await codeInPage(root, null, false);
  // No API to read it with: it gets pasted, so focus it like a user would first
  if (!('value' in before)) await clickElement(root.querySelector<HTMLElement>('.view-lines, .cm-content, .CodeMirror-code, .ace_content') ?? root);
  const after = await codeInPage(root, text, clear);
  if (!after.ok) return `❌ Couldn't write into code editor [${elementId}]: ${after.why}`;

  if ('value' in after) {
    const expected = clear || !('value' in before) ? text : before.value + text;
    if (sameCode(after.value, expected)) return done();
    return `⚠️ Wrote ${what} into code editor [${elementId}], but it now holds ${lineCount(after.value)} lines, starting "${norm(after.value).substring(0, 80)}"`;
  }

  // Pasted: only the lines on screen can be read back
  await sleep(200);
  const shown = visibleCode(root);
  const verdict = judgePaste(shown, text, clear);
  if (verdict === 'exact') return done(' (pasted)');
  if (verdict === 'end') return done(' (pasted; the end of it is in view)');
  if (verdict === 'mixed') return `⚠️ Pasted ${what} into code editor [${elementId}], but it also shows other lines: "${norm(shown).substring(0, 80)}"`;
  return `❌ Pasting ${what} into code editor [${elementId}] had no effect; it shows "${norm(shown).substring(0, 80)}"`;
}

async function typeText(elementId: number, text: string, clear: boolean): Promise<string> {
  const el = getElementById(elementId);
  if (!el) return `❌ Element [${elementId}] not found.`;
  if (el.tagName === 'INPUT' && (el as HTMLInputElement).type in DATE_FORMATS) return typeDate(el as HTMLInputElement, elementId, text);
  const editor = codeEditorRoot(el);
  if (editor) return typeCode(editor, elementId, text, clear);
  const shown = `"${text.substring(0, 40)}"`;
  const verb = clear ? 'Cleared and typed' : 'Typed';
  const field = isTextField(el);
  const editable = el.isContentEditable;
  // Custom text widgets (code editors, terminals) that take keystrokes directly
  const keyTarget = !field && !editable && el.matches('[role="textbox"], [role="searchbox"], [role="combobox"], [tabindex]:not([tabindex="-1"])');

  if (field || editable || keyTarget) {
    // Real keystrokes: click to focus like a user, place the caret, then type
    const before = field ? (el as HTMLInputElement).value : '';
    const click = await clickElement(el);
    if (!click.coveredBy) {
      placeCaret(el, clear);
      if (await requestTrusted({ kind: 'type', text })) {
        await sleep(50);
        if (field) {
          const value = (el as HTMLInputElement).value;
          const expected = clear ? text : before + text;
          if (value === expected) return `✅ ${verb} ${shown} into element [${elementId}]`;
          if (value.includes(text)) return `⚠️ Typed ${shown} into element [${elementId}]; the field now reads "${value.substring(0, 60)}"`;
          // Keystrokes didn't land (e.g. a read-only mask); try setting the value below
        } else {
          const content = norm(el.innerText ?? el.textContent ?? '');
          if (content.includes(norm(text))) return `✅ ${verb} ${shown} into ${editable ? 'editor' : 'element'} [${elementId}]`;
          if (keyTarget) return `❌ Typing ${shown} into element [${elementId}] had no effect; it shows "${content.substring(0, 60)}"`;
        }
      }
    }
  }

  el.scrollIntoView({ behavior: 'instant', block: 'center' });
  await sleep(100);
  el.focus();

  if (field) {
    const expected = clear ? text : el.value + text;
    setFieldValue(el, expected);
    if (el.value === expected) return `✅ ${clear ? 'Cleared and typed' : 'Typed'} ${shown} into element [${elementId}]`;
    // Masked or length-limited inputs may reformat the value
    return el.value.includes(text)
      ? `⚠️ Typed ${shown} into element [${elementId}]; the field now reads "${el.value.substring(0, 60)}"`
      : `❌ Typing ${shown} into element [${elementId}] did not stick; the field reads "${el.value.substring(0, 60)}"`;
  }

  if (editable) {
    insertIntoEditable(el, text, clear);
    const content = norm(el.innerText ?? el.textContent ?? '');
    return content.includes(norm(text))
      ? `✅ ${clear ? 'Cleared and typed' : 'Typed'} ${shown} into editor [${elementId}]`
      : `❌ Typing ${shown} into editor [${elementId}] had no effect; it contains "${content.substring(0, 60)}"`;
  }

  return `❌ Element [${elementId}] <${el.tagName.toLowerCase()}> is not a text field. Pick an input, textarea or editor, or click this element first if it opens one.`;
}

/**
 * Run an action on an element inside a cross-origin iframe, through Tabi's
 * content script in that frame. Passes along where the frame sits on screen so
 * trusted clicks land in the right place.
 */
async function executeInFrame(ref: RemoteRef, action: AgentAction): Promise<string> {
  ref.iframe.scrollIntoView({ behavior: 'instant', block: 'nearest' });
  await sleep(100);
  const rect = ref.iframe.getBoundingClientRect();
  let x = rect.left + ref.iframe.clientLeft;
  let y = rect.top + ref.iframe.clientTop;
  for (let frame = winOf(ref.iframe).frameElement; frame; frame = winOf(frame).frameElement) {
    const fr = frame.getBoundingClientRect();
    x += fr.left + frame.clientLeft;
    y += fr.top + frame.clientTop;
  }
  try {
    const res = await browser.runtime.sendMessage({
      action: 'FRAME_EXECUTE',
      payload: { frameId: ref.frameId, action: { ...action, elementId: ref.localId }, offset: { x, y } },
    });
    if (res?.success) return res.data;
    return `❌ Could not act inside the frame: ${res?.error ?? 'no response'}`;
  } catch (err) {
    return `❌ Could not act inside the frame: ${(err as Error).message}`;
  }
}

/**
 * Execute a single agent action on the current page DOM.
 * Returns a human-readable description of what happened.
 */
export async function executeAction(action: AgentAction): Promise<string> {
  // Elements inside cross-origin iframes are handled by the frame's own script
  if (action.elementId !== undefined) {
    const remote = getRemoteRef(action.elementId);
    if (remote) return executeInFrame(remote, action);
  }

  switch (action.action) {
    case 'click': {
      if (action.elementId === undefined) return '❌ No element ID provided for click.';
      const el = getElementById(action.elementId);
      if (!el) return `❌ Element [${action.elementId}] not found on page.`;
      
      const report = await clickElement(el);

      const label = el.innerText?.trim().substring(0, 40) || el.getAttribute('aria-label') || `element ${action.elementId}`;
      if (report.coveredBy) {
        return `⚠️ Clicked "${label}" with a scripted click because ${report.coveredBy} is on top of it. If nothing happened, close or dismiss that first.`;
      }
      return `✅ Clicked "${label}"`;
    }

    case 'type':
    case 'clear_and_type': {
      if (action.elementId === undefined) return `❌ No element ID provided for ${action.action}.`;
      return typeText(action.elementId, action.text || '', action.action === 'clear_and_type');
    }

    case 'select': {
      if (action.elementId === undefined) return '❌ No element ID provided for select.';
      const target = getElementById(action.elementId);
      if (!target) return `❌ Element [${action.elementId}] not found.`;
      if (target.tagName !== 'SELECT') return selectCustom(target, action.elementId, action.value || '');
      const el = target as HTMLSelectElement;

      // The model may pass either the option's value or its visible label
      const options = Array.from(el.options);
      const option = matchOption(options, o => o.text, o => o.value, action.value || '');
      if (!option) {
        const available = options.slice(0, 15).map(o => `"${o.text.trim()}"`).join(', ');
        return `❌ No option matching "${action.value}" in dropdown [${action.elementId}]. Options: ${available}`;
      }

      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      await sleep(200);
      el.value = option.value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));

      return `✅ Selected "${option.text.trim()}" in dropdown [${action.elementId}]`;
    }

    case 'navigate':
      // The runner (background) navigates the tab itself and waits for the load
      return '❌ navigate is handled by the agent runner, not the page.';

    case 'scroll': {
      const amount = action.direction === 'up' ? -400 : 400;
      window.scrollBy({ top: amount, behavior: 'smooth' });
      return `✅ Scrolled ${action.direction || 'down'}`;
    }

    case 'read': {
      if (action.elementId === undefined) {
        // Whole page, including text inside shadow roots and same-origin iframes
        const text = pageText(800);
        return `📖 Page text: ${text}${text.length >= 800 ? '…' : ''}`;
      }
      const el = getElementById(action.elementId);
      if (!el) return `❌ Element [${action.elementId}] not found.`;
      return `📖 Content of [${action.elementId}]: "${el.innerText?.substring(0, 500) || ''}"`;
    }

    case 'press_key': {
      const key = normalizeKey(action.key || 'Enter');
      const target = action.elementId !== undefined
        ? getElementById(action.elementId) || document.activeElement || document.body
        : document.activeElement || document.body;

      // A trusted key press goes to the focused element and gets the browser's
      // own default behavior (Enter submits the form, Tab moves focus, ...)
      if (target !== document.activeElement) (target as HTMLElement).focus?.();
      if (await requestTrusted({ kind: 'key', key })) return `✅ Pressed "${key}"`;

      // Scripted fallback. If a page handler calls preventDefault() on keydown it has handled the key
      // itself (e.g. a JS-driven search box), so we must not also submit the form.
      const notHandled = target.dispatchEvent(makeKeyEvent('keydown', key));
      if (notHandled) target.dispatchEvent(makeKeyEvent('keypress', key));
      target.dispatchEvent(makeKeyEvent('keyup', key));

      // Synthetic key events have no default action, so emulate the browser's
      // implicit submission: Enter in a form <input> submits that form.
      // requestSubmit() fires a real submit event AND performs the submission;
      // dispatching a bare 'submit' Event does neither reliably.
      const form = target.tagName === 'INPUT' ? (target as HTMLInputElement).form : null;
      if (key === 'Enter' && notHandled && form) {
        form.requestSubmit();
        return `✅ Pressed "Enter" and submitted the form`;
      }

      return `✅ Pressed "${key}"`;
    }

    case 'note': {
      // Memory across pages: the result lands in the action history, which is
      // sent with every step and survives navigation. Page content does not.
      const text = (action.text || '').trim();
      if (!text) return '❌ note needs text to remember.';
      return `📝 Noted: ${text.slice(0, 500)}`;
    }

    case 'find': {
      // Search every element of the latest snapshot, including ones the listing
      // left out on long pages; their IDs work with click/type/select.
      const query = (action.text || '').trim();
      if (!query) return '❌ find needs text to search for.';
      const matches = findElements(query);
      if (matches.length === 0) return `🔎 No elements matching "${query}". Try other words, or scroll to load more of the page.`;
      return `🔎 Found ${matches.length} element(s) matching "${query}": ${matches.map(formatWithGroup).join(' | ')}`;
    }

    case 'extract': {
      // Structured data from lists, tables and detail pages, without model-written code (lib/agent/extract.ts)
      const fields = action.fields ?? [];
      if (fields.length === 0) return '❌ extract needs the fields to collect.';
      const result = await extract(fields, { follow: action.follow });
      return formatExtraction(fields, result, action.text?.trim() || 'items');
    }

    case 'wait': {
      const ms = parseInt(action.text || '1000', 10) || 1000;
      const waitTime = Math.min(ms, 5000); // Cap at 5s
      await sleep(waitTime);
      return `⏳ Waited ${waitTime}ms`;
    }

    case 'done': {
      return `✅ Task complete: ${action.summary || 'Done'}`;
    }

    default:
      return `❌ Unknown action: ${(action as any).action}`;
  }
}
