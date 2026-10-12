// The user's autofill profile: details as label and answer pairs ("Mobile
// number": "+91 98…"), the common ones to start with and any the user adds.
// Kept in chrome.storage.local. The agent matches them to a form's questions
// by meaning, so "Contact" gets the mobile number without a list of names.

export interface ProfileField {
  label: string;
  value: string;
}

const PROFILE_KEY = 'tabi_profile';

/** Most fields kept, and the longest label and answer. */
const MAX_FIELDS = 60;
const MAX_LABEL = 80;
const MAX_VALUE = 2000;

/** The fields a new profile starts with, all empty. */
export const STARTER_FIELDS: readonly string[] = [
  'Full name', 'Email', 'Mobile number', 'Street address', 'City', 'State / Province', 'Postal code', 'Country',
];

/** Fields people often add, offered with one click. */
export const SUGGESTED_FIELDS: readonly string[] = [
  'Date of birth', 'Gender', 'Company', 'Job title', 'LinkedIn', 'Website', 'GitHub', 'University', 'Student ID',
];

const starter = (): ProfileField[] => STARTER_FIELDS.map((label) => ({ label, value: '' }));

/** The profile as first saved (one key per detail), in the same order, with its labels. */
const OLD_KEYS: [string, string][] = [
  ['fullname', 'Full name'], ['email', 'Email'], ['phone', 'Mobile number'], ['address', 'Street address'],
  ['city', 'City'], ['state', 'State / Province'], ['zip', 'Postal code'], ['country', 'Country'],
];

/** Stored data as a clean list: valid fields only, trimmed and capped. A profile saved in the old shape is carried over. */
export function cleanProfile(raw: unknown): ProfileField[] {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const old = raw as Record<string, unknown>;
    return OLD_KEYS.map(([key, label]) => ({ label, value: typeof old[key] === 'string' ? (old[key] as string).slice(0, MAX_VALUE) : '' }));
  }
  if (!Array.isArray(raw)) return starter();
  return raw
    .filter((f): f is ProfileField => !!f && typeof f.label === 'string' && typeof f.value === 'string')
    .map((f) => ({ label: f.label.trim().slice(0, MAX_LABEL), value: f.value.slice(0, MAX_VALUE) }))
    .filter((f) => f.label)
    .slice(0, MAX_FIELDS);
}

/** The fields that have an answer. */
export function filledFields(fields: ProfileField[]): ProfileField[] {
  return fields.filter((f) => f.value.trim());
}

/** The details as the model reads them, one per line. Multi-line answers stay on one line. */
export function profileText(fields: ProfileField[]): string {
  return filledFields(fields).map((f) => `- ${f.label}: ${f.value.trim().replace(/\s*\n\s*/g, ' / ')}`).join('\n');
}

declare const browser: any;

export async function loadProfile(): Promise<ProfileField[]> {
  try {
    const stored = await browser.storage.local.get(PROFILE_KEY);
    return cleanProfile(stored?.[PROFILE_KEY]);
  } catch {
    return starter();
  }
}

export async function saveProfile(fields: ProfileField[]): Promise<ProfileField[]> {
  const clean = cleanProfile(fields);
  await browser.storage.local.set({ [PROFILE_KEY]: clean });
  return clean;
}
