// What the side panel derives from a run (lib/agent/runner.ts RunView): the
// mark's state, the status pill, the plan as items, the kind of failure. Pure
// functions, so they're unit-tested apart from React.

import type { RunView } from '@/lib/agent/runner';
import type { TabiMarkState } from '@/components/TabiMark';
import type { StepView } from '@/lib/agent/stepView';

/** The mark follows the current tab's task. */
export function markState(run: RunView | null): TabiMarkState {
  if (!run) return 'idle';
  switch (run.status) {
    case 'running': return run.phase === 'reading' ? 'reading' : run.phase === 'thinking' ? 'thinking' : 'acting';
    case 'paused': return 'waiting';
    case 'done': return 'done';
    case 'error': return 'failed';
    case 'stopped': return run.outcome && /block list/.test(run.outcome) ? 'failed' : 'stopped';
    default: return 'idle';
  }
}

export type PillTone = 'running' | 'replay' | 'waiting' | 'done' | 'failed' | 'neutral';

/** The goal card's status pill. */
export function statusPill(run: RunView): { tone: PillTone; label: string } {
  switch (run.status) {
    case 'running':
      if (run.replay === 'replaying') return { tone: 'replay', label: 'Replaying · no AI calls' };
      if (run.replay === 'healed') return { tone: 'running', label: 'Healed · AI on' };
      return { tone: 'running', label: 'Running' };
    case 'paused': return { tone: 'waiting', label: run.asking ? 'Needs your OK' : 'Paused' };
    case 'done': return { tone: 'done', label: 'Done' };
    case 'error': return { tone: 'failed', label: 'Failed' };
    case 'queued': return { tone: 'neutral', label: 'Waiting' };
    default: return /block list/.test(run.outcome ?? '') ? { tone: 'failed', label: 'Blocked' } : { tone: 'neutral', label: run.outcome ? 'Stopped' : 'Stopped by you' };
  }
}

export interface PlanItem {
  text: string;
  state: 'done' | 'current' | 'todo';
  /** Looks like something that can't be undone, so the agent will ask first. */
  irreversible: boolean;
}

/** Plan items worded like a purchase, payment, message, deletion or booking. */
const IRREVERSIBLE = /\b(place|submit|confirm|complete) (the |my |your )?(order|purchase|payment|booking|application)\b|^(buy|pay|send|post|publish|delete|book|reserve|transfer)\b|\bpay for\b/i;

/**
 * "[x] Open the cart" / "[ ] Check out": the first unticked item is the
 * current one. A finished task's plan is all done, ticked or not.
 */
export function planItems(plan: string[], finished = false): PlanItem[] {
  let current = false;
  return plan.map((raw) => {
    const m = /^\[([ xX✓]?)\]\s*(.*)$/.exec(raw.trim());
    const ticked = finished || !!m?.[1].trim();
    const text = (m ? m[2] : raw).trim();
    let state: PlanItem['state'] = 'todo';
    if (ticked) state = 'done';
    else if (!current) {
      state = 'current';
      current = true;
    }
    return { text, state, irreversible: IRREVERSIBLE.test(text) };
  });
}

/** "1:42", "12:05", "1:02:09" */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

export type FailureKind = 'bad_key' | 'rate_limit' | 'model' | 'setup' | 'page_load' | 'other';

/** What went wrong, from a failed run's error, to pick the card and its fix. */
export function failureKind(error: string | undefined): FailureKind {
  const e = error ?? '';
  if (/rejected the API key|invalid[_ ]api[_ ]key|\b401\b|\b403\b/i.test(e)) return 'bad_key';
  if (/rate limit|daily limit|\b429\b|quota/i.test(e)) return 'rate_limit';
  if (/doesn't offer the model|model_not_found/i.test(e)) return 'model';
  if (/No API key|Choose a .* model|Set the server URL/i.test(e)) return 'setup';
  if (/timed out|didn't load|could not read the page|not load/i.test(e)) return 'page_load';
  return 'other';
}

/** The host of a URL without www, or '' for pages Tabi can't work on. */
export function siteOf(url: string | undefined): string {
  try {
    const u = new URL(url ?? '');
    return /^https?:$/.test(u.protocol) ? u.host.replace(/^www\./, '') : '';
  } catch {
    return '';
  }
}

/** Path, query and fragment, for the site row. */
export function pathOf(url: string | undefined): string {
  try {
    const u = new URL(url ?? '');
    return `${u.pathname}${u.search}${u.hash}`;
  } catch {
    return '';
  }
}

/** "2m ago", "Yesterday", "Mon", "Sep 28" */
export function when(at: number, now = Date.now()): string {
  const ago = now - at;
  if (ago < 60_000) return 'just now';
  if (ago < 3_600_000) return `${Math.floor(ago / 60_000)}m ago`;
  const d = new Date(at);
  const today = new Date(now);
  if (d.toDateString() === today.toDateString()) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (new Date(now - 86_400_000).toDateString() === d.toDateString()) return 'Yesterday';
  if (ago < 6 * 86_400_000) return d.toLocaleDateString([], { weekday: 'short' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

/** Past this many steps, a run's finished plan items fold into one row each. */
export const LONG_RUN = 50;

/** A row of a long run's step stream: a folded plan item, a count of older steps, or a step. */
export type FoldRow =
  | { kind: 'item'; text: string; count: number; failed: number; current: boolean; steps: StepView[] }
  | { kind: 'earlier'; count: number; failed: number }
  | { kind: 'step'; step: StepView };

/**
 * A long run, folded: each finished plan item becomes one row ("Search three
 * job boards · 14 steps"), the current item shows its count and its last
 * `keep` steps, with "N earlier in this item" before them. Steps from before
 * the run had a plan, or trimmed away, are counted in one row.
 */
export function foldLongRun(steps: StepView[], hidden: { count: number; failed: number } | undefined, keep = 3): FoldRow[] {
  const rows: FoldRow[] = [];
  if (hidden?.count) rows.push({ kind: 'earlier', count: hidden.count, failed: hidden.failed });
  // Consecutive steps for the same plan item form a group
  const groups: { text?: string; steps: StepView[] }[] = [];
  for (const step of steps) {
    const last = groups[groups.length - 1];
    if (last && last.text === step.planItem) last.steps.push(step);
    else groups.push({ text: step.planItem, steps: [step] });
  }
  groups.forEach((group, i) => {
    const failed = group.steps.filter((s) => s.status === 'fail').length;
    const current = i === groups.length - 1;
    if (!current) {
      if (group.text) rows.push({ kind: 'item', text: group.text, count: group.steps.length, failed, current: false, steps: group.steps });
      else rows.push({ kind: 'earlier', count: group.steps.length, failed });
      return;
    }
    if (group.text) rows.push({ kind: 'item', text: group.text, count: group.steps.length, failed, current: true, steps: group.steps });
    const shown = group.steps.slice(-keep);
    const before = group.steps.length - shown.length;
    if (before > 0) rows.push({ kind: 'earlier', count: before, failed: group.steps.slice(0, before).filter((s) => s.status === 'fail').length });
    for (const step of shown) rows.push({ kind: 'step', step });
  });
  return rows;
}

/** A place on the page an answer came from: a short name, and words copied from it to find it again. */
export interface Source {
  label: string;
  quote: string;
}

/** An answer and its "SOURCES:" lines (see chatWithPage), apart. Without them, the answer as it is. */
export function splitSources(text: string): { answer: string; sources: Source[] } {
  const m = /\n\s*(?:\*\*)?SOURCES:?(?:\*\*)?:?\s*\n([\s\S]*)$/i.exec(text);
  if (!m) return { answer: text, sources: [] };
  const sources = m[1].split('\n')
    .map((line) => /^\s*[-*\d.)]*\s*(.+?)\s*\|\s*(.+?)\s*$/.exec(line))
    .filter((x): x is RegExpExecArray => !!x)
    .map((x) => ({ label: x[1].replace(/\*\*/g, ''), quote: x[2].replace(/^["“'`]+|["”'`]+$/g, '') }))
    .filter((s) => s.quote.length >= 3)
    .slice(0, 3);
  return { answer: text.slice(0, m.index).trimEnd(), sources };
}
