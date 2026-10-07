// lib/shortcuts/shortcut.ts
// Shortcuts: saved prompts, run from the side panel with /name. A prompt can have
// blanks in braces ("Find the price of {product}"): "/price-check running
// shoes" fills them in, and without extra words the prompt goes into the box
// to complete by hand. The side panel's / picker lists these next to workflows.
// No DOM access: used by the side panel, Settings and background.

import { slugify } from '@/lib/skills/skill';
import type { KeyValueStorage } from '@/lib/skills/store';

export interface Shortcut {
  name: string;
  prompt: string;
  createdAt?: number;
}

export const SHORTCUTS_KEY = 'tabi_shortcuts';
export const MAX_SHORTCUTS = 200;
export const MAX_PROMPT_CHARS = 2000;

/** A short /name from a prompt's first words. */
export function shortcutName(prompt: string): string {
  const words = prompt.replace(/\{[^}]*\}/g, ' ').split(/\s+/).filter(Boolean).slice(0, 5).join(' ');
  return slugify(slugify(words).slice(0, 32)) || 'shortcut';
}

/** The blanks in a prompt, e.g. ["product"] for "Find the price of {product}". */
export function blanks(prompt: string): string[] {
  return [...new Set([...prompt.matchAll(/\{([^{}]{1,40})\}/g)].map((m) => m[1].trim()))];
}

/**
 * The prompt with its blanks filled from `args` (the words after /name). One
 * blank takes all of them; several take comma-separated parts in order. If a
 * blank is left empty, `complete` is false and the text goes into the box.
 */
export function fillPrompt(prompt: string, args: string): { text: string; complete: boolean } {
  const names = blanks(prompt);
  if (names.length === 0) {
    return { text: args.trim() ? `${prompt} ${args.trim()}` : prompt, complete: true };
  }
  const parts = names.length === 1 ? [args.trim()] : args.split(',').map((p) => p.trim());
  let text = prompt;
  names.forEach((name, i) => {
    if (parts[i]) text = text.split(`{${name}}`).join(parts[i]);
  });
  return { text, complete: blanks(text).length === 0 };
}

/** Something the / picker can offer. */
export interface PickerItem {
  /** command: one of the side panel's own (summarize, explain, autofill). */
  kind: 'workflow' | 'shortcut' | 'skill' | 'command';
  name: string;
  /** What it does: the workflow's goal, the saved prompt, the skill's description, or a command's hint. */
  detail: string;
  /** Workflows: how many steps it replays, and the site it starts on. Skills: the sites they're for. */
  steps?: number;
  site?: string;
}

/**
 * Picker items for what's typed after "/": names starting with it first, then
 * names or details containing it; workflows before shortcuts on ties.
 */
export function matchItems(query: string, items: PickerItem[], limit = 8): PickerItem[] {
  const q = query.trim().toLowerCase();
  const score = (item: PickerItem) => {
    if (!q) return 1;
    if (item.name.startsWith(q)) return 3;
    if (item.name.includes(q)) return 2;
    if (item.detail.toLowerCase().includes(q)) return 1;
    return 0;
  };
  return items
    .map((item) => ({ item, s: score(item) }))
    .filter(({ s }) => s > 0)
    .sort((a, b) => b.s - a.s || Number(a.item.kind === 'shortcut') - Number(b.item.kind === 'shortcut') || a.item.name.localeCompare(b.item.name))
    .slice(0, limit)
    .map(({ item }) => item);
}

export async function loadShortcuts(storage: KeyValueStorage): Promise<Shortcut[]> {
  const stored = (await storage.get(SHORTCUTS_KEY))[SHORTCUTS_KEY];
  return Array.isArray(stored) ? (stored as Shortcut[]) : [];
}

/** Add a shortcut, replacing any with the same name. Returns them all. */
export async function saveShortcut(storage: KeyValueStorage, shortcut: Shortcut): Promise<Shortcut[]> {
  const name = slugify(shortcut.name) || shortcutName(shortcut.prompt);
  const prompt = shortcut.prompt.trim();
  if (!prompt) throw new Error('A shortcut needs a prompt');
  if (prompt.length > MAX_PROMPT_CHARS) throw new Error(`The prompt is too long (at most ${MAX_PROMPT_CHARS} characters)`);
  const others = (await loadShortcuts(storage)).filter((s) => s.name !== name);
  if (others.length >= MAX_SHORTCUTS) throw new Error(`You have ${MAX_SHORTCUTS} shortcuts already; delete some first`);
  const all = [...others, { name, prompt, createdAt: shortcut.createdAt ?? Date.now() }];
  await storage.set({ [SHORTCUTS_KEY]: all });
  return all;
}

export async function deleteShortcut(storage: KeyValueStorage, name: string): Promise<Shortcut[]> {
  const all = (await loadShortcuts(storage)).filter((s) => s.name !== name);
  await storage.set({ [SHORTCUTS_KEY]: all });
  return all;
}
