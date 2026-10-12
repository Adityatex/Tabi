// The user's own rules for where the agent may act: a block list (never act
// on these sites) and an optional allow list (only these, ask about others).
// Checked in code, not by a model, so no page can argue its way past them.
// Applies to every run (side panel, background, schedules, workflow replays) and
// to AI apps driving the browser through tabi-mcp.

import { siteOf } from '@/lib/agent/critic';

export const SITES_KEY = 'tabi_sites';

export interface SiteRules {
  /** Never act on these sites (or their subdomains). */
  blocked: string[];
  /** If not empty: act only on these; others need the user's OK. */
  allowed: string[];
}

/**
 * blocked: on the block list. allowed: on the allow list. unlisted: there is
 * an allow list, and it isn't on it. open: no rule says anything.
 */
export type SiteStatus = 'blocked' | 'allowed' | 'unlisted' | 'open';

/**
 * A site as the user typed it, as a rule: "mybank.com", "https://www.mybank.com/login"
 * and "*.mybank.com" all give "mybank.com". Null if it isn't a site.
 */
export function normalizeSite(input: string): string | null {
  let text = input.trim().toLowerCase().replace(/^\*\./, '');
  if (!text) return null;
  if (!/^[a-z][a-z\d+.-]*:\/\//.test(text)) text = `https://${text}`;
  let host: string;
  try {
    host = new URL(text).hostname;
  } catch {
    return null;
  }
  host = host.replace(/^www\./, '').replace(/\.$/, '');
  // A name with a dot (example.com), localhost, or an IP address
  return /^([a-z\d]([a-z\d-]*[a-z\d])?\.)+[a-z\d-]{2,}$|^localhost$|^\d{1,3}(\.\d{1,3}){3}$/.test(host) ? host : null;
}

/** True if the site is this rule's site or one of its subdomains. */
export function matchesRule(site: string, rule: string): boolean {
  return site === rule || site.endsWith(`.${rule}`);
}

/** What the rules say about a site ("" = not a web page: nothing to say). */
export function siteStatus(site: string, rules: SiteRules): SiteStatus {
  if (!site) return 'open';
  if (rules.blocked.some((rule) => matchesRule(site, rule))) return 'blocked';
  if (rules.allowed.some((rule) => matchesRule(site, rule))) return 'allowed';
  return rules.allowed.length ? 'unlisted' : 'open';
}

/** The same for a URL. */
export function urlStatus(url: string | undefined, rules: SiteRules): { site: string; status: SiteStatus } {
  const site = siteOf(url);
  return { site, status: siteStatus(site, rules) };
}

/** Rules as stored, cleaned up: valid sites only, no repeats, a site on both lists stays blocked. */
export function cleanRules(raw: unknown): SiteRules {
  const list = (value: unknown) => [...new Set((Array.isArray(value) ? value : [])
    .map((v) => normalizeSite(String(v)))
    .filter((v): v is string => !!v))];
  const r = (raw ?? {}) as Partial<SiteRules>;
  const blocked = list(r.blocked);
  return { blocked, allowed: list(r.allowed).filter((site) => !blocked.includes(site)) };
}
