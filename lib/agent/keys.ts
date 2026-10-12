// Key definitions shared by scripted KeyboardEvents (content script) and
// trusted Chrome DevTools Protocol key events (background).

interface KeyDef {
  code: string;
  keyCode: number;
  /** Text the key produces; Enter's '\r' is what triggers implicit form submission. */
  text?: string;
}

const NAMED_KEYS: Record<string, KeyDef> = {
  Enter: { code: 'Enter', keyCode: 13, text: '\r' },
  Tab: { code: 'Tab', keyCode: 9 },
  Escape: { code: 'Escape', keyCode: 27 },
  Backspace: { code: 'Backspace', keyCode: 8 },
  Delete: { code: 'Delete', keyCode: 46 },
  ' ': { code: 'Space', keyCode: 32, text: ' ' },
  ArrowLeft: { code: 'ArrowLeft', keyCode: 37 },
  ArrowUp: { code: 'ArrowUp', keyCode: 38 },
  ArrowRight: { code: 'ArrowRight', keyCode: 39 },
  ArrowDown: { code: 'ArrowDown', keyCode: 40 },
  Home: { code: 'Home', keyCode: 36 },
  End: { code: 'End', keyCode: 35 },
  PageUp: { code: 'PageUp', keyCode: 33 },
  PageDown: { code: 'PageDown', keyCode: 34 },
};

/** Models write "enter", "ESC", "Space"...; normalise to DOM key names. */
const ALIASES: Record<string, string> = {
  enter: 'Enter', return: 'Enter', tab: 'Tab', escape: 'Escape', esc: 'Escape',
  backspace: 'Backspace', delete: 'Delete', del: 'Delete', space: ' ', spacebar: ' ',
  arrowleft: 'ArrowLeft', left: 'ArrowLeft', arrowup: 'ArrowUp', up: 'ArrowUp',
  arrowright: 'ArrowRight', right: 'ArrowRight', arrowdown: 'ArrowDown', down: 'ArrowDown',
  home: 'Home', end: 'End', pageup: 'PageUp', pagedown: 'PageDown',
};

export function normalizeKey(key: string): string {
  if (key.length === 1) return key;
  return ALIASES[key.toLowerCase()] ?? key;
}

export interface KeyParams {
  key: string;
  code: string;
  keyCode: number;
  text?: string;
}

/** Everything a key event needs for `key` (a DOM key name or a single character). */
export function keyParams(rawKey: string): KeyParams {
  const key = normalizeKey(rawKey);
  const named = NAMED_KEYS[key];
  if (named) return { key, ...named };
  if (key.length === 1) {
    const upper = key.toUpperCase();
    const isLetter = upper >= 'A' && upper <= 'Z';
    const isDigit = key >= '0' && key <= '9';
    return {
      key,
      code: isLetter ? `Key${upper}` : isDigit ? `Digit${key}` : '',
      keyCode: isLetter || isDigit ? upper.charCodeAt(0) : 0,
      text: key,
    };
  }
  return { key, code: key, keyCode: 0 };
}
