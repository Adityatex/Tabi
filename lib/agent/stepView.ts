// Steps in plain words for the side panel: Clicked “Checkout”, then what
// came of it (Opened “Shipping”, or why it failed). The model's history keeps
// its own terse form (`click [3] → ✅ Clicked "Checkout"`); this is what the
// user reads. No DOM access: the runner (background) builds these.

import type { AgentAction } from '@/lib/agent/actionExecutor';

/** ok: worked. fail: didn't. skip: not run (refused, blocked, or stuck). run: under way. wait: needs the user. */
export type StepStatus = 'ok' | 'fail' | 'skip' | 'run' | 'wait';

/** Which icon a step row shows. */
export type StepIcon =
  | 'click' | 'type' | 'select' | 'navigate' | 'scroll' | 'key' | 'read' | 'find' | 'wait'
  | 'note' | 'extract' | 'code' | 'skill' | 'profile' | 'replay';

export interface StepView {
  /** Step number, from 1. */
  n: number;
  status: StepStatus;
  icon: StepIcon;
  /** What it did (or is doing), e.g. Typed your text into “Street”. */
  action: string;
  /** What came of it, e.g. Opened “Shipping”, or why it failed. */
  result: string;
  /** The element, as described for the model, e.g. <input> "Street" name="street". */
  element?: string;
  /** Which model chose it and how long the call took, e.g. Groq · qwen3 · 0.9s. */
  model?: string;
  /** The plan item it was done for, so a long run can fold finished items. */
  planItem?: string;
}

/** The plan item being worked on: the first one not ticked. */
export function currentPlanItem(plan: string[]): string | undefined {
  for (const raw of plan) {
    const m = /^\[([ xX✓]?)\]\s*(.*)$/.exec(raw.trim());
    if (!m) return raw.trim();
    if (!m[1].trim()) return m[2].trim();
  }
  return undefined;
}

const ICON: Record<AgentAction['action'], StepIcon> = {
  click: 'click', type: 'type', clear_and_type: 'type', select: 'select', navigate: 'navigate', scroll: 'scroll',
  press_key: 'key', read: 'read', find: 'find', wait: 'wait', note: 'note', extract: 'extract', run_code: 'code',
  use_skill: 'skill', use_profile: 'profile', done: 'note',
};

/** Curly quotes around UI text, cut short if long. */
export function quote(text: string, max = 60): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return `“${t.length > max ? `${t.slice(0, max - 1)}…` : t}”`;
}

/** example.com/path, for an address in a sentence. */
function shortUrl(url: string | undefined): string {
  if (!url) return 'a page';
  try {
    const u = new URL(url);
    const path = u.pathname === '/' ? '' : u.pathname;
    return `${u.host.replace(/^www\./, '')}${path.length > 30 ? `${path.slice(0, 29)}…` : path}`;
  } catch {
    return url.slice(0, 40);
  }
}

/** A typed value as the user sees it: never a password or card number. */
function typedValue(action: AgentAction, secret: boolean): string {
  return secret ? 'a password' : quote(action.text ?? '', 40);
}

/**
 * What an action did, in the past tense. `label` is its element's visible
 * label, when known; `secret` hides what was typed (passwords, card numbers).
 */
function actionWords(action: AgentAction, label: string, secret = false): string {
  const into = label ? ` into ${quote(label)}` : '';
  switch (action.action) {
    case 'click': return label ? `Clicked ${quote(label)}` : 'Clicked an element';
    case 'type': return `Typed ${typedValue(action, secret)}${into}`;
    case 'clear_and_type': return `Replaced the text${into} with ${typedValue(action, secret)}`;
    case 'select': return `Chose ${quote(action.value ?? action.text ?? '')}${label ? ` in ${quote(label)}` : ''}`;
    case 'navigate': return `Went to ${shortUrl(action.url)}`;
    case 'scroll': return `Scrolled ${action.direction === 'up' ? 'up' : 'down'}`;
    case 'press_key': return `Pressed ${action.key || 'Enter'}${label ? ` in ${quote(label)}` : ''}`;
    case 'read': return 'Read the page';
    case 'find': return `Looked for ${quote(action.text ?? '')}`;
    case 'wait': return 'Waited for the page';
    case 'note': return 'Made a note for later';
    case 'extract': return action.fields?.length ? `Collected ${action.fields.slice(0, 4).join(', ')}${action.fields.length > 4 ? '…' : ''}` : 'Collected data from the page';
    case 'run_code': return 'Ran its own read-only code on the page';
    case 'use_skill': return `Used the skill ${quote(action.text ?? '')}`;
    case 'use_profile': return 'Read your autofill profile';
    case 'done': return 'Finished';
  }
}

/** The same, under way: Clicking “Checkout”. */
function actionUnderWay(action: AgentAction, label: string, secret = false): string {
  const into = label ? ` into ${quote(label)}` : '';
  switch (action.action) {
    case 'click': return label ? `Clicking ${quote(label)}` : 'Clicking an element';
    case 'type': return `Typing ${typedValue(action, secret)}${into}`;
    case 'clear_and_type': return `Replacing the text${into}`;
    case 'select': return `Choosing ${quote(action.value ?? action.text ?? '')}`;
    case 'navigate': return `Going to ${shortUrl(action.url)}`;
    case 'scroll': return `Scrolling ${action.direction === 'up' ? 'up' : 'down'}`;
    case 'press_key': return `Pressing ${action.key || 'Enter'}`;
    case 'read': return 'Reading the page';
    case 'find': return `Looking for ${quote(action.text ?? '')}`;
    case 'wait': return 'Waiting for the page';
    case 'extract': return 'Collecting data from the page';
    case 'run_code': return 'Running its own code on the page';
    default: return actionWords(action, label, secret);
  }
}

/** A step still to do, as an instruction: Click “Place order” (a workflow's coming steps). */
export function actionToDo(action: AgentAction, label: string, secret = false): string {
  const into = label ? ` into ${quote(label)}` : '';
  switch (action.action) {
    case 'click': return label ? `Click ${quote(label)}` : 'Click an element';
    case 'type': return `Type ${typedValue(action, secret)}${into}`;
    case 'clear_and_type': return `Replace the text${into} with ${typedValue(action, secret)}`;
    case 'select': return `Choose ${quote(action.value ?? action.text ?? '')}${label ? ` in ${quote(label)}` : ''}`;
    case 'navigate': return `Go to ${shortUrl(action.url)}`;
    case 'scroll': return `Scroll ${action.direction === 'up' ? 'up' : 'down'}`;
    case 'press_key': return `Press ${action.key || 'Enter'}`;
    case 'wait': return 'Wait for the page';
    default: return actionWords(action, label, secret);
  }
}

/** Status of a step from the result the page or runner gave. */
export function statusOf(result: string): StepStatus {
  const r = result.trim();
  if (/^⛔|^⏸️|not run\b/.test(r)) return 'skip';
  if (/^❌/.test(r)) return 'fail';
  return 'ok';
}

/** The first sentence or two, for a row: no emoji, no [element numbers], no advice meant for the model. */
function cleanResult(result: string, label: string): string {
  let r = result.trim().replace(/^(✅|❌|⛔|⚠️|⏸️)\s*/u, '');
  // "element [12]" means nothing to the user: name it, or drop it
  r = r.replace(/\b(?:element|dropdown|editor)\s*\[\d+\]/gi, label ? quote(label) : 'it').replace(/\s*\[\d+\]/g, '');
  r = r.replace(/^not run:\s*/i, 'Not run: ');
  const sentence = /^(.{20,200}?[.!?])(\s|$)/.exec(r)?.[1] ?? r;
  return sentence.length > 200 ? `${sentence.slice(0, 199)}…` : sentence;
}

/** What came of an action, in a few words. */
function resultWords(action: AgentAction, result: string, label: string, secret = false): string {
  const status = statusOf(result);
  // A navigation: say where it ended up
  const landed = /now on "([^"]*)"/.exec(result);
  if (status === 'ok' && landed) return `Opened ${quote(landed[1] || 'an untitled page')}`;
  if (status === 'ok') {
    const warning = /^\s*⚠️/u.test(result);
    if (action.action === 'run_code') return /returned nothing/.test(result) ? 'It returned nothing' : 'It returned data';
    if (action.action === 'extract') return cleanResult(result, label).replace(/:.*$/, '');
    if (action.action === 'use_skill') return 'Its instructions are in use';
    if (action.action === 'use_profile') return 'Your details are in use';
    if (action.action === 'note') return quote(action.text ?? '', 80);
    // A warning says something the user should know; otherwise the action says it all
    if (warning && !secret) return cleanResult(result, label);
    return 'Done';
  }
  return cleanResult(secret && action.text ? result.split(action.text).join('••••') : result, label);
}

/** A finished step for the panel. */
export function stepView(
  n: number, action: AgentAction, result: string,
  opts: { label?: string; element?: string; model?: string; secret?: boolean; replay?: boolean } = {},
): StepView {
  const label = opts.label ?? '';
  return {
    n,
    status: statusOf(result),
    icon: opts.replay ? 'replay' : ICON[action.action],
    action: actionWords(action, label, opts.secret),
    result: resultWords(action, result, label, opts.secret),
    ...(opts.element ? { element: opts.element } : {}),
    ...(opts.model ? { model: opts.model } : {}),
  };
}

/** The step under way, shown last while it runs. */
export function stepUnderWay(n: number, action: AgentAction, opts: { label?: string; secret?: boolean } = {}): StepView {
  return { n, status: 'run', icon: ICON[action.action], action: actionUnderWay(action, opts.label ?? '', opts.secret), result: 'Working…' };
}

/** Steps kept in a run's view; older ones are summed up in one row. */
const MAX_VIEW_STEPS = 200;

/** Earlier steps that don't fit, counted: "6 earlier steps · all succeeded". */
export interface HiddenSteps {
  count: number;
  failed: number;
}

/** The last MAX_VIEW_STEPS steps, and a count of the ones before. */
export function trimSteps(steps: StepView[], max = MAX_VIEW_STEPS): { steps: StepView[]; hidden?: HiddenSteps } {
  if (steps.length <= max) return { steps };
  const cut = steps.slice(0, steps.length - max);
  return { steps: steps.slice(-max), hidden: { count: cut.length, failed: cut.filter((s) => s.status === 'fail').length } };
}
