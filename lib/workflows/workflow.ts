// Workflows: a task that worked, saved as its exact steps, to replay later
// with no model calls. Each step names its element by description (see
// describeElement in lib/agent/domSnapshot.ts), not by snapshot ID. If a step
// no longer fits the page, the agent takes over from there (lib/agent/runner.ts).

import type { AgentAction } from '@/lib/agent/actionExecutor';
import type { ElementKey } from '@/lib/agent/domSnapshot';
import type { KeyValueStorage } from '@/lib/skills/store';
import { slugify } from '@/lib/skills/skill';

export interface WorkflowStep {
  /** The action, without elementId. */
  action: AgentAction;
  /** The element it acted on, for actions that target one. */
  target?: ElementKey;
  /** The page it was done on. */
  url?: string;
}

export interface Workflow {
  name: string;
  /** The task, in the words it was first given; the agent uses it if it has to take over. */
  goal: string;
  /** Where the recorded run started; replay goes there first. */
  startUrl?: string;
  steps: WorkflowStep[];
  /** Where it ended, to check a replay got to the same place. */
  finalUrl?: string;
  finalTitle?: string;
  /** Some step types a password: it's saved on this device like everything else, but the user is told. */
  hasPassword?: boolean;
  createdAt?: number;
}

/** Actions a workflow replays. Notes, searches, reads and code only informed the model. */
const REPLAYED: ReadonlySet<AgentAction['action']> = new Set([
  'click', 'type', 'clear_and_type', 'select', 'navigate', 'scroll', 'press_key', 'wait',
]);

export function isReplayed(action: AgentAction): boolean {
  return REPLAYED.has(action.action);
}

/** A step for the log, e.g. `click <button> "Sign in"`. */
export function describeStep(step: WorkflowStep): string {
  const { action, target } = step;
  let desc = action.action as string;
  if (target) desc += ` ${target.key}${target.nth > 0 ? ` (#${target.nth + 1})` : ''}`;
  // Never show a password in the log
  if (action.text) desc += ` "${/type="password"/.test(target?.key ?? '') ? '••••' : action.text}"`;
  if (action.value) desc += ` "${action.value}"`;
  if (action.key) desc += ` key=${action.key}`;
  if (action.url) desc += ` ${action.url}`;
  return desc;
}

/**
 * A short name for a workflow from its goal ("/log-in-with-username-demo"):
 * its first words, leaving out anything typed into a password field, since
 * goals sometimes contain the password and names are shown in lists.
 */
export function workflowName(goal: string, steps: WorkflowStep[]): string {
  const secrets = new Set(steps
    .filter((s) => /type="password"/.test(s.target?.key ?? '') && s.action.text)
    .map((s) => s.action.text!.toLowerCase()));
  const words = goal.split(/\s+/)
    .map((w) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''))
    .filter((w) => w && !secrets.has(w.toLowerCase()));
  // slugify trims hyphens left at either end after cutting
  return slugify(slugify(words.slice(0, 6).join(' ')).slice(0, 40)) || 'workflow';
}

const WORKFLOWS_KEY = 'tabi_workflows';
const MAX_WORKFLOWS = 100;

export async function loadWorkflows(storage: KeyValueStorage): Promise<Workflow[]> {
  const stored = (await storage.get(WORKFLOWS_KEY))[WORKFLOWS_KEY];
  return Array.isArray(stored) ? (stored as Workflow[]) : [];
}

/** Add a workflow, replacing any with the same name. */
export async function saveWorkflow(storage: KeyValueStorage, workflow: Workflow): Promise<Workflow[]> {
  const others = (await loadWorkflows(storage)).filter((w) => w.name !== workflow.name);
  if (others.length >= MAX_WORKFLOWS) throw new Error(`You have ${MAX_WORKFLOWS} workflows already; delete some first`);
  const all = [...others, { ...workflow, createdAt: workflow.createdAt ?? Date.now() }];
  await storage.set({ [WORKFLOWS_KEY]: all });
  return all;
}

export async function deleteWorkflow(storage: KeyValueStorage, name: string): Promise<Workflow[]> {
  const all = (await loadWorkflows(storage)).filter((w) => w.name !== name);
  await storage.set({ [WORKFLOWS_KEY]: all });
  return all;
}
