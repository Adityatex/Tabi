import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { recoverFailedGeneration, adaptParams, buildRequestBody, callLLM, listModels } from '@/lib/api/llmClient';
import type { LLMConfig } from '@/lib/api/providers';

describe('recoverFailedGeneration', () => {
  it('recovers the action a gpt-oss model wrapped in a fake tool call', () => {
    // Real Groq response body captured by the live eval
    const body = JSON.stringify({
      error: {
        message: 'Tool choice is none, but model called a tool',
        type: 'invalid_request_error',
        code: 'tool_use_failed',
        failed_generation: '{"name": "assistant", "arguments": {"action":"navigate","url":"http://127.0.0.1:51118/search?q=x"}}',
      },
    });
    expect(JSON.parse(recoverFailedGeneration(body)!)).toEqual({ action: 'navigate', url: 'http://127.0.0.1:51118/search?q=x' });
  });

  it('handles arguments encoded as a JSON string', () => {
    const body = JSON.stringify({
      error: { code: 'tool_use_failed', failed_generation: JSON.stringify({ name: 'x', arguments: '{"action":"click","elementId":2}' }) },
    });
    expect(JSON.parse(recoverFailedGeneration(body)!)).toEqual({ action: 'click', elementId: 2 });
  });

  it('returns the raw (often empty) output for JSON-mode validation failures', () => {
    const body = JSON.stringify({ error: { code: 'json_validate_failed', failed_generation: '' } });
    expect(recoverFailedGeneration(body)).toBe('');
  });

  it('ignores other errors', () => {
    expect(recoverFailedGeneration('{"error":{"code":"model_not_found"}}')).toBeNull();
    expect(recoverFailedGeneration('not json')).toBeNull();
  });
});

describe('adaptParams', () => {
  it('drops JSON mode when the server rejects response_format', () => {
    expect(adaptParams('{"error":{"message":"response_format is not supported by this model"}}', {}))
      .toEqual({ noJsonMode: true });
  });

  it('switches to max_completion_tokens when max_tokens is refused', () => {
    expect(adaptParams("Unsupported parameter: 'max_tokens'. Use 'max_completion_tokens' instead.", {}))
      .toEqual({ useMaxCompletionTokens: true });
  });

  it('drops temperature for models that refuse it, keeping earlier fixes', () => {
    expect(adaptParams('temperature is not supported with this model', { noJsonMode: true }))
      .toEqual({ noJsonMode: true, noTemperature: true });
  });

  it('returns null for errors it cannot fix', () => {
    expect(adaptParams('invalid api key', {})).toBeNull();
    expect(adaptParams('response_format bad', { noJsonMode: true })).toBeNull(); // already tried
  });
});

describe('buildRequestBody', () => {
  it('applies fixes', () => {
    const body = buildRequestBody('m', [], { maxTokens: 50, jsonMode: true }, { useMaxCompletionTokens: true, noTemperature: true });
    expect(body).toEqual({ model: 'm', messages: [], max_completion_tokens: 50, top_p: 1, response_format: { type: 'json_object' } });
  });
});

describe('callLLM / listModels with a stubbed provider', () => {
  const config: LLMConfig = { provider: 'openai', label: 'OpenAI', baseUrl: 'https://api.test/v1', apiKey: 'sk-test', model: 'model-x' };
  const ok = (content: string) => new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('retries without JSON mode when the server rejects it', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('{"error":{"message":"response_format json_object is not supported"}}', { status: 400 }))
      .mockResolvedValueOnce(ok('{"action":"done"}'));

    await expect(callLLM([{ role: 'user', content: 'hi' }], { ...config, model: 'no-json' }, { jsonMode: true })).resolves.toBe('{"action":"done"}');
    const second = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(second.response_format).toBeUndefined();
    expect(fetchMock.mock.calls[1][0]).toBe('https://api.test/v1/chat/completions');
  });

  it('explains a rejected key', async () => {
    fetchMock.mockResolvedValue(new Response('{"error":{"message":"Incorrect API key"}}', { status: 401 }));
    await expect(callLLM([], config)).rejects.toThrow(/OpenAI rejected the API key \(401\): Incorrect API key/);
  });

  it('explains an unknown or retired model', async () => {
    fetchMock.mockResolvedValue(new Response('{"error":{"message":"The model does not exist","code":"model_not_found"}}', { status: 404 }));
    await expect(callLLM([], config)).rejects.toThrow(/doesn't offer the model "model-x".*Load models/);
  });

  it('sends no Authorization header without a key (local Ollama)', async () => {
    fetchMock.mockResolvedValue(ok('hi'));
    await callLLM([], { ...config, provider: 'ollama', apiKey: '', baseUrl: 'http://localhost:11434/v1' });
    expect(fetchMock.mock.calls[0][1].headers).not.toHaveProperty('Authorization');
  });

  it('lists model ids, sorted and de-duplicated', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ data: [{ id: 'b' }, { id: 'a' }, { id: 'b' }] }), { status: 200 }));
    await expect(listModels(config)).resolves.toEqual([{ id: 'a' }, { id: 'b' }]);
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.test/v1/models');
  });
});

describe('empty responses', () => {
  const config = { provider: 'openai' as const, label: 'OpenAI', baseUrl: 'https://api.test/v1', apiKey: 'k', model: 'm' };
  afterEach(() => vi.unstubAllGlobals());

  it('says when a reasoning model used up its token budget without answering, after two tries with more room', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: '' }, finish_reason: 'length' }] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(callLLM([], config)).resolves.toMatch(/used its entire token budget/);
    expect(fetchMock.mock.calls.map((c: any) => JSON.parse(c[1].body).max_tokens)).toEqual([2048, 4096, 8192]);
  });
});

describe('request too large', () => {
  it('halves the response cap, down to a floor', () => {
    const groq = 'Request too large for model `qwen/qwen3.8-27b` on tokens per minute (TPM): Limit 8000, Requested 9012, please reduce your message size';
    expect(adaptParams(groq, {}, 4096)).toEqual({ maxTokens: 2048 });
    expect(adaptParams(groq, { maxTokens: 512 }, 4096)).toEqual({ maxTokens: 256 });
    expect(adaptParams(groq, { maxTokens: 256 }, 4096)).toBeNull(); // can't go lower: a real rate limit
  });

  it('goes under a named output-tokens-per-minute limit (Groq OTPM)', () => {
    const otpm = "Request too large for model `qwen/qwen3.8-27b` on output tokens per minute (OTPM): Limit 1000, Requested 1101. The request's expected output tokens exceed the enforced limit; reduce max_tokens";
    expect(adaptParams(otpm, {}, 2048)).toEqual({ maxTokens: 800 });
  });

  it('retries a Groq 429 "Request too large" with a smaller cap, and plain 429s are not adapted', async () => {
    const config = { provider: 'groq' as const, label: 'Groq', baseUrl: 'https://api.groq-test/v1', apiKey: 'k', model: 'big-prompt-model' };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('{"error":{"message":"Request too large for model on tokens per minute (TPM): Limit 8000, Requested 9012"}}', { status: 429 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: '{"action":"done"}' } }] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(callLLM([], config, { maxTokens: 4096 })).resolves.toBe('{"action":"done"}');
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).max_tokens).toBe(2048);
  });
});

describe('listModels: free models and provider filters', () => {
  afterEach(() => vi.unstubAllGlobals());
  const list = (data: unknown[]) => vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ data }), { status: 200 })));

  it('Kilo: marks free and may-train models, lists free first, drops non-text models', async () => {
    list([
      { id: 'anthropic/claude-x', pricing: { prompt: '0.000003', completion: '0.000015' } },
      { id: 'qwen/qwen3.8-27b:free', isFree: true, mayTrainOnYourPrompts: true, architecture: { output_modalities: ['text'] } },
      { id: 'kilo-auto/free', pricing: { prompt: '0', completion: '0' } },
      { id: 'google/lyria-3-pro-preview', architecture: { output_modalities: ['audio'] } },
    ]);
    const models = await listModels({ provider: 'kilo', label: 'Kilo', baseUrl: 'https://api.kilo.ai/api/gateway', apiKey: '', model: '' });
    expect(models).toEqual([
      { id: 'kilo-auto/free', free: true },
      { id: 'qwen/qwen3.8-27b:free', free: true, mayTrain: true },
      { id: 'anthropic/claude-x' },
    ]);
  });

  it('OpenCode Zen: hides models that need other APIs, knows big-pickle is free', async () => {
    list([{ id: 'claude-sonnet-5' }, { id: 'gpt-5.5' }, { id: 'qwen3.8-flash' }, { id: 'deepseek-v4-flash' }, { id: 'big-pickle' }, { id: 'mimo-v2.6-flash-free' }]);
    const models = await listModels({ provider: 'opencode', label: 'OpenCode Zen', baseUrl: 'https://opencode.ai/zen/v1', apiKey: 'k', model: '' });
    expect(models.map(m => m.id)).toEqual(['big-pickle', 'mimo-v2.6-flash-free', 'deepseek-v4-flash']);
    expect(models.filter(m => m.free).map(m => m.id)).toEqual(['big-pickle', 'mimo-v2.6-flash-free']);
  });
});

describe('listModels: Gemini and Mistral lists', () => {
  afterEach(() => vi.unstubAllGlobals());
  const list = (data: unknown[]) => vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ data }), { status: 200 })));

  it('Gemini: drops the "models/" prefix and non-chat models', async () => {
    list([
      { id: 'models/gemini-3.5-flash-lite' }, { id: 'models/gemma-4-31b-it' }, { id: 'models/gemini-3.8-flash-tts' },
      { id: 'models/gemini-embedding-2' }, { id: 'models/gemini-3.1-flash-image' }, { id: 'models/veo-3-generate' },
    ]);
    const models = await listModels({ provider: 'gemini', label: 'Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', apiKey: 'k', model: '' });
    expect(models.map(m => m.id)).toEqual(['gemini-3.5-flash-lite', 'gemma-4-31b-it']);
  });

  it('Mistral: keeps only models that can chat', async () => {
    list([
      { id: 'mistral-small-latest', capabilities: { completion_chat: true } },
      { id: 'mistral-embed', capabilities: { completion_chat: false } },
      { id: 'mistral-ocr-latest', capabilities: { completion_chat: false } },
    ]);
    const models = await listModels({ provider: 'mistral', label: 'Mistral', baseUrl: 'https://api.mistral.ai/v1', apiKey: 'k', model: '' });
    expect(models).toEqual([{ id: 'mistral-small-latest' }]);
  });

  it('reads the message from an error wrapped in an array (Gemini)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify([{ error: { code: 400, message: 'API key not valid' } }]), { status: 400 })));
    await expect(listModels({ provider: 'gemini', label: 'Gemini', baseUrl: 'https://x.test', apiKey: 'k', model: '' }))
      .rejects.toThrow('Gemini could not list models (400): API key not valid');
  });
});

describe('a model that thinks through its whole budget', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('is asked again with twice the room, up to a ceiling, and the room is remembered', async () => {
    const config: LLMConfig = { provider: 'deepseek', label: 'DeepSeek', baseUrl: 'https://think.test/v1', apiKey: 'k', model: 'thinker' };
    const caps: number[] = [];
    const fetchMock = vi.fn(async (_url: string, init: any) => {
      const cap = JSON.parse(init.body).max_tokens;
      caps.push(cap);
      const choice = cap < 8192
        ? { message: { content: '' }, finish_reason: 'length' }
        : { message: { content: '{"actions":[]}' }, finish_reason: 'stop' };
      return new Response(JSON.stringify({ choices: [choice] }), { headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    expect(await callLLM([{ role: 'user', content: 'x' }], config, { maxTokens: 4096 })).toBe('{"actions":[]}');
    expect(caps).toEqual([4096, 8192]);
    await callLLM([{ role: 'user', content: 'x' }], config, { maxTokens: 4096 });
    expect(caps.at(-1)).toBe(8192); // remembered: no wasted first try
  });
});
