// Structured extraction: the model says what it wants ("laptops: name, price,
// RAM") and this code finds it, without the model writing any code. It looks
// for the page's repeating items (table rows, lists, cards) or its label/value
// pairs (spec tables, <dl>), and fills each requested field by label, class
// name or kind of value. With `follow`, it also reads each item's own page
// (same site, fetched read-only: the page's scripts never run) for fields the
// list doesn't show. Runs in the content script.

export type Item = Record<string, string>;

export interface ExtractResult {
  kind: 'table' | 'list' | 'details' | 'none';
  items: Item[];
  /** Fields found on items' own pages (follow). */
  followed: number;
  /** Items whose page couldn't be read. */
  followFailed: number;
}

/** Most items returned; the rest are counted. */
const MAX_ITEMS = 30;
/** Most linked pages read per extract. */
const MAX_FOLLOW = 10;
const FOLLOW_TIMEOUT_MS = 8000;
const FOLLOW_CONCURRENCY = 3;

/** Links that act rather than show something: never followed. */
const ACTION_LINK = /log-?out|sign-?out|delete|remove|unsubscribe|cancel|destroy|logoff|deactivate|\/(add|buy|checkout|cart)\b/i;

// ---------------------------------------------------------------- field names

const SYNONYMS = [
  ['price', 'cost', 'amount', 'total', 'fee', 'fare'],
  ['ram', 'memory'],
  ['name', 'title', 'product', 'item', 'model'],
  ['link', 'url', 'href', 'page'],
  ['image', 'photo', 'picture', 'img', 'thumbnail'],
  ['rating', 'stars', 'score', 'review', 'reviews'],
  ['date', 'time', 'when', 'day', 'posted', 'published'],
  ['status', 'state'],
  ['description', 'summary', 'details', 'about'],
];

function words(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1)
    .map((w) => (w.length > 3 ? w.replace(/s$/, '') : w));
}

/** Words for a field, including synonyms: "RAM" → ram, memory. */
function fieldWords(field: string): Set<string> {
  const out = new Set(words(field));
  for (const group of SYNONYMS) {
    const g = group.map((w) => (w.length > 3 ? w.replace(/s$/, '') : w));
    if (g.some((w) => out.has(w))) g.forEach((w) => out.add(w));
  }
  return out;
}

/** Whether a label ("Memory (RAM)", "Unit price") names this field. */
export function labelMatches(label: string, field: string): boolean {
  const want = fieldWords(field);
  return words(label).some((w) => want.has(w));
}

/** Which kind of value a field holds, for fields no label names. */
function kindOf(field: string): 'name' | 'price' | 'link' | 'image' | 'rating' | 'date' | null {
  const w = fieldWords(field);
  if (w.has('price')) return 'price';
  if (w.has('name')) return 'name';
  if (w.has('link')) return 'link';
  if (w.has('image')) return 'image';
  if (w.has('rating')) return 'rating';
  if (w.has('date')) return 'date';
  return null;
}

// ---------------------------------------------------------------- reading elements

type TextOf = (el: Element) => string;

/** Visible text on the live page; plain text in fetched pages, which have no layout. */
const liveText: TextOf = (el) => ((el as HTMLElement).innerText ?? el.textContent ?? '').replace(/\s+/g, ' ').trim();
const plainText: TextOf = (el) => (el.textContent ?? '').replace(/\s+/g, ' ').trim();

const PRICE = /(?:[$€£₹¥]\s?\d[\d,]*(?:\.\d+)?|\d[\d,]*(?:\.\d+)?\s?(?:USD|EUR|GBP|INR|Rs\.?|₹))/;
const RATING = /(\d(?:\.\d)?)\s*(?:out of 5|\/\s*5|stars?)/i;
const DATE = /\b(?:\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*(?:\s+\d{4})?|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2}(?:,\s*\d{4})?|\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{2,4})\b/i;

/** Label/value pairs inside an element: two-cell table rows, <dt>/<dd>, "Label: value" lines. */
function labelValues(root: Element | Document, text: TextOf): [string, string][] {
  const pairs: [string, string][] = [];
  for (const row of Array.from(root.querySelectorAll('tr'))) {
    const cells = Array.from(row.children).filter((c) => c.tagName === 'TH' || c.tagName === 'TD');
    if (cells.length === 2) pairs.push([text(cells[0]), text(cells[1])]);
  }
  for (const dt of Array.from(root.querySelectorAll('dt'))) {
    const dd = dt.nextElementSibling;
    if (dd?.tagName === 'DD') pairs.push([text(dt), text(dd)]);
  }
  const labelled = /^\s*([A-Za-z][\w ()/-]{1,30}):\s*(.{1,120}?)\s*$/;
  // Text elements reading "Label: value" (<p>Rating: 4.5 out of 5</p>)
  for (const el of Array.from(root.querySelectorAll('p, li, span, div, small, td')).slice(0, 500)) {
    if (el.children.length > 0) continue;
    const m = labelled.exec(text(el));
    if (m) pairs.push([m[1], m[2]]);
  }
  // Lines of plain text reading the same
  const body = root.nodeType === 9 ? (root as Document).body : (root as Element);
  if (body) {
    for (const line of (body.textContent ?? '').split(/\n|•|\|/)) {
      const m = labelled.exec(line);
      if (m) pairs.push([m[1], m[2]]);
    }
  }
  return pairs.filter(([k, v]) => k && v);
}

/** One field's value in an item, or '' if it isn't there. */
function fieldValue(item: Element, field: string, text: TextOf, pairs: [string, string][], base: string): string {
  // 1. A label that names it
  const labelled = pairs.find(([label]) => labelMatches(label, field));
  if (labelled) return labelled[1];
  // 2. An element whose class, itemprop or aria-label names it
  for (const el of Array.from(item.querySelectorAll('[class], [itemprop], [aria-label]'))) {
    const hint = `${el.getAttribute('class') ?? ''} ${el.getAttribute('itemprop') ?? ''} ${el.getAttribute('aria-label') ?? ''}`;
    if (labelMatches(hint.replace(/[-_]/g, ' '), field)) {
      const value = el.getAttribute('content') || text(el);
      if (value && value.length < 200) return value;
    }
  }
  // 3. The kind of value it is
  const all = text(item);
  switch (kindOf(field)) {
    case 'name': {
      const heading = item.querySelector('h1, h2, h3, h4, h5, h6, a[href], strong, b');
      return heading ? text(heading) : '';
    }
    case 'price': return PRICE.exec(all)?.[0] ?? '';
    case 'link': {
      const a = item.querySelector('a[href]');
      return a ? absolute(a.getAttribute('href')!, base) : '';
    }
    case 'image': {
      const img = item.querySelector('img');
      return img ? absolute(img.getAttribute('src') ?? '', base) : '';
    }
    case 'rating': return RATING.exec(all)?.[1] ?? '';
    case 'date': return DATE.exec(all)?.[0] ?? '';
    default: return '';
  }
}

function absolute(href: string, base: string): string {
  try {
    return new URL(href, base).href;
  } catch {
    return href;
  }
}

function itemFrom(el: Element, fields: string[], text: TextOf, base: string): Item {
  const pairs = labelValues(el, text);
  const item: Item = {};
  for (const field of fields) {
    const value = fieldValue(el, field, text, pairs, base);
    if (value) item[field] = value.slice(0, 200);
  }
  const link = el.querySelector('a[href]') ?? (el.tagName === 'A' ? el : null);
  if (link) item._link = absolute(link.getAttribute('href')!, base);
  // Unmatched fields: give the model the item's text to read itself
  if (fields.some((f) => !(f in item))) item._text = text(el).slice(0, 200);
  return item;
}

// ---------------------------------------------------------------- finding items

/** Tables with a header row: each other row is an item, keyed by column name. */
function tableItems(root: Document | Element, fields: string[], text: TextOf, base: string): Item[][] {
  const out: Item[][] = [];
  for (const table of Array.from(root.querySelectorAll('table'))) {
    const rows = Array.from(table.querySelectorAll('tr'));
    const headerRow = table.querySelector('thead tr') ?? rows.find((r) => r.querySelector('th') && !r.querySelector('td'));
    if (!headerRow) continue;
    const headers = Array.from(headerRow.children).map((c) => text(c));
    if (headers.length < 2) continue;
    const items: Item[] = [];
    for (const row of rows) {
      if (row === headerRow) continue;
      const cells = Array.from(row.children).filter((c) => c.tagName === 'TD' || c.tagName === 'TH');
      if (cells.length !== headers.length) continue;
      const item: Item = {};
      for (const field of fields) {
        const col = headers.findIndex((h) => labelMatches(h, field));
        if (col >= 0) item[field] = text(cells[col]);
      }
      const link = row.querySelector('a[href]');
      if (link) item._link = absolute(link.getAttribute('href')!, base);
      if (fields.some((f) => !(f in item))) item._text = cells.map((c) => text(c)).join(' | ').slice(0, 200);
      items.push(item);
    }
    if (items.length) out.push(items);
  }
  return out;
}

/** Siblings with the same tag and classes, 3 or more: list items, cards, search results. */
function repeatedGroups(root: Document | Element, text: TextOf): Element[][] {
  const groups: Element[][] = [];
  for (const parent of Array.from(root.querySelectorAll('*'))) {
    if (parent.children.length < 3 || /^(TABLE|THEAD|TBODY|TR|SELECT|SCRIPT|STYLE|HEAD)$/.test(parent.tagName)) continue;
    const bySignature = new Map<string, Element[]>();
    for (const child of Array.from(parent.children)) {
      const sig = `${child.tagName}.${[...child.classList].sort().join('.')}`;
      if (!bySignature.has(sig)) bySignature.set(sig, []);
      bySignature.get(sig)!.push(child);
    }
    for (const group of bySignature.values()) {
      if (group.length >= 3 && group.every((el) => text(el).length > 0) && !/^(BR|HR|OPTION|SCRIPT|STYLE)$/.test(group[0].tagName)) {
        groups.push(group);
      }
    }
  }
  return groups;
}

/** How many requested fields the items fill (the best candidate fills the most). */
function filled(items: Item[], fields: string[]): number {
  return items.reduce((n, item) => n + fields.filter((f) => f in item).length, 0) / Math.max(items.length, 1);
}

/** The details of the one thing a page shows (a product page): label/value pairs across it. */
function detailsOf(root: Document | Element, fields: string[], base: string, live = true): Item {
  const page = root.nodeType === 9 ? (root as Document).body ?? (root as Document).documentElement : root;
  const details = itemFrom(page as Element, fields, live ? liveText : plainText, base);
  delete details._link;
  return details;
}

/** Find the items on a page, or the details of the one thing it shows, whichever fits the fields better. */
export function extractItems(root: Document | Element, fields: string[], base: string, live = true): { kind: ExtractResult['kind']; items: Item[] } {
  const text = live ? liveText : plainText;
  const candidates: { kind: ExtractResult['kind']; items: Item[] }[] = [];
  for (const items of tableItems(root, fields, text, base)) candidates.push({ kind: 'table', items });
  for (const group of repeatedGroups(root, text)) {
    candidates.push({ kind: 'list', items: group.map((el) => itemFrom(el, fields, text, base)) });
  }
  // Most fields filled, then most items
  candidates.sort((a, b) => filled(b.items, fields) - filled(a.items, fields) || b.items.length - a.items.length);
  const best = candidates[0];

  const details = detailsOf(root, fields, base, live);
  const detailsFilled = fields.filter((f) => f in details).length;
  // A list wins if it fills as much as the page's details: the navigation menu
  // of a product page fills less than the product's specs
  if (best && filled(best.items, fields) > 0 && filled(best.items, fields) >= detailsFilled) return best;
  if (detailsFilled > 0) return { kind: 'details', items: [details] };
  // Nothing matched, but there are linked items: their pages may have the fields (follow)
  if (best?.items.some((i) => i._link)) return best;
  return { kind: 'none', items: [] };
}

// ---------------------------------------------------------------- follow

async function fetchPage(url: string): Promise<Document | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FOLLOW_TIMEOUT_MS);
  try {
    // Same site only, GET, with the user's cookies: like opening the link.
    // DOMParser never runs the fetched page's scripts.
    const res = await fetch(url, { credentials: 'include', signal: controller.signal });
    if (!res.ok || !(res.headers.get('content-type') ?? '').includes('html')) return null;
    return new DOMParser().parseFromString(await res.text(), 'text/html');
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Fill items' missing fields from their own pages. */
async function follow(items: Item[], fields: string[], origin: string): Promise<{ followed: number; failed: number }> {
  const todo = items
    .filter((item) => item._link && fields.some((f) => !(f in item)))
    .filter((item) => {
      try {
        const url = new URL(item._link);
        return url.origin === origin && !ACTION_LINK.test(url.pathname + url.search);
      } catch {
        return false;
      }
    })
    .slice(0, MAX_FOLLOW);
  let followed = 0;
  let failed = 0;
  let next = 0;
  const worker = async () => {
    while (next < todo.length) {
      const item = todo[next++];
      const doc = await fetchPage(item._link);
      if (!doc) {
        failed++;
        continue;
      }
      const missing = fields.filter((f) => !(f in item));
      const details = detailsOf(doc, missing, item._link, false);
      let got = false;
      for (const field of missing) {
        if (details[field]) {
          item[field] = details[field];
          got = true;
        }
      }
      if (got) followed++;
      else failed++;
      if (fields.every((f) => f in item)) delete item._text;
    }
  };
  await Promise.all(Array.from({ length: FOLLOW_CONCURRENCY }, worker));
  return { followed, failed };
}

/** Extract from this page (and, with follow, the items' pages). */
export async function extract(fields: string[], opts: { follow?: boolean; root?: Document } = {}): Promise<ExtractResult> {
  const doc = opts.root ?? document;
  const base = doc.location?.href ?? document.baseURI;
  const { kind, items } = extractItems(doc, fields, base);
  let followed = 0;
  let followFailed = 0;
  if (opts.follow && (kind === 'list' || kind === 'table')) {
    ({ followed, failed: followFailed } = await follow(items, fields, new URL(base).origin));
  }
  return { kind, items, followed, followFailed };
}

/** The result as the model reads it in its history. */
export function formatExtraction(fields: string[], result: ExtractResult, what = 'items'): string {
  const { kind, items } = result;
  if (kind === 'none' || items.length === 0) {
    return `❌ Found no ${what} with ${fields.join(', ')} on this page. Try read, or open a page that lists them.`;
  }
  const shown = items.slice(0, MAX_ITEMS);
  const lines = shown.map((item, i) => {
    const parts = fields.map((f) => `${f}: ${item[f] ?? '?'}`);
    if (item._text) parts.push(`text: "${item._text}"`);
    if (item._link) parts.push(`link: ${item._link}`);
    return `${i + 1}. ${parts.join(' | ')}`;
  });
  const head = kind === 'details'
    ? `📋 Details on this page (${fields.join(', ')}):`
    : `📋 Extracted ${items.length} ${what} (${kind}):`;
  const notes: string[] = [];
  if (items.length > MAX_ITEMS) notes.push(`${items.length - MAX_ITEMS} more not shown`);
  if (result.followed) notes.push(`read ${result.followed} item page${result.followed === 1 ? '' : 's'} for missing fields`);
  if (result.followFailed) notes.push(`${result.followFailed} item page${result.followFailed === 1 ? '' : 's'} couldn't be read`);
  if (items.some((i) => fields.some((f) => !(f in i)))) notes.push('"?" = not found; see the item text, or open the item');
  return `${head}\n${lines.join('\n')}${notes.length ? `\n(${notes.join('; ')})` : ''}`;
}
