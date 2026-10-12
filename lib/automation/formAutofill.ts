// Fills a form from the user's profile (./profile).

import type { AutofillProfile } from './profile';
import { DEFAULT_PROFILE } from './profile';

export type { AutofillProfile };

/**
 * Dispatch native input and change events so React/Angular/Vue pick up the value change
 */
function triggerInputEvents(el: HTMLElement): void {
  const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype, 'value'
  )?.set;
  const nativeTextareaValueSetter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype, 'value'
  )?.set;

  if (el instanceof HTMLInputElement && nativeInputValueSetter) {
    nativeInputValueSetter.call(el, (el as HTMLInputElement).value);
  } else if (el instanceof HTMLTextAreaElement && nativeTextareaValueSetter) {
    nativeTextareaValueSetter.call(el, (el as HTMLTextAreaElement).value);
  }

  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  el.dispatchEvent(new Event('blur', { bubbles: true }));
}

/**
 * Match a field to a profile key based on its name, id, placeholder, or label
 */
function matchField(field: { name: string; id: string; placeholder: string; label: string }, profile: AutofillProfile): string | null {
  const identifiers = [field.name, field.id, field.placeholder, field.label]
    .map((s) => s.toLowerCase())
    .join(' ');

  if (/full\s?name|your\s?name|^name$/i.test(identifiers)) return profile.fullname;
  if (/e-?mail/i.test(identifiers)) return profile.email;
  if (/phone|tel|mobile/i.test(identifiers)) return profile.phone;
  if (/address|street/i.test(identifiers)) return profile.address;
  if (/city|town/i.test(identifiers)) return profile.city;
  if (/state|province|region/i.test(identifiers)) return profile.state;
  if (/zip|postal/i.test(identifiers)) return profile.zip;
  if (/country|nation/i.test(identifiers)) return profile.country;
  if (/first\s?name/i.test(identifiers)) return profile.fullname.split(' ')[0];
  if (/last\s?name|sur\s?name/i.test(identifiers)) return profile.fullname.split(' ').slice(1).join(' ');

  return null;
}

/**
 * Auto-fill all text inputs and textareas with profile data
 */
export function fillForm(profile: AutofillProfile = DEFAULT_PROFILE): { filled: number; skipped: number } {
  let filled = 0;
  let skipped = 0;

  // Fill text inputs
  const inputs = document.querySelectorAll<HTMLInputElement>(
    'input:not([type="radio"]):not([type="checkbox"]):not([type="hidden"]):not([type="submit"]):not([type="button"])'
  );

  inputs.forEach((el) => {
    const label = el.getAttribute('aria-label') || '';
    const forLabel = el.id ? document.querySelector(`label[for="${el.id}"]`)?.textContent || '' : '';
    const value = matchField({
      name: el.name,
      id: el.id,
      placeholder: el.placeholder,
      label: label || forLabel,
    }, profile);

    if (value) {
      el.value = value;
      triggerInputEvents(el);
      filled++;
    } else {
      skipped++;
    }
  });

  // Fill textareas
  const textareas = document.querySelectorAll<HTMLTextAreaElement>('textarea');
  textareas.forEach((el) => {
    const label = el.getAttribute('aria-label') || '';
    const forLabel = el.id ? document.querySelector(`label[for="${el.id}"]`)?.textContent || '' : '';
    const value = matchField({
      name: el.name,
      id: el.id,
      placeholder: el.placeholder,
      label: label || forLabel,
    }, profile);

    if (value) {
      el.value = value;
      triggerInputEvents(el);
      filled++;
    } else {
      skipped++;
    }
  });

  return { filled, skipped };
}

/**
 * Select dropdown options by matching profile data
 */
export function fillDropdowns(profile: AutofillProfile = DEFAULT_PROFILE): number {
  let filled = 0;
  const selects = document.querySelectorAll<HTMLSelectElement>('select');

  selects.forEach((el) => {
    const label = el.getAttribute('aria-label') || '';
    const forLabel = el.id ? document.querySelector(`label[for="${el.id}"]`)?.textContent || '' : '';
    const value = matchField({
      name: el.name,
      id: el.id,
      placeholder: '',
      label: label || forLabel,
    }, profile);

    if (value) {
      // Try to find matching option by text or value
      const options = Array.from(el.options);
      const match = options.find(
        (opt) =>
          opt.value.toLowerCase() === value.toLowerCase() ||
          opt.textContent?.trim().toLowerCase() === value.toLowerCase()
      );
      if (match) {
        el.value = match.value;
        el.dispatchEvent(new Event('change', { bubbles: true }));
        filled++;
      }
    }
  });

  return filled;
}
