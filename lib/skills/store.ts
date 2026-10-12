// Skills saved in chrome.storage.local (background and Settings). Storage is
// injected so this can be tested.

import type { Skill } from '@/lib/skills/skill';

const SKILLS_KEY = 'tabi_skills';
/** Most skills kept; each is a few KB at most. */
const MAX_SKILLS = 100;

export interface KeyValueStorage {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

export async function loadSkills(storage: KeyValueStorage): Promise<Skill[]> {
  const stored = (await storage.get(SKILLS_KEY))[SKILLS_KEY];
  return Array.isArray(stored) ? (stored as Skill[]) : [];
}

/** Add a skill, replacing any with the same name. */
export async function saveSkill(storage: KeyValueStorage, skill: Skill): Promise<Skill[]> {
  const others = (await loadSkills(storage)).filter((s) => s.name !== skill.name);
  if (others.length >= MAX_SKILLS) throw new Error(`You have ${MAX_SKILLS} skills already; delete some first`);
  const skills = [...others, { ...skill, createdAt: skill.createdAt ?? Date.now() }];
  await storage.set({ [SKILLS_KEY]: skills });
  return skills;
}

export async function deleteSkill(storage: KeyValueStorage, name: string): Promise<Skill[]> {
  const skills = (await loadSkills(storage)).filter((s) => s.name !== name);
  await storage.set({ [SKILLS_KEY]: skills });
  return skills;
}
