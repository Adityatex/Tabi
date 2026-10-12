// Small helpers shared by the side panel and the agent runner
// (background). No DOM access, so both bundles can import it.

import type { AgentAction } from '@/lib/agent/actionExecutor';

/** Consecutive unparseable/invalid model responses tolerated before aborting. */
export const MAX_INVALID_RESPONSES = 3;

/**
 * There is no step limit. A run ends when the model says "done" or the user
 * stops it, and pauses when it looks stuck: the same action on the same,
 * unchanged page. The second time the model is warned, the third time the run
 * pauses and asks the user.
 */
export const REPEAT_WARN = 2;
export const REPEAT_PAUSE = 3;

/** How much history the model sees: every note, plus at least this many recent steps. */
export const PROMPT_RECENT_STEPS = 25;
/**
 * Older steps are dropped this many at a time, so the history's beginning
 * stays the same for several calls in a row (a prompt-cache hit), instead of
 * shifting on every step.
 */
const PROMPT_TRIM_BLOCK = 10;

export function isAgentCommand(msg: string): boolean {
  const actionWords = /\b(go to|open|navigate|click|search|find|type|fill|submit|scroll|press|select|visit|browse|download|sign in|log in|sign up|play|watch|buy|add to cart|checkout|subscribe)\b/i;
  const urlPattern = /\b(https?:\/\/|www\.)/i;
  return actionWords.test(msg) || urlPattern.test(msg);
}

export function formatHistory(actionHistory: string[]): string {
  return actionHistory.map((a, i) => `${i + 1}. ${a}`).join('\n');
}

/**
 * Numbered history lines for the model. Long runs would otherwise resend every
 * step on every call, so older steps are left out, except notes: those hold
 * the facts the model wrote down to use later.
 */
export function promptHistory(actionHistory: string[]): string[] {
  const excess = Math.max(0, actionHistory.length - PROMPT_RECENT_STEPS);
  const firstRecent = Math.floor(excess / PROMPT_TRIM_BLOCK) * PROMPT_TRIM_BLOCK;
  const lines: string[] = [];
  let skipped = 0;
  actionHistory.forEach((entry, i) => {
    if (i < firstRecent && !entry.startsWith('note ')) {
      skipped++;
      return;
    }
    if (skipped) lines.push(`(${skipped} earlier step${skipped === 1 ? '' : 's'} not shown)`);
    skipped = 0;
    lines.push(`${i + 1}. ${entry}`);
  });
  return lines;
}

/** One-line description of an action for the history, e.g. `type [3] "Ada"`. */
export function describeAction(action: AgentAction): string {
  // Code is long: the log shows its first line, the model its result
  if (action.action === 'run_code') {
    const lines = (action.text ?? '').trim().split('\n');
    const first = lines[0].slice(0, 80);
    return `run_code "${first}${lines.length > 1 || lines[0].length > 80 ? '…' : ''}" (${lines.length} line${lines.length === 1 ? '' : 's'})`;
  }
  let desc = action.action;
  if (action.elementId !== undefined) desc += ` [${action.elementId}]`;
  if (action.text) desc += ` "${action.text}"`;
  if (action.value) desc += ` "${action.value}"`;
  if (action.key) desc += ` key=${action.key}`;
  if (action.url) desc += ` ${action.url}`;
  if (action.fields) desc += ` fields=${action.fields.join(',')}${action.follow ? ' +follow' : ''}`;
  return desc;
}
