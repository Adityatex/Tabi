// lib/utils/markdown.ts
// A small Markdown renderer for what the model writes in the side panel:
// answers, and the result of a task. Block by block (paragraphs, headings,
// lists with nesting, tables, quotes, code), then inline (bold, italic, code,
// links). HTML in the text is escaped first, and links must be http(s).

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Bold, italic, code and links inside one block of escaped text. */
function inline(text: string): string {
  const codes: string[] = [];
  let html = text.replace(/`([^`\n]+)`/g, (_, code: string) => `\u0000${codes.push(code) - 1}\u0000`);
  html = html.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  html = html.replace(/(\*\*|__)(?=\S)(.+?\S)\1/g, '<strong>$2</strong>');
  html = html.replace(/(^|[^\w*])\*(?=\S)([^*\n]+?\S|\S)\*(?!\w)/g, '$1<em>$2</em>');
  html = html.replace(/(^|[^\w_])_(?=\S)([^_\n]+?\S|\S)_(?!\w)/g, '$1<em>$2</em>');
  return html.replace(/\u0000(\d+)\u0000/g, (_, i: string) => `<code class="inline-code">${codes[Number(i)]}</code>`);
}

const LIST_ITEM = /^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/;
const TABLE_RULE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const cells = (row: string) => row.trim().replace(/^\||\|$/g, '').split('|').map((c) => inline(c.trim()));

/** Lines of one list (with deeper items nested under the item above them) as HTML. */
function list(lines: string[]): string {
  let html = '';
  const open: { indent: number; tag: 'ul' | 'ol' }[] = [];
  for (const line of lines) {
    const m = LIST_ITEM.exec(line);
    if (!m) {
      // A line that continues the item above it
      html = html.replace(/<\/li>$/, '') + `<br/>${inline(line.trim())}</li>`;
      continue;
    }
    const indent = m[1].replace(/\t/g, '  ').length;
    const tag = /\d/.test(m[2]) ? 'ol' : 'ul';
    while (open.length > 1 && indent < open[open.length - 1].indent) html += `</${open.pop()!.tag}></li>`;
    const top = open[open.length - 1];
    if (!top || indent > top.indent) {
      if (top) html = html.replace(/<\/li>$/, '');
      const start = tag === 'ol' && !top ? Number.parseInt(m[2], 10) : 1;
      html += `<${tag} class="md-${tag}"${start > 1 ? ` start="${start}"` : ''}>`;
      open.push({ indent, tag });
    } else if (top.tag !== tag) {
      html += `</${open.pop()!.tag}><${tag} class="md-${tag}">`;
      open.push({ indent, tag });
    }
    html += `<li>${inline(m[3])}</li>`;
  }
  while (open.length) {
    const { tag } = open.pop()!;
    html += open.length ? `</${tag}></li>` : `</${tag}>`;
  }
  return html;
}

export interface MarkdownOptions {
  /**
   * Put a header on code blocks with their language and a Copy button
   * (button[data-copy-code]); the page that shows it handles the click.
   */
  copyCode?: boolean;
}

export function renderMarkdown(text: string, opts: MarkdownOptions = {}): string {
  if (!text) return '';
  const lines = escapeHtml(text.replace(/\r\n?/g, '\n')).split('\n');
  const blocks: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }

    const fence = /^\s*```\s*([\w#+.-]*)/.exec(line);
    if (fence) {
      const code: string[] = [];
      for (i++; i < lines.length && !/^\s*```/.test(lines[i]); i++) code.push(lines[i]);
      i++;
      const pre = `<pre class="code-block"><code>${code.join('\n')}</code></pre>`;
      blocks.push(opts.copyCode
        ? `<div class="code"><div class="code-head"><span>${fence[1] || 'code'}</span><button type="button" class="code-copy" data-copy-code>Copy</button></div>${pre}</div>`
        : pre);
      continue;
    }
    const heading = /^(#{1,6})\s+(.+?)\s*#*$/.exec(line);
    if (heading) {
      const level = Math.min(heading[1].length, 3);
      blocks.push(`<h${level + 1} class="md-h${level}">${inline(heading[2])}</h${level + 1}>`);
      i++;
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      blocks.push('<hr class="md-hr" />');
      i++;
      continue;
    }
    if (line.includes('|') && i + 1 < lines.length && TABLE_RULE.test(lines[i + 1])) {
      const head = cells(line);
      const rows: string[][] = [];
      for (i += 2; i < lines.length && lines[i].includes('|') && lines[i].trim(); i++) rows.push(cells(lines[i]));
      blocks.push(
        '<div class="md-table"><table><thead><tr>' + head.map((c) => `<th>${c}</th>`).join('') + '</tr></thead><tbody>'
        + rows.map((r) => '<tr>' + head.map((_, c) => `<td>${r[c] ?? ''}</td>`).join('') + '</tr>').join('')
        + '</tbody></table></div>',
      );
      continue;
    }
    if (/^&gt;\s?/.test(line)) {
      const quote: string[] = [];
      for (; i < lines.length && /^&gt;\s?/.test(lines[i]); i++) quote.push(inline(lines[i].replace(/^&gt;\s?/, '')));
      blocks.push(`<blockquote class="md-quote">${quote.join('<br/>')}</blockquote>`);
      continue;
    }
    if (LIST_ITEM.test(line)) {
      const items: string[] = [];
      // A list runs until a blank line that isn't followed by more of it
      for (; i < lines.length; i++) {
        if (!lines[i].trim()) {
          if (i + 1 < lines.length && LIST_ITEM.test(lines[i + 1])) continue;
          break;
        }
        if (!LIST_ITEM.test(lines[i]) && !/^\s+\S/.test(lines[i])) break;
        items.push(lines[i]);
      }
      blocks.push(list(items));
      continue;
    }
    const para: string[] = [];
    for (; i < lines.length && lines[i].trim(); i++) {
      if (para.length && (LIST_ITEM.test(lines[i]) || /^(#{1,6}\s|\s*```|&gt;)/.test(lines[i]))) break;
      para.push(inline(lines[i].trim()));
    }
    blocks.push(`<p>${para.join('<br/>')}</p>`);
  }
  return blocks.join('');
}

/**
 * For a click inside rendered Markdown: a code block's Copy button copies
 * just that block's code, and says so for a moment. True if it was one.
 */
export function copyCodeOnClick(target: EventTarget | null): boolean {
  const button = (target as Element | null)?.closest?.('[data-copy-code]') as HTMLButtonElement | null;
  if (!button) return false;
  const code = button.closest('.code')?.querySelector('code')?.textContent ?? '';
  navigator.clipboard?.writeText(code).then(() => {
    button.textContent = 'Copied';
    setTimeout(() => { button.textContent = 'Copy'; }, 1400);
  }).catch(() => {});
  return true;
}
