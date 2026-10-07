import { describe, it, expect } from 'vitest';
import { cleanSelectionPrefs, selectionShowsOn } from '@/lib/utils/selectionPrefs';

describe('toolbar on selected text: where it shows', () => {
  it('is on by default, everywhere', () => {
    const prefs = cleanSelectionPrefs(undefined);
    expect(prefs).toEqual({ enabled: true, hiddenOn: [] });
    expect(selectionShowsOn(prefs, 'https://news.example.com/story')).toBe(true);
  });

  it('stays off a hidden site and its subdomains, but not others', () => {
    const prefs = cleanSelectionPrefs({ enabled: true, hiddenOn: ['example.com', 42] });
    expect(prefs.hiddenOn).toEqual(['example.com']);
    expect(selectionShowsOn(prefs, 'https://www.example.com/a')).toBe(false);
    expect(selectionShowsOn(prefs, 'https://docs.example.com/a')).toBe(false);
    expect(selectionShowsOn(prefs, 'https://notexample.com/a')).toBe(true);
  });

  it('is off everywhere when turned off', () => {
    expect(selectionShowsOn(cleanSelectionPrefs({ enabled: false }), 'https://example.org/')).toBe(false);
  });
});
