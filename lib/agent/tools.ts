// lib/agent/tools.ts
// The agent's reply as a native tool (OpenAI-style function calling), for
// providers and models that support it. Instead of writing JSON in its reply,
// which some models get wrong, the model calls one tool whose arguments are
// the reply: its plan and a list of actions. One tool, not one per action:
// some models make only one tool call per reply, which would stop batching.
// Tool calls are turned back into the plain response format
// ({"plan": [...], "actions": [...]}), so parseAgentResponse checks them the
// same way either way.

import { MAX_BATCH } from '@/lib/agent/parseAction';

/** An OpenAI-style tool definition. */
export interface ToolDef {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

/** A tool call from the model; `arguments` is a JSON string. */
export interface ToolCall {
  function?: { name?: string; arguments?: string };
}

export const NEXT_ACTIONS_TOOL = 'next_actions';

const ACTION_NAMES = [
  'click', 'type', 'clear_and_type', 'select', 'navigate', 'scroll', 'press_key', 'read', 'find', 'extract', 'run_code', 'note', 'wait', 'use_skill', 'done',
];

export const AGENT_TOOLS: ToolDef[] = [{
  type: 'function',
  function: {
    name: NEXT_ACTIONS_TOOL,
    description: `Your next move: your plan (when it's new or changed) and 1 to ${MAX_BATCH} actions, run in order.`,
    parameters: {
      type: 'object',
      properties: {
        plan: {
          type: 'array',
          items: { type: 'string' },
          description: 'Checklist for the whole goal, at most 8 items: "[x] done", "[ ] to do". Send it first, and again when it changes or an item gets done.',
        },
        actions: {
          type: 'array',
          minItems: 1,
          maxItems: MAX_BATCH,
          items: {
            type: 'object',
            properties: {
              action: { type: 'string', enum: ACTION_NAMES },
              elementId: { type: 'integer', description: 'Element ID from the page snapshot, e.g. 12 for [12]' },
              text: { type: 'string', description: 'Text to type, words to find, a note, milliseconds to wait, a skill name, or what extract collects' },
              fields: { type: 'array', items: { type: 'string' }, description: 'For extract: the fields to collect, e.g. ["name", "price"]' },
              follow: { type: 'boolean', description: 'For extract: also read the page of each listed item for fields the list lacks' },
              value: { type: 'string', description: 'Option label, for select' },
              url: { type: 'string', description: 'Full http(s) URL, for navigate' },
              direction: { type: 'string', enum: ['up', 'down'] },
              key: { type: 'string', description: 'Key name for press_key: Enter, Tab, Escape, ...' },
              summary: { type: 'string', description: 'For done: the result for the user, in Markdown (outcome first, then a short list if there is more), or why it is impossible' },
            },
            required: ['action'],
          },
        },
      },
      required: ['actions'],
    },
  },
}];

/**
 * Tool calls → the plain response format. The next_actions call carries the
 * whole reply. Calls named after an action (a model inventing one tool per
 * action) are read as that action. Arguments that aren't valid JSON leave the
 * action incomplete, so the parser reports it and the model can correct itself.
 */
export function toolCallsToResponse(calls: ToolCall[]): string {
  let plan: string[] | undefined;
  const actions: unknown[] = [];
  for (const call of calls) {
    const name = call.function?.name ?? '';
    let args: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(call.function?.arguments || '{}');
      if (parsed && typeof parsed === 'object') args = parsed;
    } catch { /* leave args empty */ }

    if (name === NEXT_ACTIONS_TOOL) {
      if (Array.isArray(args.plan)) plan = args.plan.map(String);
      if (Array.isArray(args.actions)) actions.push(...args.actions);
    } else if (name === 'set_plan') {
      if (Array.isArray(args.items)) plan = args.items.map(String);
    } else if (name === 'wait' && args.milliseconds !== undefined) {
      actions.push({ action: 'wait', text: String(args.milliseconds) });
    } else {
      actions.push({ action: name, ...args });
    }
  }
  return JSON.stringify({ ...(plan ? { plan } : {}), actions });
}
