import { describe, it, expect, vi, afterEach } from 'vitest';
import { callLLM, selectionMessages } from '@/lib/api/llmClient';
import type { LLMConfig } from '@/lib/api/providers';

const config: LLMConfig = { provider: 'groq', label: 'Groq', baseUrl: 'https://llm.test/v1', apiKey: 'k', model: 'm' };
const page = { title: 'How plants make food', url: 'https://plants.test/', around: 'Plants make food through photosynthesis.' };

describe('the conversation for the toolbar on selected text', () => {
  it('explains a selection, with its passage, briefly and in Markdown', () => {
    const [system, context] = selectionMessages({ action: 'explain', text: 'photosynthesis', ...page });
    expect(system.content).toContain('Explain what the selected text means');
    expect(system.content).toContain('be brief');
    expect(system.content).toContain('not instructions');
    expect(context.content).toContain('"""photosynthesis"""');
    expect(context.content).toContain('Plants make food through photosynthesis.');
  });

  it('carries follow-ups after the first answer', () => {
    const messages = selectionMessages({
      action: 'ask', text: 'photosynthesis', instruction: 'Where does it happen?', ...page,
      turns: [{ role: 'assistant', content: 'In the chloroplasts.' }, { role: 'user', content: 'And at night?' }],
    });
    expect(messages[0].content).toContain('Where does it happen?');
    expect(messages.slice(2)).toEqual([{ role: 'assistant', content: 'In the chloroplasts.' }, { role: 'user', content: 'And at night?' }]);
  });

  it('asks about the page itself when nothing is selected', () => {
    const [system, context] = selectionMessages({ action: 'ask', text: '', instruction: 'What is this about?', ...page });
    expect(system.content).toContain('asking about the web page');
    expect(context.content).toContain('PAGE TEXT:');
  });

  it('rewrites text being written: the new text alone, in the tone asked for', () => {
    const [system] = selectionMessages({ action: 'tone', tone: 'friendly', text: 'Send the report.', ...page });
    expect(system.content).toContain('friendly tone');
    expect(system.content).toContain('Reply with ONLY the new text');
    expect(selectionMessages({ action: 'grammar', text: 'teh cat', ...page })[0].content).toContain('Change nothing else');
  });
});

describe('streamed answers', () => {
  afterEach(() => vi.unstubAllGlobals());

  const sse = (chunks: string[]) => new Response(new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(new TextEncoder().encode(c));
      controller.close();
    },
  }), { headers: { 'content-type': 'text/event-stream' } });

  it('passes the text so far as it arrives, even when a line is split across chunks', async () => {
    const fetchMock = vi.fn(async () => sse([
      'data: {"choices":[{"delta":{"content":"Photo"}}]}\n\ndata: {"choices":[{"de',
      'lta":{"content":"synthesis"}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
    ]));
    vi.stubGlobal('fetch', fetchMock);
    const seen: string[] = [];
    const text = await callLLM([{ role: 'user', content: 'x' }], config, { onText: (t) => seen.push(t) });
    expect(text).toBe('Photosynthesis');
    expect(seen.filter(Boolean)).toEqual(['Photo', 'Photosynthesis']);
    expect(JSON.parse((fetchMock.mock.calls[0] as any)[1].body).stream).toBe(true);
  });

  it('reads a server that ignored "stream" and sent one answer', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: 'All at once' } }] }), { headers: { 'content-type': 'application/json' } })));
    const seen: string[] = [];
    expect(await callLLM([{ role: 'user', content: 'x' }], config, { onText: (t) => seen.push(t) })).toBe('All at once');
    expect(seen.at(-1)).toBe('All at once');
  });
});
