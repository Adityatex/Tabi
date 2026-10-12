import { describe, it, expect, vi, afterEach } from 'vitest';
import { layoutFor, type VisualInfo } from '@/lib/agent/screenshot';
import { callLLM, acceptsImages, planAgentStep } from '@/lib/api/llmClient';
import type { LLMConfig } from '@/lib/api/providers';

const info = (width: number, height: number): VisualInfo => ({ marks: [], viewport: { width, height } });

describe('screenshot layout', () => {
  it('shrinks a large capture to 1024 px wide', () => {
    // 1600×900 CSS viewport captured at 2x
    const l = layoutFor(info(1600, 900), 3200, 1800);
    expect(l).toMatchObject({ sx: 0, sy: 0, sw: 3200, sh: 1800, width: 1024 });
    expect(l.scale).toBeCloseTo(1024 / 1600);
    expect(l.height).toBe(Math.round(900 * (1024 / 1600)));
  });

  it('never enlarges a small capture', () => {
    const l = layoutFor(info(800, 600), 800, 600);
    expect(l).toMatchObject({ sw: 800, width: 800, height: 600, scale: 1 });
  });
});

describe('models that refuse images', () => {
  afterEach(() => vi.unstubAllGlobals());
  const config: LLMConfig = { provider: 'deepseek', label: 'DeepSeek', baseUrl: 'https://deepseek.test', apiKey: 'k', model: 'text-only' };

  it('retries without the screenshot and remembers the model is text-only', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('{"error":{"message":"Failed to deserialize the JSON body into the target type: messages[1]: unknown variant `image_url`, expected `text`"}}', { status: 400 }))
      .mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: '{"action":"done"}' } }] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    expect(acceptsImages(config)).toBe(true);
    await expect(planAgentStep('goal', 'PAGE', [], [], config, { image: 'data:image/jpeg;base64,AAAA' })).resolves.toBe('{"action":"done"}');
    expect(acceptsImages(config)).toBe(false);

    const first = JSON.parse(fetchMock.mock.calls[0][1].body);
    const retry = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(first.messages[1].content[1]).toEqual({ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAAA' } });
    expect(typeof retry.messages[1].content).toBe('string'); // text only now
    expect(retry.messages[1].content).toContain('GOAL: goal');
  });

  it('does not blame images for an error on a request without any', async () => {
    const other: LLMConfig = { ...config, model: 'other' };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{"error":{"message":"invalid image token"}}', { status: 400 })));
    await expect(callLLM([{ role: 'user', content: 'hi' }], other)).rejects.toThrow();
    expect(acceptsImages(other)).toBe(true);
  });
});
