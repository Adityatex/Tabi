// The run timeline: a saved, step-by-step record of each agent run, for the
// History page. The chat shows a run while it's open; this keeps what a
// background or scheduled task did after its tab is gone. Text only, kept on
// this device (chrome.storage.local), the last MAX_RUNS runs, with typed
// passwords and card numbers masked.

import type { RunStatus } from '@/lib/agent/runner';
import type { StepStatus } from '@/lib/agent/stepView';

export const RUNS_KEY = 'tabi_runs';
/** Runs kept; older ones are dropped. */
export const MAX_RUNS = 50;
/** Entries kept per run; a very long run keeps its first ones and its last ones. */
const MAX_ENTRIES = 400;

/**
 * step: an action and what came of it. note: Tabi telling the model
 * something. model: a call to a model. check: the safety check. ask: the
 * agent asked the user to allow something. pause: a checkpoint or stuck pause.
 * end: how the run ended.
 */
export type EntryKind = 'step' | 'note' | 'model' | 'check' | 'ask' | 'pause' | 'end';

export interface TimelineEntry {
  at: number;
  kind: EntryKind;
  /** What happened, in one line. */
  text: string;
  /** More: what the model saw change, why a check said no, how the user answered. */
  detail?: string;
  /** The page it happened on. */
  url?: string;
  /** Which model answered (model entries). */
  model?: string;
  /** How long it took: a model call, or waiting for the user. */
  ms?: number;
  /** Tokens the call used, if the provider reported them. */
  tokens?: number;
  /** Steps: the element acted on, by its visible label ("Sign in"), since its [number] means nothing later. */
  target?: string;
  /** Steps: the step in plain words, as the side panel showed it (lib/agent/stepView.ts). Runs saved before have only `text`. */
  step?: { n: number; status: StepStatus; action: string; result: string; element?: string };
}

/** Where a task came from: the side panel, a background tab, a schedule, or an AI app through MCP. */
export type RunSource = 'panel' | 'background' | 'schedule' | 'mcp';

export interface RunLog {
  id: string;
  goal: string;
  started: number;
  ended?: number;
  status: RunStatus;
  /** How it ended, in a line or two. */
  summary?: string;
  /** The saved workflow it replayed, if it did. */
  workflow?: string;
  /** Where it came from (runs saved before this was kept have none). */
  source?: RunSource;
  /** The plan as it ended, items ticked [x] when done. */
  plan?: string[];
  /** Model calls the agent made (safety checks not included). */
  calls: number;
  /** Safety checks made. */
  checks: number;
  /** Tokens across the agent's calls, where the provider reports them. */
  tokens: number;
  entries: TimelineEntry[];
}

/** History lines Tabi wrote to the model, rather than steps the agent took. */
export function entryKindOf(line: string): 'step' | 'note' {
  return /^\((note from Tabi|invalid response)\)/.test(line) ? 'note' : 'step';
}

/** A very long run: keep the start and the end, and say how many were left out between. */
export function capEntries(entries: TimelineEntry[], max = MAX_ENTRIES): TimelineEntry[] {
  if (entries.length <= max) return entries;
  const head = Math.floor(max / 4);
  const tail = max - head - 1;
  const skipped = entries.length - head - tail;
  const gap: TimelineEntry = { at: entries[head].at, kind: 'note', text: `(${skipped} entries in the middle of this long run were not kept)` };
  return [...entries.slice(0, head), gap, ...entries.slice(-tail)];
}

/** Replace typed secrets (passwords, card numbers) everywhere in a log. */
export function maskSecrets(log: RunLog, secrets: Iterable<string>): RunLog {
  const list = [...secrets].filter((s) => s.length >= 3).sort((a, b) => b.length - a.length);
  if (list.length === 0) return log;
  const mask = (text: string | undefined) => {
    if (text === undefined) return text;
    let out = text;
    for (const secret of list) out = out.split(secret).join('••••');
    return out;
  };
  return {
    ...log,
    goal: mask(log.goal)!,
    summary: mask(log.summary),
    plan: log.plan?.map((item) => mask(item)!),
    entries: log.entries.map((e) => ({
      ...e, text: mask(e.text)!, detail: mask(e.detail),
      ...(e.step ? { step: { ...e.step, action: mask(e.step.action)!, result: mask(e.step.result)!, element: mask(e.step.element) } } : {}),
    })),
  };
}

/**
 * Most characters of saved timelines: chrome.storage.local holds about 10 MB
 * for the whole extension, and settings, skills and workflows live there too.
 */
const MAX_STORED_CHARS = 4_000_000;

/** The stored list with this run added or updated: newest first, at most `max` runs and MAX_STORED_CHARS. */
export function upsertRun(list: RunLog[], log: RunLog, max = MAX_RUNS, maxChars = MAX_STORED_CHARS): RunLog[] {
  const runs = [log, ...list.filter((r) => r.id !== log.id)].sort((a, b) => b.started - a.started).slice(0, max);
  // Over the budget: drop the oldest runs (never the newest)
  let size = runs.reduce((n, r) => n + JSON.stringify(r).length, 0);
  while (runs.length > 1 && size > maxChars) size -= JSON.stringify(runs.pop()).length;
  return runs;
}

/** A run without its entries, for the list of runs. */
export function runHeader(log: RunLog): Omit<RunLog, 'entries'> & { entryCount: number } {
  const { entries, ...header } = log;
  return { ...header, entryCount: entries.length };
}

const clock = (at: number) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

/** "4.2s", "1m 05s" */
export function formatDuration(ms: number): string {
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

const LABEL: Record<EntryKind, string> = {
  step: 'Step', note: 'Note', model: 'Model', check: 'Safety check', ask: 'Asked you', pause: 'Paused', end: 'End',
};

/** A run as Markdown, for the Export button (bug reports, keeping a record). */
export function formatRunLog(log: RunLog): string {
  const took = log.ended ? formatDuration(log.ended - log.started) : 'still running';
  const lines = [
    `# Tabi run: ${log.goal}`,
    '',
    `- **Started:** ${new Date(log.started).toLocaleString()}`,
    `- **Status:** ${log.status}${log.summary ? `: ${log.summary}` : ''}`,
    `- **Took:** ${took} · ${log.calls} model call${log.calls === 1 ? '' : 's'}${log.tokens ? ` · ${log.tokens.toLocaleString()} tokens` : ''}${log.checks ? ` · ${log.checks} safety check${log.checks === 1 ? '' : 's'}` : ''}`,
    ...(log.workflow ? [`- **Workflow:** /${log.workflow}`] : []),
    '',
    '| Time | What | Details |',
    '|---|---|---|',
  ];
  const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\n+/g, ' ');
  for (const e of log.entries) {
    const extra = [e.target ? `on "${e.target}"` : '', e.model, e.ms !== undefined ? formatDuration(e.ms) : '', e.tokens ? `${e.tokens} tokens` : '', e.url ?? '', e.detail ?? '']
      .filter(Boolean).join(' · ');
    lines.push(`| ${clock(e.at)} | **${LABEL[e.kind]}:** ${cell(e.text)} | ${cell(extra)} |`);
  }
  return lines.join('\n');
}
