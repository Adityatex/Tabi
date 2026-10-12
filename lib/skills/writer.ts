// "Save as skill": turn a finished run into reusable instructions (background).

import type { RunRecord } from '@/lib/agent/runner';
import type { LLMConfig } from '@/lib/api/providers';
import { callLLM } from '@/lib/api/llmClient';
import { extractFirstJsonObject } from '@/lib/agent/parseAction';
import { MAX_SKILL_BODY, slugify, type Skill } from '@/lib/skills/skill';
import { formatHistory } from '@/lib/agent/history';

/** Hosts a run visited, in order, without repeats. */
export function hostsOf(urls: string[]): string[] {
  const hosts: string[] = [];
  for (const url of urls) {
    try {
      const host = new URL(url).hostname.replace(/^www\./, '');
      if (host && !hosts.includes(host)) hosts.push(host);
    } catch { /* not a URL */ }
  }
  return hosts;
}

/** What was typed during the run (type / clear_and_type), e.g. `type [3] "hunter2"` → hunter2. */
export function typedValues(history: string[]): string[] {
  const values: string[] = [];
  for (const entry of history) {
    const m = /^(?:clear_and_type|type) \[\d+\] "(.*?)" →/.exec(entry);
    if (m && m[1].length >= 3) values.push(m[1]);
  }
  return values;
}

/**
 * Replace every value typed during the run with a placeholder. A skill is
 * saved and may be shared; a password or card number typed during the run
 * must never end up in it, whatever the model wrote.
 */
export function scrubTyped(text: string, typed: string[]): string {
  let out = text;
  for (const value of [...typed].sort((a, b) => b.length - a.length)) out = out.split(value).join('<value>');
  return out;
}

/** Ask the model to write a skill from a finished run. `call` is injectable for tests. */
export async function writeSkillFromRun(record: RunRecord, config: LLMConfig, call: typeof callLLM = callLLM): Promise<Skill> {
  const sites = hostsOf(record.urls);
  const raw = await call([
    {
      role: 'system',
      content: `You turn a finished browser task into a reusable SKILL: short instructions that help an agent do this kind of task next time, faster and without the mistakes made this time. The agent sees the page as a list of elements with numbers that change on every page load, so never refer to [numbers]: name buttons, links and fields by their visible text or label.

Answer with one JSON object: {"name": "...", "description": "...", "body": "..."}
- name: 2-5 words, lowercase with hyphens, e.g. "order-status-lookup".
- description: one sentence saying which task and which site the skill is for, so the agent can tell when it applies.
- body: Markdown. Numbered steps: where to go (direct URLs where they help), what to click or fill and in what order, what the page shows when a step worked. Then "Pitfalls:" for anything that went wrong this time and how it was solved. Write what changes from task to task as placeholders like <product> or <username>. At most 250 words.
- Never include passwords, card numbers, personal details or anything else typed during the task: use placeholders.
- Record HOW to do the task, not this time's answer. Prices, stock, dates, search results and anything else that can change next time must not appear as facts: say where to find them and how to check them instead.`,
    },
    {
      role: 'user',
      content: `TASK: ${record.goal}\nSITES: ${sites.join(', ') || 'unknown'}\nRESULT: ${record.summary ?? 'finished'}\n\nSTEPS TAKEN:\n${formatHistory(record.history)}`,
    },
  // Reasoning models think before answering: the same headroom as agent steps
  ], config, { maxTokens: config.maxOutputTokens ?? 4096, temperature: 0.2, jsonMode: true });

  const json = extractFirstJsonObject(raw);
  let parsed: { name?: unknown; description?: unknown; body?: unknown } = {};
  try {
    parsed = json ? JSON.parse(json) : {};
  } catch { /* handled below */ }
  const typed = typedValues(record.history);
  const name = slugify(String(parsed.name ?? '')) || slugify(record.goal).slice(0, 40);
  const description = scrubTyped(String(parsed.description ?? '').trim(), typed);
  const body = scrubTyped(String(parsed.body ?? '').trim(), typed).slice(0, MAX_SKILL_BODY);
  if (!description || !body) throw new Error("The model didn't write a usable skill; try again, or write one by hand in Settings");
  return { name, description, sites, body };
}
