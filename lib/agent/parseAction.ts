// Parses + validates the planner LLM's raw output into an AgentAction.
// Invalid output is reported as an error instead of being treated as "done".

import type { AgentAction } from '@/lib/agent/actionExecutor';

export type ParseResult =
  | { ok: true; action: AgentAction }
  | { ok: false; error: string };

const ACTIONS: ReadonlySet<AgentAction['action']> = new Set([
  'click', 'type', 'clear_and_type', 'select', 'navigate',
  'scroll', 'read', 'wait', 'done', 'press_key', 'find', 'note', 'use_skill', 'extract', 'run_code',
]);

/**
 * Return the first balanced top-level JSON object in `text`, skipping braces
 * inside string literals. Handles code fences and prose around the JSON.
 */
export function extractFirstJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return text.slice(start, i + 1);
  }
  return null;
}

function toElementId(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return value;
  // Models often quote numbers: "12" or "[12]"
  if (typeof value === 'string') {
    const m = value.trim().match(/^\[?(\d+)\]?$/);
    if (m) return Number(m[1]);
  }
  return undefined;
}

function optionalString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  return typeof value === 'string' ? value : String(value);
}

export function parseAgentAction(raw: string): ParseResult {
  const json = extractFirstJsonObject(raw);
  if (!json) return { ok: false, error: `No JSON object in model response: ${raw.slice(0, 200)}` };

  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(json);
  } catch {
    return { ok: false, error: `Malformed JSON in model response: ${json.slice(0, 200)}` };
  }

  const name = obj.action as AgentAction['action'];
  if (typeof name !== 'string' || !ACTIONS.has(name)) {
    return { ok: false, error: `Unknown action "${String(obj.action)}"` };
  }

  const action: AgentAction = { action: name };
  const elementId = toElementId(obj.elementId);
  if (elementId !== undefined) action.elementId = elementId;
  // Models sometimes call find's search text "query"
  const text = optionalString(obj.text ?? (name === 'find' ? obj.query : undefined));
  if (text !== undefined) action.text = text;
  const value = optionalString(obj.value);
  if (value !== undefined) action.value = value;
  const key = optionalString(obj.key);
  if (key !== undefined) action.key = key;
  const summary = optionalString(obj.summary);
  if (summary !== undefined) action.summary = summary;
  if (name === 'extract') {
    // A list, or a comma-separated string
    const raw = Array.isArray(obj.fields) ? obj.fields : typeof obj.fields === 'string' ? obj.fields.split(',') : [];
    const fields = raw.map((f) => String(f).trim()).filter(Boolean).slice(0, 10);
    if (fields.length) action.fields = fields;
    if (obj.follow === true || obj.follow === 'true') action.follow = true;
  }

  switch (name) {
    case 'click':
      if (action.elementId === undefined) return { ok: false, error: 'click requires a numeric elementId' };
      break;
    case 'type':
    case 'clear_and_type':
      if (action.elementId === undefined) return { ok: false, error: `${name} requires a numeric elementId` };
      if (action.text === undefined) return { ok: false, error: `${name} requires text` };
      break;
    case 'select':
      if (action.elementId === undefined) return { ok: false, error: 'select requires a numeric elementId' };
      if (action.value === undefined) return { ok: false, error: 'select requires a value' };
      break;
    case 'navigate': {
      const url = optionalString(obj.url);
      let parsed: URL;
      try {
        parsed = new URL(url ?? '');
      } catch {
        return { ok: false, error: `navigate requires a full URL, got "${url}"` };
      }
      // Never let the model navigate to javascript:, data:, chrome:, file:, etc.
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return { ok: false, error: `navigate only allows http(s) URLs, got "${parsed.protocol}"` };
      }
      action.url = parsed.href;
      break;
    }
    case 'note':
      if (!action.text?.trim()) return { ok: false, error: 'note requires text to remember' };
      break;
    case 'find':
      if (!action.text?.trim()) return { ok: false, error: 'find requires text to search for' };
      break;
    case 'extract':
      if (!action.fields?.length) return { ok: false, error: 'extract requires fields: the things to collect, e.g. ["name", "price"]' };
      break;
    case 'run_code':
      if (!action.text?.trim()) return { ok: false, error: 'run_code requires the code as text' };
      break;
    case 'use_skill':
      if (!action.text?.trim()) return { ok: false, error: 'use_skill requires the skill name as text' };
      break;
    case 'scroll':
      action.direction = obj.direction === 'up' ? 'up' : 'down';
      break;
  }

  return { ok: true, action };
}

/** Most actions the model may send in one response. */
export const MAX_BATCH = 6;
/** Most plan items kept (and shown). */
const MAX_PLAN_ITEMS = 12;

export type ResponseParseResult =
  | { ok: true; actions: AgentAction[]; plan?: string[]; notes: string[] }
  | { ok: false; error: string };

/**
 * Parse a planner response: {"plan": [...], "actions": [{...}, ...]}, or a
 * single action object (older format, and what weaker models fall back to).
 * `notes` explain anything the runner dropped, for the model's history.
 */
export function parseAgentResponse(raw: string): ResponseParseResult {
  const json = extractFirstJsonObject(raw);
  if (!json) return { ok: false, error: `No JSON object in model response: ${raw.slice(0, 200)}` };

  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(json);
  } catch {
    return { ok: false, error: `Malformed JSON in model response: ${json.slice(0, 200)}` };
  }

  const plan = Array.isArray(obj.plan)
    ? obj.plan.map((item) => optionalString(item)?.trim()).filter((item): item is string => !!item).slice(0, MAX_PLAN_ITEMS)
    : undefined;

  if (!Array.isArray(obj.actions)) {
    if (obj.action === undefined) return { ok: false, error: 'Response has no "actions" list' };
    const single = parseAgentAction(json);
    return single.ok ? { ok: true, actions: [single.action], plan, notes: [] } : single;
  }
  if (obj.actions.length === 0) {
    // A plan on its own is progress (tool callers often start with just set_plan)
    if (plan?.length) return { ok: true, actions: [], plan, notes: ['plan saved; now send the actions to carry it out'] };
    return { ok: false, error: '"actions" is empty: send at least one action' };
  }

  const notes: string[] = [];
  const items = obj.actions.slice(0, MAX_BATCH);
  if (obj.actions.length > MAX_BATCH) notes.push(`only the first ${MAX_BATCH} actions were run`);

  const actions: AgentAction[] = [];
  for (const [i, item] of items.entries()) {
    const json = JSON.stringify(item ?? null);
    const parsed = parseAgentAction(json);
    if (!parsed.ok) {
      // Quote what was sent: without it, models repeat the same mistake
      const sent = json.length > 150 ? `${json.slice(0, 150)}…` : json;
      return { ok: false, error: `Action ${i + 1}: ${parsed.error} (you sent ${sent})` };
    }
    actions.push(parsed.action);
  }

  // "done" ends the task, so it must come last, and only after actions whose
  // results don't need checking (notes). Otherwise run the rest and let the
  // model look at the result first.
  const doneAt = actions.findIndex((a) => a.action === 'done');
  if (doneAt !== -1 && actions.length > 1) {
    const others = actions.filter((a) => a.action !== 'done');
    if (others.length === 0) return { ok: true, actions: [actions[doneAt]], plan, notes };
    if (doneAt === actions.length - 1 && others.every((a) => a.action === 'note')) return { ok: true, actions, plan, notes };
    notes.push('"done" was not run: check the results of your actions first, then send "done" on its own');
    return { ok: true, actions: others, plan, notes };
  }
  return { ok: true, actions, plan, notes };
}
