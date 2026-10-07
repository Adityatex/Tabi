// lib/history/view.ts
// The History page's view of saved runs (lib/agent/timeline.ts): runs grouped
// by day and filtered, and a run's timeline as the page shows it. Routine
// stretches (steps that worked and the model calls between them) fold into
// one row; what matters stays in view: the plan, failures, a backup model
// taking over, safety checks, questions to the user, and the end.
// No DOM access, so it's unit-tested.

import type { StepStatus } from '@/lib/agent/stepView';
import type { RunLog, TimelineEntry } from '@/lib/agent/timeline';

export type RunHeader = Omit<RunLog, 'entries'> & { entryCount: number };

// ---- The list of runs

export type RunFilter = 'all' | 'done' | 'failed' | 'scheduled' | 'mcp';

export const FILTERS: [RunFilter, string][] = [
  ['all', 'All'], ['done', 'Done'], ['failed', 'Failed'], ['scheduled', 'Scheduled'], ['mcp', 'From AI apps'],
];

/** Does this run pass the filter chip and the search box? */
export function matchesRun(run: RunHeader, filter: RunFilter, query: string): boolean {
  const ok = filter === 'all' ? true
    : filter === 'done' ? run.status === 'done' && !!run.ended
    : filter === 'failed' ? run.status === 'error'
    : filter === 'scheduled' ? run.source === 'schedule'
    : run.source === 'mcp';
  const q = query.trim().toLowerCase();
  return ok && (!q || run.goal.toLowerCase().includes(q) || (run.workflow ?? '').toLowerCase().includes(q));
}

/** "Today", "Yesterday", "Monday" (this past week), "28 Sep", "28 Sep 2025" */
export function dayLabel(at: number, now = Date.now()): string {
  const d = new Date(at);
  const today = new Date(now);
  if (d.toDateString() === today.toDateString()) return 'Today';
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  const midnight = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  if (at < now && midnight - at < 6 * 86_400_000) return d.toLocaleDateString([], { weekday: 'long' });
  return d.toLocaleDateString([], { day: 'numeric', month: 'short', ...(d.getFullYear() === today.getFullYear() ? {} : { year: 'numeric' }) });
}

/** Runs (newest first) under their day. */
export function groupByDay<T extends { started: number }>(runs: T[], now = Date.now()): { day: string; runs: T[] }[] {
  const days: { day: string; runs: T[] }[] = [];
  for (const run of runs) {
    const day = dayLabel(run.started, now);
    if (days.at(-1)?.day === day) days.at(-1)!.runs.push(run);
    else days.push({ day, runs: [run] });
  }
  return days;
}

/** The icon a run gets: how it ended, or that it's still going. */
export type RunMark = 'done' | 'failed' | 'stopped' | 'replay' | 'running' | 'waiting' | 'queued';

export function runMark(run: Pick<RunHeader, 'status' | 'ended' | 'workflow' | 'calls'>): RunMark {
  if (!run.ended) return run.status === 'paused' ? 'waiting' : run.status === 'queued' ? 'queued' : 'running';
  if (run.status === 'done') return run.workflow && run.calls === 0 ? 'replay' : 'done';
  return run.status === 'error' ? 'failed' : 'stopped';
}

/** "· background", "· scheduled", "· from an AI app", plus the workflow it replayed. */
export function runTags(run: Pick<RunHeader, 'source' | 'workflow'>): string[] {
  const tags = [];
  if (run.workflow) tags.push(`/${run.workflow}`);
  if (run.source === 'background') tags.push('background');
  if (run.source === 'schedule') tags.push('scheduled');
  if (run.source === 'mcp') tags.push('from an AI app');
  return tags;
}

/** How the run got started, for the page's header line. */
export function startedFrom(source: RunHeader['source']): string {
  switch (source) {
    case 'panel': return 'started from the side panel';
    case 'background': return 'run in a background tab';
    case 'schedule': return 'run on a schedule';
    case 'mcp': return 'started by an AI app';
    default: return '';
  }
}

/** "9 AI calls", "1 AI call", "no AI calls" */
export function callsLabel(calls: number): string {
  return calls === 0 ? 'no AI calls' : `${calls} AI call${calls === 1 ? '' : 's'}`;
}

/** 980, 41.2k, 1.3M */
export function compactNumber(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0).replace(/\.0$/, '')}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
}

// ---- A run's timeline

/** A step as the page shows it: from the saved plain words, or (older runs) from the model's terse line. */
export interface StepLine {
  n: number;
  status: StepStatus;
  action: string;
  result: string;
  element?: string;
}

/** Old runs saved only `click [3] → ✅ Clicked "Sign in"`: the action, and what came of it. */
export function stepFromText(text: string, n: number): StepLine {
  const [action, ...rest] = text.replace(/^↻\s*/, '').split(' → ');
  const raw = rest.join(' → ').trim();
  const status: StepStatus = /^❌/.test(raw) ? 'fail' : /^(⛔|⏸️)|not run/.test(raw) ? 'skip' : 'ok';
  return { n, status, action: action.trim(), result: raw.replace(/^(✅|❌|⛔|⏸️)\s*/u, '') };
}

export type TimelineNode =
  | { kind: 'model'; entry: TimelineEntry; first: boolean }
  | { kind: 'step'; entry: TimelineEntry; step: StepLine }
  | { kind: 'fold'; nodes: TimelineNode[]; from: number; to: number; worked: number; calls: number; start: number; end: number }
  | { kind: 'handoff'; entry: TimelineEntry; text: string }
  | { kind: 'said'; entry: TimelineEntry; text: string }
  | { kind: 'note'; entry: TimelineEntry; text: string }
  | { kind: 'check'; entry: TimelineEntry; ok: boolean; step: string; reason: string }
  | { kind: 'ask'; entry: TimelineEntry; question: string; why: string; answer: string; allowed: boolean | null }
  | { kind: 'pause'; entry: TimelineEntry; question: string; answer: string }
  | { kind: 'end'; entry: TimelineEntry; status: 'done' | 'failed' | 'stopped' };

const NOTE = /^\((note from Tabi|invalid response)\)\s*/;
const SAID = /^\(note from Tabi\) The user says: "?([\s\S]*?)"?$/;

/** "Asked to allow: click “Place order”" → "Allow Tabi to click “Place order”?" */
function askQuestion(text: string): string {
  const action = text.replace(/^Asked to allow:\s*/, '').trim();
  return `Allow Tabi to ${action.charAt(0).toLowerCase()}${action.slice(1)}?`;
}

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** The detail line "why. Answer: you allowed it" split in two. */
function splitAnswer(detail: string | undefined): { why: string; answer: string } {
  const m = /^(?:([\s\S]*?)\.\s+)?Answer:\s*([\s\S]*)$/.exec(detail ?? '');
  return m ? { why: m[1] ? `${capital(m[1].trim())}.` : '', answer: m[2].trim() } : { why: detail ?? '', answer: '' };
}

/** Each entry as the page shows it, before folding. */
export function timelineNodes(entries: TimelineEntry[]): TimelineNode[] {
  const nodes: TimelineNode[] = [];
  let steps = 0;
  let models = 0;
  for (const entry of entries) {
    switch (entry.kind) {
      case 'step': {
        steps++;
        nodes.push({ kind: 'step', entry, step: entry.step ? { ...entry.step, n: steps } : stepFromText(entry.text, steps) });
        break;
      }
      case 'model':
        nodes.push({ kind: 'model', entry, first: models++ === 0 });
        break;
      case 'note': {
        if (entry.text.startsWith('(handoff)')) {
          const text = entry.text.replace(/^\(handoff\)\s*/, '').split(' This task is already under way')[0].trim();
          nodes.push({ kind: 'handoff', entry, text });
          break;
        }
        const said = SAID.exec(entry.text);
        if (said) nodes.push({ kind: 'said', entry, text: said[1] });
        else nodes.push({ kind: 'note', entry, text: entry.text.replace(NOTE, '') });
        break;
      }
      case 'check': {
        const ok = !entry.text.startsWith("Doesn't");
        const step = entry.text.replace(/^(Fits the task|Doesn't fit the task):\s*/, '');
        const reason = ok ? (entry.detail ?? '').replace(/^Checked because\s*/, '') : (entry.detail ?? '').replace(/\s*\(checked because [^)]*\)$/, '');
        nodes.push({ kind: 'check', entry, ok, step, reason });
        break;
      }
      case 'ask': {
        const { why, answer } = splitAnswer(entry.detail);
        const allowed = /^you allowed/.test(answer) ? true : /^you (didn't|stopped)|^no answer/.test(answer) ? false : null;
        nodes.push({ kind: 'ask', entry, question: askQuestion(entry.text), why, answer, allowed });
        break;
      }
      case 'pause':
        nodes.push({ kind: 'pause', entry, question: entry.text, answer: splitAnswer(entry.detail).answer });
        break;
      case 'end':
        nodes.push({ kind: 'end', entry, status: entry.text === 'Finished' ? 'done' : entry.text === 'Failed' ? 'failed' : 'stopped' });
        break;
    }
  }
  return nodes;
}

/**
 * Routine stretches folded: steps that worked, the model calls between them
 * and Tabi's notes to the model, when there are at least `min` steps. Left
 * out of folds: the first model call (it made the plan), a model call right
 * after a failure or a handoff (it decided what to do about it), and a step
 * right after the user was asked (the thing they allowed).
 */
export function foldTimeline(nodes: TimelineNode[], min = 2): TimelineNode[] {
  const pinned = (node: TimelineNode, prev: TimelineNode | undefined): boolean => {
    if (node.kind === 'model') return node.first || prev?.kind === 'handoff' || (prev?.kind === 'step' && prev.step.status === 'fail');
    if (node.kind === 'step') return prev?.kind === 'ask' || prev?.kind === 'pause';
    return false;
  };
  const quiet = (node: TimelineNode) =>
    node.kind === 'model' || node.kind === 'note' && !/^\(\d+ entries/.test(node.text) || node.kind === 'step' && node.step.status === 'ok';

  const out: TimelineNode[] = [];
  let group: TimelineNode[] = [];
  const flush = () => {
    const steps = group.filter((n): n is Extract<TimelineNode, { kind: 'step' }> => n.kind === 'step');
    if (steps.length >= min) {
      out.push({
        kind: 'fold', nodes: group, from: steps[0].step.n, to: steps.at(-1)!.step.n, worked: steps.length,
        calls: group.filter((n) => n.kind === 'model').length, start: entryOf(group[0]).at, end: entryOf(group.at(-1)!).at,
      });
    } else {
      out.push(...group);
    }
    group = [];
  };
  nodes.forEach((node, i) => {
    if (quiet(node) && !pinned(node, nodes[i - 1])) {
      group.push(node);
    } else {
      flush();
      out.push(node);
    }
  });
  flush();
  return out;
}

function entryOf(node: TimelineNode): TimelineEntry {
  return node.kind === 'fold' ? entryOf(node.nodes[0]) : node.entry;
}

/** What the model saw change since the last step, from a model entry's detail. */
export interface SeenChanges {
  /** The page's title. */
  page?: string;
  lines: { sign: '+' | '−' | ''; text: string }[];
}

export function seenChanges(detail: string | undefined): SeenChanges {
  const out: SeenChanges = { lines: [] };
  if (!detail) return out;
  let mode: '+' | '' = '';
  for (const raw of detail.split('\n')) {
    const line = raw.trim();
    if (!line || /^---.*---$/.test(line)) continue;
    if (line.startsWith('Nothing visible changed')) { out.lines.push({ sign: '', text: 'Nothing visible changed' }); continue; }
    const page = /^On "(.*)"$/.exec(line);
    if (page) { out.page = page[1]; continue; }
    if (line.startsWith('New elements:')) { mode = '+'; continue; }
    const m = /^(New text|Text gone|Gone):\s*(.*)$/.exec(line);
    if (m) {
      mode = '';
      const sign = m[1] === 'New text' ? '+' : '−';
      for (const part of m[2].split(m[1] === 'Gone' ? /;\s*/ : /\s+\|\s+/)) if (part) out.lines.push({ sign, text: part });
      continue;
    }
    out.lines.push({ sign: mode, text: line });
  }
  return out;
}

/** Stats for the strip under the title. */
export function runStats(log: RunLog): { steps: number; failed: number } {
  let steps = 0;
  let failed = 0;
  for (const node of timelineNodes(log.entries)) {
    if (node.kind !== 'step') continue;
    steps++;
    if (node.step.status === 'fail') failed++;
  }
  return { steps, failed };
}

/** The site a run worked on: the first web page in its timeline. */
export function runSite(log: RunLog): string {
  for (const e of log.entries) {
    try {
      const u = new URL(e.url ?? '');
      if (/^https?:$/.test(u.protocol)) return u.host.replace(/^www\./, '');
    } catch { /* not a web page */ }
  }
  return '';
}
