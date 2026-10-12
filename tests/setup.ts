// Unit tests run content-script code without a background service worker.
// WXT's fake browser never answers runtime.sendMessage then, so calls like
// requestTrusted() would hang. Reject immediately instead, like a missing
// background, so code takes its scripted fallback. Tests that need an answer
// override this with their own mock.
import { beforeEach, vi } from 'vitest';

beforeEach(() => {
  vi.spyOn(browser.runtime, 'sendMessage').mockRejectedValue(new Error('No background service worker in unit tests'));
});
