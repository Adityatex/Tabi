// run_code: the model's own JavaScript for reading a page, for what `extract`
// can't do. Opt-in (prefs.customCode). The background runs it through the
// debugger in an isolated world: it sees the page's DOM but not its scripts,
// and the page can't see it. Before running, Tabi refuses code that looks
// like it sends data out, reads cookies or storage, or acts on the page, and
// removes the network functions from that world. That lowers the risk; it
// can't make code from a model steered by page content fully safe, which is
// why this is off by default. No DOM access here: used by the background.

/** Longest code accepted (a reading snippet, not a program). */
const MAX_CODE_CHARS = 4000;
/** Longest result returned to the model. */
export const MAX_RESULT_CHARS = 3000;
/** How long the code may run. */
export const CODE_TIMEOUT_MS = 10_000;

/** What code may not do, and why (checked before it runs). */
const FORBIDDEN: [RegExp, string][] = [
  [/\bfetch\s*\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon|RTCPeerConnection|\bimportScripts\b|\bimport\s*\(/, 'network access'],
  [/document\s*\.\s*cookie|localStorage|sessionStorage|indexedDB|caches\s*\.|navigator\s*\.\s*credentials/, 'cookies or stored data'],
  [/\beval\s*\(|\bFunction\s*\(|setTimeout\s*\(\s*['"`]|setInterval\s*\(\s*['"`]/, 'running code built from strings'],
  [/\.\s*(click|submit|requestSubmit|dispatchEvent|focus)\s*\(|\.\s*(innerHTML|outerHTML)\s*=[^=]|\binsertAdjacentHTML\b|document\s*\.\s*write/, 'acting on or changing the page (use the normal actions for that)'],
  // Changing location (reading location.href is fine)
  [/\blocation(\s*\.\s*href)?\s*=[^=]|\blocation\s*\.\s*(assign|replace|reload)\s*\(|\bwindow\s*\.\s*open\s*\(|\bhistory\s*\.\s*(push|replace)State/, 'navigating'],
  [/\bpostMessage\s*\(|\bnavigator\s*\.\s*(clipboard|geolocation)|\bNotification\b/, 'reaching outside the page'],
  [/\.\s*src\s*=[^=]|setAttribute\s*\(\s*['"](src|href|action|srcset)['"]|new\s+Image\s*\(|createElement\s*\(\s*['"](img|script|iframe|link|form)['"]/, 'loading resources (which can send data out)'],
  [/\bhttps?:\/\//i, 'addresses in the code (it may only read this page)'],
];

/** Why this code may not run, or null if it may. */
export function checkCode(code: string): string | null {
  if (!code.trim()) return 'there is no code';
  if (code.length > MAX_CODE_CHARS) return `it is too long (${code.length} characters; at most ${MAX_CODE_CHARS})`;
  for (const [pattern, what] of FORBIDDEN) {
    if (pattern.test(code)) return `it uses ${what}`;
  }
  return null;
}

/**
 * The expression to evaluate in the isolated world: remove the network
 * functions, run the code as an async function body, and return its result
 * as JSON (so DOM nodes and other live objects become plain data).
 */
export function wrapCode(code: string): string {
  return `(async () => {
  for (const name of ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'RTCPeerConnection', 'Worker', 'SharedWorker']) {
    try { Object.defineProperty(globalThis, name, { value: undefined, configurable: false }); } catch (e) {}
  }
  try { Object.defineProperty(Navigator.prototype, 'sendBeacon', { value: undefined, configurable: false }); } catch (e) {}
  const __tabiResult = await (async () => {
${code}
  })();
  return JSON.stringify(__tabiResult === undefined ? null : __tabiResult, (key, value) =>
    value instanceof Element ? (value.innerText ?? value.textContent ?? '').trim().slice(0, 300) : value);
})()`;
}

/** The result as the model reads it. */
export function formatCodeResult(json: string | undefined): string {
  if (json === undefined || json === 'null') return '✅ The code ran and returned nothing. Return the data you need, e.g. `return [...].map(...)`.';
  const text = json.length > MAX_RESULT_CHARS ? `${json.slice(0, MAX_RESULT_CHARS)}… (cut: ${json.length} characters in all)` : json;
  return `✅ The code returned: ${text}`;
}
