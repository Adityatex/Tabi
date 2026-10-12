// User-owned autofill profile, persisted in chrome.storage.local.
// Settings edits it, the page reads it (autofill). Falls back to DEFAULT_PROFILE on first run.

export interface AutofillProfile {
  fullname: string;
  email: string;
  phone: string;
  address: string;
  city: string;
  state: string;
  zip: string;
  country: string;
}

const PROFILE_STORAGE_KEY = 'tabi_profile';

export const DEFAULT_PROFILE: AutofillProfile = {
  fullname: 'John Doe',
  email: 'johndoe@example.com',
  phone: '+1 555-123-4567',
  address: '123 Main Street',
  city: 'San Francisco',
  state: 'California',
  zip: '94102',
  country: 'United States',
};


export const PROFILE_FIELDS: { key: keyof AutofillProfile; label: string; placeholder: string; type?: string }[] = [
  { key: 'fullname', label: 'Full name', placeholder: 'Ada Lovelace' },
  { key: 'email', label: 'Email', placeholder: 'ada@example.com', type: 'email' },
  { key: 'phone', label: 'Phone', placeholder: '+1 555-010-2030', type: 'tel' },
  { key: 'address', label: 'Street address', placeholder: '12 Analytical Engine Way' },
  { key: 'city', label: 'City', placeholder: 'London' },
  { key: 'state', label: 'State / Province', placeholder: 'England' },
  { key: 'zip', label: 'ZIP / Postal', placeholder: 'E1 6AN' },
  { key: 'country', label: 'Country', placeholder: 'United Kingdom' },
];

declare const browser: any;

function sanitize(raw: any): AutofillProfile {
  const base = { ...DEFAULT_PROFILE, ...(raw || {}) };
  const out = {} as AutofillProfile;
  (Object.keys(DEFAULT_PROFILE) as (keyof AutofillProfile)[]).forEach((k) => {
    out[k] = typeof base[k] === 'string' ? base[k] : (DEFAULT_PROFILE[k] as string);
  });
  return out;
}

export async function loadStoredProfile(): Promise<AutofillProfile> {
  try {
    const stored = await browser.storage.local.get(PROFILE_STORAGE_KEY);
    if (!stored?.[PROFILE_STORAGE_KEY]) return { ...DEFAULT_PROFILE };
    return sanitize(stored[PROFILE_STORAGE_KEY]);
  } catch {
    return { ...DEFAULT_PROFILE };
  }
}

export async function saveStoredProfile(profile: AutofillProfile): Promise<void> {
  await browser.storage.local.set({ [PROFILE_STORAGE_KEY]: sanitize(profile) });
}

export function isProfileEmpty(p: AutofillProfile): boolean {
  return Object.values(p).every((v) => !String(v || '').trim());
}
