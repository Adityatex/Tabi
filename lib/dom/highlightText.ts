// Show where an answer came from: find a few words on the page (ignoring case
// and spacing), scroll to them and outline them for a moment. Used by the
// side panel's numbered sources.

const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'TEXTAREA']);

/** Where `quote` is in the page's text, as a Range, or null. Tries its first words if the whole doesn't match. */
export function findText(quote: string, root: Node = document.body): Range | null {
  // The page's text without spaces (markup splits words unpredictably), and where each character came from
  const chars: string[] = [];
  const from: [Text, number][] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => (SKIP.has(node.parentElement?.tagName ?? '') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    const text = node.data;
    for (let i = 0; i < text.length; i++) {
      if (/\s/.test(text[i])) continue;
      chars.push(text[i].toLowerCase());
      from.push([node, i]);
    }
  }
  const all = chars.join('');
  const words = quote.trim().toLowerCase().split(/\s+/);
  const tries = [words.join(''), words.slice(0, 6).join('')].filter((t, i, list) => t.length >= 3 && list.indexOf(t) === i);
  for (const t of tries) {
    const at = all.indexOf(t);
    if (at < 0) continue;
    const [startNode, startOffset] = from[at];
    const [endNode, endOffset] = from[at + t.length - 1];
    const range = document.createRange();
    range.setStart(startNode, startOffset);
    range.setEnd(endNode, Math.min(endOffset + 1, endNode.data.length));
    return range;
  }
  return null;
}

/** Scroll to `quote` and outline it for `ms`; false if it isn't on the page. */
export function highlightText(quote: string, ms = 2500): boolean {
  const range = findText(quote);
  if (!range) return false;
  range.startContainer.parentElement?.scrollIntoView({ block: 'center', behavior: 'auto' });
  const boxes = [...range.getClientRects()].filter((r) => r.width > 0 && r.height > 0);
  const marks = boxes.map((r) => {
    const mark = document.createElement('div');
    Object.assign(mark.style, {
      position: 'fixed', left: `${r.left - 3}px`, top: `${r.top - 2}px`, width: `${r.width + 6}px`, height: `${r.height + 4}px`,
      borderRadius: '3px', background: 'rgba(43,69,216,.14)', boxShadow: '0 0 0 2px rgba(43,69,216,.7)',
      pointerEvents: 'none', zIndex: '2147483647', transition: 'opacity .3s',
    });
    mark.setAttribute('data-tabi-highlight', '');
    document.documentElement.append(mark);
    return mark;
  });
  setTimeout(() => {
    for (const mark of marks) mark.style.opacity = '0';
    setTimeout(() => marks.forEach((m) => m.remove()), 300);
  }, ms);
  return true;
}
