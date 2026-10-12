// Which actions can't be undone, so the agent asks the user first: buying,
// paying, sending, deleting, moving money, booking, applying. Judged from the
// label of what the action sets off (described like a snapshot element, see
// commitTarget in domSnapshot.ts). Steps that can be undone on the way there
// ("Add to cart", "Proceed to checkout", "Remove" from a cart) don't ask.

import type { AgentAction } from '@/lib/agent/actionExecutor';

export type Risk =
  | 'a purchase' | 'a payment' | 'sending a message or post' | 'deleting something'
  | 'moving money' | 'a booking' | 'submitting an application';

/**
 * Labels of each kind of action that can't be taken back (case-insensitive).
 * Labels are short, so most patterns are anchored: "Buy now" asks, "Buying guide" doesn't.
 */
const RISKY: [RegExp, Risk][] = [
  [/^(buy|purchase|order now)\b|\b(place|submit|confirm|complete|finish) (my |your |the )?(order|purchase)\b|\bcomplete checkout\b/i, 'a purchase'],
  [/^pay\b|\b(confirm and|checkout and) pay\b|\b(make|submit|confirm|complete|authori[sz]e) (a |the )?payment\b/i, 'a payment'],
  [/^(send|post|publish|tweet)\b|^comment$|^(post|add|submit) (a |your )?(comment|reply|review)\b/i, 'sending a message or post'],
  [/\bdelete\b|\bpermanently\b|\b(close|deactivate|terminate|cancel) (my |your |this )?account\b|\bcancel (my |your |this )?(subscription|membership|order|plan|booking|reservation)\b|\bconfirm cancel(l?ation)?\b|\bempty (the )?(trash|bin)\b/i, 'deleting something'],
  [/\b(transfer|withdraw|donate)\b|\bsend money\b/i, 'moving money'],
  [/^(book|reserve)( now| it| this)?( (a |the )?(room|table|flight|ticket|tickets|seat|seats|appointment|stay))?$|\b(confirm|complete) (my |your |the )?(booking|reservation|appointment)\b/i, 'a booking'],
  [/\bsubmit (my |your |the )?application\b/i, 'submitting an application'],
];

/** Roles that pick, toggle or take text: clicking them never commits anything. */
const NOT_ACTIONS = new Set([
  'checkbox', 'radio', 'switch', 'textbox', 'searchbox', 'combobox', 'listbox', 'option', 'slider', 'spinbutton',
  'menuitemcheckbox', 'menuitemradio', 'tab', 'treeitem', 'select', 'textarea',
]);

/** Tag, role, type and label of a description like `<button> type="submit" "Place order" href="..."`. */
function parts(key: string): { tag: string; role: string; type?: string; label: string } {
  const tag = /^<(\w+)>/.exec(key)?.[1] ?? '';
  const role = /^<\w+>\s+role="([^"]*)"/.exec(key)?.[1] ?? tag;
  const type = /^<\w+>(?:\s+role="[^"]*")?\s+type="([^"]*)"/.exec(key)?.[1];
  // The label comes after role and type, before the other attributes
  const label = /^<\w+>(?:\s+(?:role|type)="[^"]*")*\s+"((?:[^"\\]|\\.)*)"/.exec(key)?.[1] ?? '';
  return { tag, role, type, label };
}

/** The visible label of a described element, for asking the user about it. */
export function labelOf(key: string): string {
  return parts(key).label;
}

/** True for click and Enter: the only actions that can commit something. */
export function canCommit(action: Pick<AgentAction, 'action' | 'key'>): boolean {
  return action.action === 'click' || (action.action === 'press_key' && /^(enter|return)$/i.test(action.key || 'Enter'));
}

/**
 * Why this action needs the user's OK, or null. `target` describes what it
 * sets off: the clicked element, or for Enter the button that submits the form.
 */
export function riskOf(action: Pick<AgentAction, 'action' | 'key'>, target: string | null | undefined): Risk | null {
  if (!canCommit(action) || !target) return null;
  const { tag, role, type, label } = parts(target);
  if (!label || NOT_ACTIONS.has(role)) return null;
  if (tag === 'input' && !/^(submit|button|image)$/i.test(type ?? '')) return null;
  for (const [pattern, risk] of RISKY) if (pattern.test(label.trim())) return risk;
  return null;
}
