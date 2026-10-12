// lib/agent/domSnapshot.ts
// Creates a compact, LLM-friendly representation of the current page DOM

import { CODE_EDITOR_SELECTOR } from '@/lib/agent/codeEditor';

const INTERACTIVE_SELECTOR = [
  'a[href]',
  'button',
  'input',
  'textarea',
  'select',
  '[role="button"]',
  '[role="link"]',
  '[role="tab"]',
  '[role="menuitem"]',
  '[contenteditable="true"]',
  // ARIA widgets: how design systems (MUI, Radix, React Select, ...) build
  // dropdowns, toggles and menus out of divs
  '[role="checkbox"]',
  '[role="radio"]',
  '[role="switch"]',
  '[role="combobox"]',
  '[role="option"]',
  '[role="menuitemcheckbox"]',
  '[role="menuitemradio"]',
  '[role="treeitem"]',
  '[role="slider"]',
  '[role="spinbutton"]',
  '[role="searchbox"]',
  '[role="textbox"]',
  '[aria-haspopup]:not([aria-haspopup="false"])',
  // Other clickable things without a semantic role
  'summary',
  '[onclick]',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

// Subtrees that never contain anything the agent can use
const SKIP_TAGS = new Set([
  'SCRIPT', 'STYLE', 'NOSCRIPT', 'SVG', 'CANVAS', 'TEMPLATE', 'HEAD',
]);

// Tabi's own UI on the page (the cue while a task runs, the toolbar on selected
// text) lives in closed shadow roots, which this walker can enter: never read it
const OWN_UI_TAGS = new Set(['TABI-CUE', 'TABI-SELECTION']);

// ---------------------------------------------------------------- element registry
// Maps snapshot IDs to live elements. A querySelector on a data attribute can't
// see into shadow roots or iframes, so the executor looks elements up here.

/**
 * An element inside a cross-origin iframe. This page can't touch it, so actions
 * on it are forwarded to Tabi's content script inside that frame.
 */
export interface RemoteRef {
  /** Chrome's frame id, for messaging the frame's content script. */
  frameId: number;
  /** The element's id in that frame's own snapshot. */
  localId: number;
  /** The <iframe> element on this page that shows the frame. */
  iframe: HTMLIFrameElement;
}

const registry = new Map<number, Element | RemoteRef>();
/** Boxes of elements in cross-origin frames, in their frame's viewport, by snapshot ID. */
const remoteBoxes = new Map<number, { x: number; y: number; w: number; h: number }>();

const isElement = (entry: Element | RemoteRef | undefined): entry is Element =>
  !!entry && typeof (entry as Element).nodeType === 'number';

export function getElementById(id: number): HTMLElement | null {
  const entry = registry.get(id);
  if (isElement(entry) && entry.isConnected) return entry as HTMLElement;
  if (entry) return null; // a remote element: see getRemoteRef
  // Fallback for elements tagged outside a snapshot (e.g. unit tests)
  return document.querySelector(`[data-tabi-id="${id}"]`) as HTMLElement | null;
}

/** Where an element with a snapshot ID is on screen, in CSS pixels of the top-level viewport. */
export interface Mark {
  id: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * On-screen boxes of registered elements, for numbering them on a screenshot.
 * Elements in cross-origin frames use the boxes their frame's script reported.
 */
export function viewportMarks(max = 80): Mark[] {
  const marks: Mark[] = [];
  for (const [id, entry] of registry) {
    if (marks.length >= max) break;
    let box: { x: number; y: number; w: number; h: number };
    if (isElement(entry)) {
      if (!entry.isConnected) continue;
      const rect = entry.getBoundingClientRect();
      box = { x: rect.left, y: rect.top, w: rect.width, h: rect.height };
      // Same-origin iframes: add each enclosing frame's offset
      for (let frame = entry.ownerDocument.defaultView?.frameElement; frame; frame = frame.ownerDocument.defaultView?.frameElement) {
        const fr = frame.getBoundingClientRect();
        box.x += fr.left + frame.clientLeft;
        box.y += fr.top + frame.clientTop;
      }
    } else {
      // Cross-origin frame: its script measured the element; add where the frame is
      const local = remoteBoxes.get(id);
      if (!local || !entry.iframe.isConnected) continue;
      const fr = entry.iframe.getBoundingClientRect();
      box = { ...local, x: local.x + fr.left + entry.iframe.clientLeft, y: local.y + fr.top + entry.iframe.clientTop };
    }
    if (box.w < 2 || box.h < 2) continue;
    if (box.x + box.w <= 0 || box.y + box.h <= 0 || box.x >= window.innerWidth || box.y >= window.innerHeight) continue;
    marks.push({ id, ...box });
  }
  return marks;
}

/** The frame an element lives in, if it is inside a cross-origin iframe. */
export function getRemoteRef(id: number): RemoteRef | null {
  const entry = registry.get(id);
  return entry && !isElement(entry) && entry.iframe.isConnected ? entry : null;
}

// ---------------------------------------------------------------- traversal

/** Open shadow root, or a closed one via the extension-only chrome.dom API. */
export function shadowRootOf(el: Element): ShadowRoot | null {
  const openOrClosed = (globalThis as any).chrome?.dom?.openOrClosedShadowRoot;
  if (typeof openOrClosed === 'function') {
    try {
      return openOrClosed(el) ?? null;
    } catch { /* not a shadow host */ }
  }
  return el.shadowRoot;
}

/** Same-origin iframe document; cross-origin frames throw or return null. */
function frameDocumentOf(el: Element): Document | null {
  if (el.tagName !== 'IFRAME' && el.tagName !== 'FRAME') return null;
  try {
    return (el as HTMLIFrameElement).contentDocument;
  } catch {
    return null;
  }
}

function frameLabel(frame: Element): string {
  return truncate(frame.getAttribute('title') || frame.getAttribute('name') || frame.getAttribute('src') || 'iframe', 40);
}

interface Found {
  el: Element;
  /** Label of the iframe the element lives in, if any. */
  frame?: string;
  /** Top of the element's iframe in the top-level viewport (0 outside iframes). */
  frameTop: number;
}

/** A visible iframe this page can't read into (cross-origin). */
export interface OpaqueFrame {
  iframe: HTMLIFrameElement;
  label: string;
}

/**
 * Every interactive element in document order, including those inside
 * (open or extension-reachable closed) shadow roots and same-origin iframes.
 * Visible cross-origin iframes are listed in `opaque` for the frame bridge.
 */
function collectInteractive(
  root: Document | ShadowRoot,
  frame: string | undefined,
  out: Found[],
  frameTop = 0,
  opaque: OpaqueFrame[] = [],
): void {
  // nodeType, not instanceof: an iframe's Document comes from another realm
  const doc = root.nodeType === Node.DOCUMENT_NODE ? (root as Document) : (root.ownerDocument as Document);
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, {
    acceptNode: (node) =>
      SKIP_TAGS.has((node as Element).tagName) || OWN_UI_TAGS.has((node as Element).tagName)
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT,
  });

  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const el = node as Element;
    if (el.matches(INTERACTIVE_SELECTOR)) out.push({ el, frame, frameTop });

    const shadow = shadowRootOf(el);
    if (shadow) collectInteractive(shadow, frame, out, frameTop, opaque);

    const frameDoc = frameDocumentOf(el);
    if (frameDoc && isVisible(el)) {
      collectInteractive(frameDoc, frameLabel(el), out, frameTop + el.getBoundingClientRect().top, opaque);
    } else if (!frameDoc && el.tagName === 'IFRAME' && isVisible(el)) {
      opaque.push({ iframe: el as HTMLIFrameElement, label: frameLabel(el) });
    }
  }
}

// ---------------------------------------------------------------- page text

interface TextSource {
  root: ShadowRoot | Document;
  frame?: string;
}

/** Shadow roots and same-origin iframe documents, whose text body.innerText leaves out. */
function collectTextSources(root: Document | ShadowRoot, frame: string | undefined, out: TextSource[]): void {
  const doc = root.nodeType === Node.DOCUMENT_NODE ? (root as Document) : (root.ownerDocument as Document);
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, {
    acceptNode: (node) =>
      SKIP_TAGS.has((node as Element).tagName) || OWN_UI_TAGS.has((node as Element).tagName)
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT,
  });
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const el = node as Element;
    const shadow = shadowRootOf(el);
    if (shadow) {
      out.push({ root: shadow, frame });
      collectTextSources(shadow, frame, out);
    }
    const frameDoc = frameDocumentOf(el);
    if (frameDoc && isVisible(el)) {
      const label = frameLabel(el);
      out.push({ root: frameDoc, frame: label });
      collectTextSources(frameDoc, label, out);
    }
  }
}

function visibleTextOf(source: TextSource): string {
  if (source.root.nodeType === Node.DOCUMENT_NODE) return (source.root as Document).body?.innerText ?? '';
  // A ShadowRoot has no innerText; join its rendered top-level children
  return Array.from(source.root.children)
    .filter(c => !SKIP_TAGS.has(c.tagName))
    .map(c => (c as HTMLElement).innerText ?? '')
    .join(' ');
}

/**
 * The page's visible text, including text inside shadow roots and same-origin
 * iframes, which document.body.innerText leaves out. Without it the agent
 * can't see confirmations like "Subscribed!" or "Payment received" rendered
 * by web components or embedded forms, and keeps retrying work it has done.
 */
export function pageText(maxChars: number, remoteTexts: string[] = []): string {
  const sources: TextSource[] = [];
  collectTextSources(document, undefined, sources);
  const extras = sources
    .map(s => ({ s, text: truncate(visibleTextOf(s), 1000) }))
    .filter(({ text }) => text.length > 0)
    .map(({ s, text }) => (s.frame ? `[in frame "${s.frame}"] ${text}` : `[in component] ${text}`))
    .concat(remoteTexts) // text from cross-origin frames, already labeled
    .join('\n');

  // Give embedded content up to half the room so a long page can't crowd it out
  const extrasShare = Math.min(extras.length + 1, Math.floor(maxChars / 2));
  const main = truncate(document.body?.innerText ?? '', Math.max(maxChars - extrasShare, 0));
  const combined = extras ? `${main}\n${truncate(extras, extrasShare)}` : main;
  return combined.trim();
}

// ---------------------------------------------------------------- element details

function isVisible(el: Element): boolean {
  // No `instanceof HTMLElement`: iframe elements come from another realm
  if (typeof (el as HTMLElement).getBoundingClientRect !== 'function') return false;
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return false;
  const style = (el.ownerDocument.defaultView ?? window).getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
  if (el.getAttribute('aria-hidden') === 'true') return false;
  return true;
}

function truncate(str: string, max: number): string {
  const clean = str.replace(/\s+/g, ' ').trim();
  return clean.length > max ? clean.substring(0, max) + '…' : clean;
}

/** An <input> drawn as a button, whose value is its text rather than something typed. */
function isButtonInput(el: Element): boolean {
  return el.tagName === 'INPUT' && /^(submit|button|reset)$/i.test(el.getAttribute('type') ?? '');
}

/** Text of the elements an ARIA id-list attribute points to, in the element's own document or shadow root. */
function referencedText(el: Element, attr: string): string {
  const ids = el.getAttribute(attr)?.split(/\s+/).filter(Boolean);
  if (!ids?.length) return '';
  const root = el.getRootNode() as Document | ShadowRoot;
  return ids
    .map((id) => (root.getElementById?.(id) ?? el.ownerDocument.getElementById(id)) as HTMLElement | null)
    // innerText of a hidden element falls back to its textContent
    .map((ref) => (ref && ref !== el ? ref.innerText ?? ref.textContent ?? '' : ''))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The text of the <label>s for a form control: <label for="id"> or one wrapped around it. */
function labelText(el: Element): string {
  const labels = (el as HTMLInputElement).labels;
  if (!labels?.length) return '';
  return Array.from(labels).map((l) => l.innerText ?? '').join(' ').replace(/\s+/g, ' ').trim();
}

/** How long a label may be: a field named by its question needs the whole question. */
const LABEL_CHARS = 60;
const NAMED_BY_CHARS = 100;

function getLabel(el: Element): string {
  // Like a screen reader: what the page says names it, then what it shows
  const labelledBy = referencedText(el, 'aria-labelledby');
  if (labelledBy) return truncate(labelledBy, NAMED_BY_CHARS);

  const ariaLabel = el.getAttribute('aria-label');
  if (ariaLabel) return truncate(ariaLabel, LABEL_CHARS);

  const label = labelText(el);
  if (label) return truncate(label, NAMED_BY_CHARS);

  const title = el.getAttribute('title');
  if (title) return truncate(title, 60);

  // <input type="submit" value="Place order">: the value is the text on the button
  if (isButtonInput(el) && (el as HTMLInputElement).value) return truncate((el as HTMLInputElement).value, 60);

  const innerText = (el as HTMLElement).innerText;
  if (innerText && innerText.trim().length > 0 && innerText.trim().length < 80) {
    return truncate(innerText, 60);
  }

  const placeholder = el.getAttribute('placeholder');
  if (placeholder) return truncate(placeholder, 60);

  const alt = el.getAttribute('alt');
  if (alt) return truncate(alt, 60);

  const name = el.getAttribute('name');
  if (name) return name;

  return '';
}

const GROUP_CHARS = 140;
/** Containers that name the controls inside them: radio groups, checkbox lists, fieldsets. */
const NAMED_GROUP_ROLES = new Set(['radiogroup', 'group', 'list', 'listbox', 'tablist', 'menu', 'menubar', 'toolbar', 'dialog']);
/** Containers whose heading names what's inside: a form question, a product card. */
const HEADED_CONTAINER = 'fieldset, li, article, [role="listitem"], [role="article"]';
const HEADING = 'legend, [role="heading"], h1, h2, h3, h4, h5, h6';

interface ContainerInfo {
  /** Its ARIA name or legend. */
  named: string;
  /** The heading inside it, if it's a container that headings name. */
  heading: Element | null;
}
/** Per container, for one snapshot: many controls share a container. */
let containers = new WeakMap<Element, ContainerInfo>();

function containerInfo(node: Element): ContainerInfo {
  let info = containers.get(node);
  if (!info) {
    const role = node.getAttribute('role') ?? '';
    const named = NAMED_GROUP_ROLES.has(role) || node.tagName === 'FIELDSET'
      ? referencedText(node, 'aria-labelledby') || node.getAttribute('aria-label') || ''
      : '';
    info = { named: named.trim(), heading: node.matches(HEADED_CONTAINER) ? node.querySelector(HEADING) : null };
    containers.set(node, info);
  }
  return info;
}

/** What a container calls itself for this control: its ARIA name, or the heading that comes before the control. */
function containerName(node: Element, el: Element): string {
  const { named, heading } = containerInfo(node);
  if (named) return named;
  // The heading must come before the control, not be (or hold) it
  if (heading && !heading.contains(el) && heading.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) {
    return (heading as HTMLElement).innerText ?? heading.textContent ?? '';
  }
  return '';
}

/**
 * The question or section a control belongs to, e.g. a radio button's
 * question: "3. What is the capital of France? › Paris" is clear where a list
 * of "Paris" buttons isn't. The nearest named container, and the one around it
 * when there is one (a grid question and its row), outermost first.
 */
function groupOf(el: Element, label: string): string | undefined {
  const names: string[] = [];
  let node = el.parentElement;
  for (let depth = 0; node && depth < 10 && names.length < 2 && node !== el.ownerDocument.body; depth++, node = node.parentElement) {
    const name = containerName(node, el).replace(/\s+/g, ' ').trim();
    // Skip names that only repeat the control's own (a field named by its question)
    if (name && name.length < 300 && !names.includes(name) && !(label && name.startsWith(label.replace(/…$/, '')))) names.unshift(name);
  }
  // Nothing names it, but its question is written next to it (plain divs and spans)
  if (!names.length && isChoice(el)) {
    const question = looseQuestion(el as HTMLInputElement);
    if (question && !(label && question.startsWith(label))) names.push(question);
  }
  return names.length ? truncate(names.join(' › '), GROUP_CHARS) : undefined;
}

const isChoice = (el: Element) => el.tagName === 'INPUT' && /^(radio|checkbox)$/i.test((el as HTMLInputElement).type);

/** Question text per radio group name, for one snapshot. */
let looseQuestions = new Map<string, string>();

/**
 * The question of a radio group (or a lone checkbox) that nothing names: the
 * text in the smallest container around all its options, without the
 * options' own labels, e.g. "2: The teacher was well-prepared for each class."
 * Gives up rather than reach a container holding other questions too.
 */
function looseQuestion(el: HTMLInputElement): string {
  const doc = el.ownerDocument;
  const key = el.name ? `${el.type}:${el.name}` : '';
  if (key && looseQuestions.has(key)) return looseQuestions.get(key)!;
  const peers = el.name && el.type.toLowerCase() === 'radio'
    ? Array.from((el.form ?? doc).querySelectorAll<HTMLInputElement>(`input[type="radio"][name="${CSS.escape(el.name)}"]`))
    : [el];
  // Longest first: "Disagree" must not split "Strongly Disagree"
  const options = peers.map((p) => labelText(p)).filter(Boolean).sort((a, b) => b.length - a.length);
  let box: Element | null = el.parentElement;
  while (box && !peers.every((p) => box!.contains(p))) box = box.parentElement;
  let question = '';
  for (let depth = 0; box && box !== doc.body && depth < 5; depth++, box = box.parentElement) {
    // Other questions' options in here: it's past this question's own box
    const others = Array.from(box.querySelectorAll<HTMLInputElement>('input[type="radio"], input[type="checkbox"]')).some((i) => !peers.includes(i));
    if (others) break;
    let text = (box as HTMLElement).innerText ?? box.textContent ?? '';
    for (const option of options) text = text.split(option).join(' ');
    text = text.replace(/\s+/g, ' ').trim();
    if (text.length >= 3) {
      question = text.length > 300 ? '' : text;
      break;
    }
  }
  if (key) looseQuestions.set(key, question);
  return question;
}

export interface SnapshotElement {
  id: number;
  tag: string;
  role: string;
  label: string;
  /** The question or section it belongs to, from the containers around it. */
  group?: string;
  type?: string;
  href?: string;
  value?: string;
  placeholder?: string;
  checked?: boolean;
  disabled?: boolean;
  /** ARIA state, e.g. expanded / collapsed / selected / popup=listbox */
  states?: string[];
  options?: string[];
  /** Label of the iframe the element is in, if any. */
  frame?: string;
  selector: string;
}

const MAX_SELECT_OPTIONS = 15;

/** Visible labels of a <select>'s options, so the model can pick a valid one. */
function getSelectOptions(el: Element): string[] | undefined {
  if (el.tagName !== 'SELECT') return undefined;
  const labels = Array.from((el as HTMLSelectElement).options)
    .map(o => truncate(o.text, 40))
    .filter(Boolean);
  if (labels.length <= MAX_SELECT_OPTIONS) return labels;
  return [...labels.slice(0, MAX_SELECT_OPTIONS), `…+${labels.length - MAX_SELECT_OPTIONS} more`];
}

/** ARIA state worth showing: lets the model tell an open dropdown from a closed one. */
function getAriaStates(el: Element): string[] | undefined {
  const states: string[] = [];
  const expanded = el.getAttribute('aria-expanded');
  if (expanded === 'true') states.push('expanded');
  if (expanded === 'false') states.push('collapsed');
  if (el.getAttribute('aria-selected') === 'true') states.push('selected');
  const checked = el.getAttribute('aria-checked');
  if (checked === 'true') states.push('checked');
  if (checked === 'mixed') states.push('partially checked');
  if (el.getAttribute('aria-pressed') === 'true') states.push('pressed');
  if (el.getAttribute('aria-disabled') === 'true') states.push('disabled');
  const popup = el.getAttribute('aria-haspopup');
  if (popup && popup !== 'false') states.push(`popup=${popup === 'true' ? 'menu' : popup}`);
  // Monaco, CodeMirror, Ace: their own input box, which typing handles specially
  if (el.closest(CODE_EDITOR_SELECTOR)) states.push('code editor');
  return states.length ? states : undefined;
}

function describe(el: Element, id: number, frame: string | undefined): SnapshotElement {
  const tag = el.tagName.toLowerCase();
  const input = el as HTMLInputElement;
  // Editors have no .value; show their text so the model can see what's typed
  // A code editor's input box holds a scrap of the code at most: `read` gets all of it
  const value = isButtonInput(el) || el.closest(CODE_EDITOR_SELECTOR) ? undefined // a button's text is already the label
    : ((el as HTMLElement).isContentEditable ? (el as HTMLElement).innerText : input.value) || undefined;
  const href = tag === 'a' ? (el as HTMLAnchorElement).href : undefined;
  const label = getLabel(el);

  return {
    id,
    tag,
    role: el.getAttribute('role') || tag,
    label,
    group: groupOf(el, label),
    type: el.getAttribute('type') || undefined,
    href: href ? truncate(href, 100) : undefined,
    value: value ? truncate(value, 50) : undefined,
    placeholder: el.getAttribute('placeholder') || undefined,
    checked: input.checked || undefined,
    disabled: input.disabled || undefined,
    states: getAriaStates(el),
    options: getSelectOptions(el),
    frame,
    selector: `[data-tabi-id="${id}"]`,
  };
}

export function formatElement(el: SnapshotElement): string {
  let entry = `[${el.id}] <${el.tag}>`;
  if (el.role !== el.tag) entry += ` role="${el.role}"`;
  if (el.type) entry += ` type="${el.type}"`;
  if (el.label) entry += ` "${el.label}"`;
  if (el.placeholder) entry += ` placeholder="${el.placeholder}"`;
  if (el.href) entry += ` href="${el.href}"`;
  if (el.value) entry += ` value="${el.value}"`;
  if (el.checked) entry += ` [checked]`;
  if (el.disabled) entry += ` [disabled]`;
  if (el.states) entry += ` [${el.states.join(', ')}]`;
  if (el.options) entry += ` options=[${el.options.map(o => JSON.stringify(o)).join(', ')}]`;
  if (el.frame) entry += ` (in frame "${el.frame}")`;
  return entry;
}

/** The line that heads a group's elements in a snapshot. */
export const groupHeading = (group: string) => `── ${group} ──`;

/** An element with the question or section it belongs to, for a line on its own (find results). */
export const formatWithGroup = (el: SnapshotElement) => (el.group ? `${formatElement(el)} (under "${el.group}")` : formatElement(el));

// ---------------------------------------------------------------- snapshot

/**
 * Size of the snapshot text sent to the model (~1.5k tokens). Long pages don't
 * fit, so elements closest to the viewport are listed first, and `find` can
 * search the rest: every element keeps an ID whether it's listed or not.
 */
export const SNAPSHOT_BUDGET = 6000;
const MIN_TEXT_BUDGET = 600;
const MAX_TEXT_CHARS = 2000;

/** Elements from the latest snapshot, listed or not; searched by `find`. */
let lastElements: SnapshotElement[] = [];

/** Vertical distance (px) from the viewport; 0 if on screen. */
function viewportDistance(el: Element, frameTop: number): number {
  const rect = el.getBoundingClientRect();
  const top = rect.top + frameTop;
  const bottom = rect.bottom + frameTop;
  if (bottom < 0) return -bottom;
  if (top > window.innerHeight) return top - window.innerHeight;
  return 0;
}

/**
 * Search every element of the latest snapshot, including those left out of the
 * listing, by case-insensitive substring of its description (label, placeholder,
 * href, value, options). Like Ctrl+F for interactive elements.
 */
export function findElements(query: string, limit = 10): SnapshotElement[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  return lastElements
    .filter(el => {
      const haystack = formatWithGroup(el).toLowerCase();
      return words.every(w => haystack.includes(w));
    })
    .slice(0, limit);
}

// ---------------------------------------------------------------- workflows
// A recorded step names its element by description, not ID (IDs change on
// every snapshot): what formatElement says, minus what changes as the page is
// used (typed values, checked, expanded). `nth` tells same-looking elements
// apart, e.g. the third "Add to cart" button.

export interface ElementKey {
  key: string;
  nth: number;
}

/** An element's description without its ID or changing state. */
export function elementKey(el: SnapshotElement): string {
  return formatElement({ ...el, value: undefined, checked: undefined, states: undefined }).replace(/^\[\d+\] /, '');
}

/** Describe the latest snapshot's element `id` for a workflow step. */
export function describeElement(id: number): ElementKey | null {
  const target = lastElements.find((el) => el.id === id);
  if (!target) return null;
  const key = elementKey(target);
  const same = lastElements.filter((el) => elementKey(el) === key);
  return { key, nth: same.indexOf(target) };
}

/**
 * What an action would set off, described like elementKey, so the agent can
 * ask before anything that can't be undone (lib/agent/confirm.ts): the clicked
 * element, or for Enter the focused button, or the button that submits the
 * focused field's form. Null if it can't tell.
 */
export function commitTarget(action: { action: string; elementId?: number }): string | null {
  const listed = action.elementId !== undefined ? lastElements.find((el) => el.id === action.elementId) : undefined;
  if (action.action === 'click') return listed ? elementKey(listed) : null;
  // press_key goes to the given element, else the focused one
  const el = (action.elementId !== undefined ? getElementById(action.elementId) : null) ?? deepActiveElement();
  if (!el) return null;
  if (el.tagName !== 'INPUT') return listed ? elementKey(listed) : elementKey(describe(el, 0, undefined));
  // Enter in a field submits its form, through the form's first submit button
  const form = (el as HTMLInputElement).form;
  const submit = form?.querySelector('button:not([type]), button[type="submit"], input[type="submit"], input[type="image"]');
  return submit ? elementKey(describe(submit, 0, undefined)) : null;
}

/** The focused element, inside shadow roots too. */
function deepActiveElement(): Element | null {
  let el = document.activeElement;
  while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
  return el && el !== document.body ? el : null;
}

/**
 * Find a described element in the latest snapshot: the same description (the
 * nth of them, or the only one), else a unique element with the same tag and
 * label (its type, link or placeholder may have changed). Null if it's gone
 * or ambiguous.
 */
export function resolveElement({ key, nth }: ElementKey): number | null {
  const same = lastElements.filter((el) => elementKey(el) === key);
  if (same.length > 0) return (same[nth] ?? (same.length === 1 ? same[0] : null))?.id ?? null;
  const m = /^<(\w+)>(?:.*?) "((?:[^"\\]|\\.)*)"/.exec(key);
  if (!m) return null;
  const [, tag, label] = m;
  const loose = lastElements.filter((el) => el.tag === tag && el.label === label);
  return loose.length === 1 ? loose[0].id : null;
}

/** A snapshot being assembled: local elements first, then any from cross-origin frames. */
export interface SnapshotParts {
  elements: SnapshotElement[];
  /** Vertical distance from the viewport per element id; drives the listing budget. */
  distance: Map<number, number>;
  opaqueFrames: OpaqueFrame[];
  /** Labeled text from cross-origin frames. */
  remoteTexts: string[];
}

/** What a frame's content script reports about itself (see entrypoints/frame.content.ts). */
export interface FrameSnapshot {
  elements: SnapshotElement[];
  /** Top of each element in the frame's own viewport, by local id. */
  tops: number[];
  /** Each element's box in the frame's own viewport, by local id (for screenshot marks). */
  boxes?: ({ x: number; y: number; w: number; h: number } | null)[];
  text: string;
}

/**
 * Register this document's interactive elements (and those in its shadow roots
 * and same-origin iframes) under fresh IDs, and list the cross-origin iframes
 * it couldn't read into.
 */
export function collectLocalElements(): SnapshotParts {
  // Clean up the previous snapshot's IDs, wherever those elements live
  for (const entry of registry.values()) if (isElement(entry)) entry.removeAttribute('data-tabi-id');
  registry.clear();
  remoteBoxes.clear();
  containers = new WeakMap();
  looseQuestions = new Map();

  const found: Found[] = [];
  const opaqueFrames: OpaqueFrame[] = [];
  collectInteractive(document, undefined, found, 0, opaqueFrames);

  const elements: SnapshotElement[] = [];
  const distance = new Map<number, number>();
  const taken = new Set<Element>();
  for (const { el, frame, frameTop } of found) {
    // A styled radio or checkbox: the input is hidden and its label is what people
    // click. The label stands in for it, described as the input (text, value, checked).
    const target = isVisible(el) ? el : labelStandIn(el);
    if (!target || taken.has(target)) continue;
    taken.add(target);
    const id = elements.length;
    registry.set(id, target);
    target.setAttribute('data-tabi-id', String(id));
    elements.push(describe(el, id, frame));
    distance.set(id, viewportDistance(target, frameTop));
  }
  return { elements, distance, opaqueFrames, remoteTexts: [] };
}

/** A hidden radio or checkbox's visible label, which selects it when clicked; null for anything else. */
function labelStandIn(el: Element): Element | null {
  if (!isChoice(el)) return null;
  for (const label of Array.from((el as HTMLInputElement).labels ?? [])) if (isVisible(label)) return label;
  return null;
}

/** Add a cross-origin frame's elements under new IDs that forward to that frame. */
export function addRemoteElements(parts: SnapshotParts, frame: OpaqueFrame, frameId: number, snap: FrameSnapshot): void {
  const frameRect = frame.iframe.getBoundingClientRect();
  const frameTop = frameRect.top + frame.iframe.clientTop;
  for (const remote of snap.elements) {
    const id = parts.elements.length;
    registry.set(id, { frameId, localId: remote.id, iframe: frame.iframe });
    const box = snap.boxes?.[remote.id];
    if (box) remoteBoxes.set(id, box);
    parts.elements.push({ ...remote, id, frame: frame.label, selector: `frame ${frameId} #${remote.id}` });
    const top = frameTop + (snap.tops[remote.id] ?? 0);
    parts.distance.set(id, top < 0 ? -top : top > window.innerHeight ? top - window.innerHeight : 0);
  }
  const text = truncate(snap.text, 1000);
  if (text) parts.remoteTexts.push(`[in frame "${frame.label}"] ${text}`);
}

/**
 * Create a compact snapshot of the page for the LLM.
 * Registers each interactive element under a numeric ID (and tags it with
 * data-tabi-id for debugging). Returns a text representation + the elements.
 * Local only; lib/agent/frames.ts adds cross-origin iframes.
 */
export function createDOMSnapshot(): { text: string; elements: SnapshotElement[] } {
  return renderSnapshot(collectLocalElements());
}

/** Turn collected parts into the budgeted text the model sees. */
export function renderSnapshot(parts: SnapshotParts): { text: string; elements: SnapshotElement[] } {
  const { elements, distance, remoteTexts } = parts;
  lastElements = elements;

  // Collect landmark text for page context
  const landmarks: string[] = [];
  document.querySelectorAll('h1, h2, h3, title').forEach(el => {
    const text = (el as HTMLElement).innerText?.trim();
    if (text && text.length > 0 && text.length < 200) {
      landmarks.push(`[${el.tagName}] ${truncate(text, 80)}`);
    }
  });

  // Build text representation
  const lines: string[] = [];
  lines.push(`PAGE: ${document.title}`);
  lines.push(`URL: ${window.location.href}`);

  if (landmarks.length > 0) {
    lines.push('');
    lines.push('--- PAGE STRUCTURE ---');
    landmarks.slice(0, 10).forEach(l => lines.push(l));
  }

  lines.push('');
  lines.push(`--- INTERACTIVE ELEMENTS (${elements.length}) ---`);

  // List as many elements as fit, nearest the viewport first, then show them
  // in page order, under a line naming their question or section when they
  // have one. Whatever is left out stays reachable through `find`.
  if (elements.some((el) => el.group)) lines.push(`Elements under a ${groupHeading('…')} line belong to that question or section.`);
  const header = lines.join('\n').length;
  let room = SNAPSHOT_BUDGET - header - MIN_TEXT_BUDGET;
  const formatted = elements.map(formatElement);
  const listed = new Set<number>();
  const headed = new Set<string>();
  const byDistance = elements.map(e => e.id).sort((a, b) => distance.get(a)! - distance.get(b)! || a - b);
  for (const id of byDistance) {
    const group = elements[id].group;
    const cost = formatted[id].length + 1 + (group && !headed.has(group) ? groupHeading(group).length + 1 : 0);
    if (cost > room) break;
    room -= cost;
    listed.add(id);
    if (group) headed.add(group);
  }
  let current: string | undefined;
  for (const el of elements) {
    if (!listed.has(el.id)) continue;
    if (el.group && el.group !== current) lines.push(groupHeading(el.group));
    current = el.group;
    lines.push(formatted[el.id]);
  }
  const omitted = elements.length - listed.size;
  if (omitted > 0) {
    lines.push(`… ${omitted} more elements are off-screen and not listed. Use {"action": "find", "text": "<words>"} to search all elements, or scroll.`);
  }

  // Add visible body text snippet for context, in whatever room is left
  const textBudget = Math.min(MAX_TEXT_CHARS, SNAPSHOT_BUDGET - lines.join('\n').length - 40);
  const textSnippet = pageText(Math.max(textBudget, 0), remoteTexts);
  if (textSnippet.length > 50) {
    lines.push('');
    lines.push('--- VISIBLE TEXT (excerpt) ---');
    lines.push(textSnippet);
  }

  return { text: lines.join('\n'), elements };
}
