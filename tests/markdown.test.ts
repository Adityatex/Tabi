import { describe, it, expect } from 'vitest';
import { renderMarkdown } from '@/lib/utils/markdown';

describe('renderMarkdown', () => {
  it('splits paragraphs on blank lines and keeps single line breaks', () => {
    expect(renderMarkdown('One\ntwo\n\nThree')).toBe('<p>One<br/>two</p><p>Three</p>');
  });

  it('escapes HTML, so a page or model can’t inject markup', () => {
    expect(renderMarkdown('<img src=x onerror=alert(1)> & "q"')).toBe('<p>&lt;img src=x onerror=alert(1)&gt; &amp; &quot;q&quot;</p>');
  });

  it('renders numbered and bulleted lists, a list right after a sentence included', () => {
    expect(renderMarkdown('Ways to grow it:\n1. Polish the README\n2. Post on **Show HN**'))
      .toBe('<p>Ways to grow it:</p><ol class="md-ol"><li>Polish the README</li><li>Post on <strong>Show HN</strong></li></ol>');
    expect(renderMarkdown('- a\n* b\n+ c')).toBe('<ul class="md-ul"><li>a</li><li>b</li><li>c</li></ul>');
  });

  it('keeps a numbered list that starts later, and items split by blank lines', () => {
    expect(renderMarkdown('3. c\n\n4. d')).toBe('<ol class="md-ol" start="3"><li>c</li><li>d</li></ol>');
  });

  it('nests indented items under the item above them', () => {
    expect(renderMarkdown('1. Pick\n   - cheap\n   - quiet\n2. Buy'))
      .toBe('<ol class="md-ol"><li>Pick<ul class="md-ul"><li>cheap</li><li>quiet</li></ul></li><li>Buy</li></ol>');
    expect(renderMarkdown('- a\n  - b')).toBe('<ul class="md-ul"><li>a<ul class="md-ul"><li>b</li></ul></li></ul>');
  });

  it('renders headings, rules, quotes and code blocks', () => {
    expect(renderMarkdown('## Result')).toBe('<h3 class="md-h2">Result</h3>');
    expect(renderMarkdown('---')).toBe('<hr class="md-hr" />');
    expect(renderMarkdown('> said')).toBe('<blockquote class="md-quote">said</blockquote>');
    expect(renderMarkdown('```\nlet a = **1**;\n```')).toBe('<pre class="code-block"><code>let a = **1**;</code></pre>');
  });

  it('renders tables, in a box that can scroll sideways', () => {
    expect(renderMarkdown('| Model | Price |\n|---|---:|\n| KZ ZSN | ₹1,999 |'))
      .toBe('<div class="md-table"><table><thead><tr><th>Model</th><th>Price</th></tr></thead><tbody><tr><td>KZ ZSN</td><td>₹1,999</td></tr></tbody></table></div>');
  });

  it('formats inline text, but not inside code or snake_case words', () => {
    expect(renderMarkdown('**bold**, *it*, _it_ and `a*b*c`')).toBe('<p><strong>bold</strong>, <em>it</em>, <em>it</em> and <code class="inline-code">a*b*c</code></p>');
    expect(renderMarkdown('use tabi_mcp_token here')).toBe('<p>use tabi_mcp_token here</p>');
  });

  it('links only to http(s) addresses, in a new tab', () => {
    expect(renderMarkdown('[repo](https://github.com/Adityatex/Tabi)'))
      .toBe('<p><a href="https://github.com/Adityatex/Tabi" target="_blank" rel="noopener noreferrer">repo</a></p>');
    expect(renderMarkdown('[x](javascript:alert(1))')).toBe('<p>[x](javascript:alert(1))</p>');
  });
});

describe('code blocks with a Copy button', () => {
  it('heads a code block with its language and a button to copy just the code', () => {
    expect(renderMarkdown('Here:\n```cpp\nint x = 1 < 2;\n```', { copyCode: true }))
      .toBe('<p>Here:</p><div class="code"><div class="code-head"><span>cpp</span><button type="button" class="code-copy" data-copy-code>Copy</button></div>'
        + '<pre class="code-block"><code>int x = 1 &lt; 2;</code></pre></div>');
    expect(renderMarkdown('```\nx\n```', { copyCode: true })).toContain('<span>code</span>');
  });

  it('leaves code blocks plain unless asked', () => {
    expect(renderMarkdown('```js\nx\n```')).toBe('<pre class="code-block"><code>x</code></pre>');
  });
});
