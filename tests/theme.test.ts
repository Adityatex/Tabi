import { describe, it, expect } from 'vitest';
import { applyTheme } from '@/lib/utils/theme';

describe('applyTheme', () => {
  it('sets light or dark on the page, and clears it to follow the system', () => {
    const root = document.createElement('html');
    applyTheme('dark', root);
    expect(root.dataset.theme).toBe('dark');
    applyTheme('light', root);
    expect(root.dataset.theme).toBe('light');
    applyTheme('system', root);
    expect(root.dataset.theme).toBeUndefined();
  });
});
