// The page's visible text, read with a TreeWalker.

const EXCLUDED_TAGS = new Set([
  'SCRIPT', 'STYLE', 'NOSCRIPT', 'IFRAME', 'OBJECT',
  'EMBED', 'SVG', 'CANVAS', 'TEMPLATE', 'HEAD',
]);

const MAX_TEXT_LENGTH = 15000;

function isElementVisible(el: Element): boolean {
  if (!(el instanceof HTMLElement)) return true;

  const style = window.getComputedStyle(el);
  if (style.display === 'none') return false;
  if (style.visibility === 'hidden') return false;
  if (style.opacity === '0') return false;
  if (el.getAttribute('aria-hidden') === 'true') return false;

  return true;
}

function isExcludedTag(node: Node): boolean {
  let current: Node | null = node;
  while (current && current !== document.body) {
    if (current.nodeType === Node.ELEMENT_NODE) {
      const el = current as Element;
      if (EXCLUDED_TAGS.has(el.tagName)) return true;
      if (!isElementVisible(el)) return true;
    }
    current = current.parentNode;
  }
  return false;
}

/** The page's visible text, without scripts, styles and hidden elements, cut at MAX_TEXT_LENGTH. */
export function extractVisibleText(): string {
  const walker = document.createTreeWalker(
    document.body,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode(node: Node): number {
        if (!node.textContent || node.textContent.trim().length === 0) {
          return NodeFilter.FILTER_REJECT;
        }
        if (isExcludedTag(node)) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    }
  );

  const textParts: string[] = [];
  let totalLength = 0;

  while (walker.nextNode()) {
    const text = walker.currentNode.textContent?.trim();
    if (text && text.length > 0) {
      textParts.push(text);
      totalLength += text.length;
      if (totalLength >= MAX_TEXT_LENGTH) break;
    }
  }

  let result = textParts.join('\n');
  result = result.replace(/[ \t]+/g, ' ');
  result = result.replace(/\n{3,}/g, '\n\n');
  result = result.trim();

  if (result.length > MAX_TEXT_LENGTH) {
    result = result.substring(0, MAX_TEXT_LENGTH) + '\n\n[... text truncated for processing]';
  }

  return result;
}
