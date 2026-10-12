// Skills: saved instructions for a kind of task, in SKILL.md form (the open
// Agent Skills format: YAML front matter, then Markdown). Tabi adds one
// optional field, `sites`, the hosts a skill is for.
//
//   ---
//   name: order-status
//   description: Look up the status of an order on shop.example.com
//   sites: [shop.example.com]
//   ---
//   1. Open "My account" at the top right, then "Orders".
//   ...
//
// No DOM access: used by the background (runner, storage) and Settings.

export interface Skill {
  name: string;
  description: string;
  /** Hosts it's for, e.g. "shop.example.com" or "*.example.com". Empty = any site. */
  sites: string[];
  /** The instructions (Markdown). */
  body: string;
  createdAt?: number;
}

/** Longest instructions kept, so one skill can't crowd the prompt. */
export const MAX_SKILL_BODY = 3000;

/** A "name" as the Agent Skills format allows it: lowercase letters, digits, hyphens. */
export function slugify(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
}

function unquote(value: string): string {
  const v = value.trim();
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    // YAML double quotes escape like JSON, which is how formatSkill writes them
    try {
      return String(JSON.parse(v));
    } catch {
      return v.slice(1, -1);
    }
  }
  return v.length >= 2 && v.startsWith("'") && v.endsWith("'") ? v.slice(1, -1).replace(/''/g, "'") : v;
}

/** `[a, b]`, `a, b`, or a YAML list's items → strings */
function listOf(value: string, following: string[]): string[] {
  const inline = value.trim();
  if (inline.startsWith('[')) return inline.slice(1, inline.lastIndexOf(']')).split(',').map(unquote).filter(Boolean);
  if (inline) return inline.split(',').map(unquote).filter(Boolean);
  return following.map((l) => unquote(l.replace(/^\s*-\s*/, ''))).filter(Boolean);
}

export type SkillParse = { ok: true; skill: Skill } | { ok: false; error: string };

/** Read a SKILL.md. Only the fields Tabi uses are read from the front matter; others are ignored. */
export function parseSkill(text: string): SkillParse {
  const src = text.replace(/^﻿/, '').replace(/\r\n/g, '\n').trim();
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(src);
  if (!m) return { ok: false, error: 'A SKILL.md starts with a header between --- lines, with a name and a description' };

  const fields: Record<string, string> = {};
  const lists: Record<string, string[]> = {};
  let current = '';
  for (const line of m[1].split('\n')) {
    const item = /^\s+-\s+/.test(line);
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (kv && !item) {
      current = kv[1].toLowerCase();
      fields[current] = kv[2];
      lists[current] = [];
    } else if (item && current) {
      lists[current].push(line);
    }
  }

  const name = slugify(unquote(fields.name ?? ''));
  const description = unquote(fields.description ?? '').trim();
  const body = m[2].trim();
  if (!name) return { ok: false, error: 'The header needs a name' };
  if (!description) return { ok: false, error: 'The header needs a description: say what the skill is for, so the agent knows when to use it' };
  if (!body) return { ok: false, error: 'The skill has no instructions below the header' };
  if (body.length > MAX_SKILL_BODY) return { ok: false, error: `The instructions are too long (${body.length} characters; at most ${MAX_SKILL_BODY})` };

  const sites = 'sites' in fields
    ? listOf(fields.sites, lists.sites).map((s) => s.toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '')).filter(Boolean)
    : [];
  return { ok: true, skill: { name, description, sites, body } };
}

/** Write a skill back out as SKILL.md. */
export function formatSkill(skill: Skill): string {
  const header = [
    '---',
    `name: ${skill.name}`,
    `description: ${JSON.stringify(skill.description)}`,
    ...(skill.sites.length ? [`sites: [${skill.sites.join(', ')}]`] : []),
    '---',
  ];
  return `${header.join('\n')}\n${skill.body.trim()}\n`;
}

/** Whether `host` is one of `sites` ("*.example.com" also covers example.com). */
export function siteMatches(sites: string[], host: string): boolean {
  const h = host.toLowerCase().replace(/^www\./, '');
  return sites.some((site) => {
    const s = site.replace(/^www\./, '');
    if (s.startsWith('*.')) return h === s.slice(2) || h.endsWith(s.slice(1));
    return h === s;
  });
}

const STOP_WORDS = new Set(('a an and are as at be by can do for from get go how i in into is it me my of on or our please '
  + 'so that the then this to up use using want we what when where which with you your').split(' '));

function words(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w))
    .map((w) => (w.length > 3 ? w.replace(/s$/, '') : w))); // invoices ~ invoice
}

/**
 * How well a skill fits the goal: of the goal's and the skill's (name and
 * description) words, whichever side has fewer, the share the other shares.
 * A short goal can then match a long description, and vice versa.
 */
export function relevance(skill: Skill, goal: string): number {
  const skillWords = words(`${skill.name.replace(/-/g, ' ')} ${skill.description}`);
  const goalWords = words(goal);
  const fewer = Math.min(skillWords.size, goalWords.size);
  if (fewer === 0) return 0;
  let hits = 0;
  for (const w of skillWords) if (goalWords.has(w)) hits++;
  return hits / fewer;
}

/** Most skills put in the prompt without being asked for. */
const MAX_AUTO_SKILLS = 2;
/** How well (see relevance) a skill must fit the goal to be included unasked, on any site. */
const AUTO_RELEVANCE = 0.5;

/**
 * Which skills to show the model in full: ones for the current site that
 * relate to the goal, then the ones whose description best fits it. The rest
 * it can load by name (use_skill).
 */
export function pickSkills(skills: Skill[], goal: string, url: string | undefined): Skill[] {
  let host = '';
  try {
    host = url ? new URL(url).hostname : '';
  } catch { /* not a URL */ }
  const scored = skills
    .map((skill) => ({ skill, site: !!host && skill.sites.length > 0 && siteMatches(skill.sites, host), score: relevance(skill, goal) }))
    // For this site and at all about this goal, or a strong fit anywhere
    .filter(({ site, score }) => (site && score > 0) || score >= AUTO_RELEVANCE)
    .sort((a, b) => Number(b.site) - Number(a.site) || b.score - a.score);
  return scored.slice(0, MAX_AUTO_SKILLS).map(({ skill }) => skill);
}
