import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { responsesBody } from '@/lib/api/responses';
import { callLLM, listModels, planAgentStep, LLMError } from '@/lib/api/llmClient';
import { AUTH_KEY, resetForTests } from '@/lib/api/chatgptAuth';
import { configProblem, resolveConfig, type LLMConfig } from '@/lib/api/providers';
import { failureKind } from '@/lib/panel/view';

const CONFIG: LLMConfig = { provider: 'chatgpt', label: 'ChatGPT plan', baseUrl: 'https://api.openai.com/v1', apiKey: '', model: 'gpt-5.5', signIn: { email: 'ada@example.com', planUsage: true } };

/** A server-sent event stream of Responses events. */
const stream = (...events: unknown[]) => new Response(events.map((e) => `event: ${(e as any).type}\ndata: ${JSON.stringify(e)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
const completed = (output: unknown[], usage = { input_tokens: 1200, output_tokens: 40 }) => ({ type: 'response.completed', response: { status: 'completed', output, usage } });

let requests: { url: string; headers: Record<string, string>; body: any }[];
let answer: (n: number) => Response | Promise<Response>;

beforeEach(async () => {
  resetForTests();
  requests = [];
  await browser.storage.local.set({
    [AUTH_KEY]: {
      hostId: 'urn:uuid:test',
      account: { clientId: 'oaiapp_t', sub: 'u', email: 'ada@example.com', planUsage: true, scopes: [], accessToken: 'at-1', refreshToken: 'rt-1', idToken: 'i', expiresAt: Date.now() + 3_600_000, savedAt: 0 },
    },
  });
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/oauth/token')) {
      return new Response(JSON.stringify({ access_token: 'at-2', refresh_token: 'rt-2', expires_in: 3600, scope: 'chatgpt.tokens.use.direct' }), { headers: { 'content-type': 'application/json' } });
    }
    requests.push({ url, headers: init?.headers as Record<string, string>, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return answer(requests.length);
  }));
});
afterEach(() => vi.unstubAllGlobals());

describe('the Responses request', () => {
  it('sends system text as instructions, the rest as input, streamed and not stored, without sampling fields', () => {
    const body = responsesBody('gpt-5.5', [
      { role: 'system', content: 'You are Tabi.' },
      { role: 'user', content: [{ type: 'text', text: 'Look' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } }] },
      { role: 'assistant', content: 'Earlier answer' },
    ], { tools: [{ type: 'function', function: { name: 'next_actions', description: 'd', parameters: { type: 'object' } } }] });
    expect(body).toEqual({
      model: 'gpt-5.5',
      instructions: 'You are Tabi.',
      input: [
        { role: 'user', content: [{ type: 'input_text', text: 'Look' }, { type: 'input_image', image_url: 'data:image/png;base64,AAA' }] },
        { role: 'assistant', content: [{ type: 'output_text', text: 'Earlier answer' }] },
      ],
      store: false,
      stream: true,
      tools: [{ type: 'function', name: 'next_actions', description: 'd', parameters: { type: 'object' } }],
      tool_choice: 'required',
    });
  });
});

describe('the ChatGPT plan through callLLM', () => {
  it('streams text with the signed-in token, and counts the tokens', async () => {
    answer = () => stream({ type: 'response.output_text.delta', delta: 'Hel' }, { type: 'response.output_text.delta', delta: 'lo' }, completed([]));
    const seen: string[] = [];
    let usage;
    const text = await callLLM([{ role: 'user', content: 'Hi' }], CONFIG, { onText: (t) => seen.push(t), onUsage: (u) => { usage = u; } });
    expect(text).toBe('Hello');
    expect(seen.at(-1)).toBe('Hello');
    expect(usage).toEqual({ prompt: 1200, completion: 40 });
    expect(requests[0].url).toBe('https://api.openai.com/v1/responses');
    expect(requests[0].headers.Authorization).toBe('Bearer at-1');
  });

  it('reads a stream by its body, whatever its content-type says (the real server’s)', async () => {
    const sse = stream({ type: 'response.output_text.delta', delta: 'Hi there' }, completed([]));
    const body = await sse.text();
    for (const headers of [{ 'content-type': 'application/json' }, {} as Record<string, string>]) {
      // The last event without its blank line after it, as a server may end
      answer = () => new Response(body.trimEnd(), { headers });
      expect(await callLLM([{ role: 'user', content: 'hello' }], CONFIG)).toBe('Hi there');
    }
    answer = () => new Response(JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'Whole' }] }] }), { headers: { 'content-type': 'text/event-stream' } });
    expect(await callLLM([{ role: 'user', content: 'hello' }], CONFIG)).toBe('Whole');
  });

  it('turns the agent’s tool call into its actions', async () => {
    answer = () => stream(
      { type: 'response.output_item.done', item: { type: 'function_call', call_id: 'c1', name: 'next_actions', arguments: JSON.stringify({ actions: [{ action: 'click', elementId: 3 }] }) } },
      completed([{ type: 'function_call', call_id: 'c1', name: 'next_actions', arguments: JSON.stringify({ actions: [{ action: 'click', elementId: 3 }] }) }]),
    );
    const reply = await planAgentStep('Click it', '[3] <button> "Go"', [], [], CONFIG);
    expect(JSON.parse(reply).actions).toEqual([{ action: 'click', elementId: 3 }]);
    expect(requests[0].body.tool_choice).toBe('required');
    expect(requests[0].body).not.toHaveProperty('temperature');
  });

  it('stops at a usage limit, even one that arrives mid-stream, and says where to look', async () => {
    answer = () => stream(
      { type: 'response.output_text.delta', delta: 'Par' },
      { type: 'response.failed', response: { error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'Usage limit reached' } } },
    );
    const error = await callLLM([{ role: 'user', content: 'Hi' }], CONFIG).catch((e) => e);
    expect(error).toBeInstanceOf(LLMError);
    expect(error.kind).toBe('daily');
    expect(error.message).toContain('https://chatgpt.com/settings/usage');
    expect(failureKind(error.message)).toBe('plan_limit');
    expect(requests).toHaveLength(1); // not retried: the limit won't lift in seconds
  });

  it('gets a fresh token once when the API refuses one, then carries on', async () => {
    answer = (n) => (n === 1 ? new Response(JSON.stringify({ detail: 'Unauthorized' }), { status: 401 }) : stream({ type: 'response.output_text.delta', delta: 'ok' }, completed([])));
    expect(await callLLM([{ role: 'user', content: 'Hi' }], CONFIG)).toBe('ok');
    expect(requests.map((r) => r.headers.Authorization)).toEqual(['Bearer at-1', 'Bearer at-2']);
  });

  it('drops the screenshot when the plan won’t take images', async () => {
    answer = (n) => (n === 1
      ? new Response(JSON.stringify({ error: { code: 'subscription_sharing_unsupported_capability', message: 'Unsupported input', param: 'input[0].content[1].input_image' } }), { status: 400 })
      : stream({ type: 'response.output_text.delta', delta: 'ok' }, completed([])));
    const text = await callLLM([{ role: 'user', content: [{ type: 'text', text: 'Hi' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } }] }], { ...CONFIG, model: 'no-vision' });
    expect(text).toBe('ok');
    expect(requests[1].body.input[0].content).toEqual([{ type: 'input_text', text: 'Hi' }]);
  });

  it('explains an account whose plan can’t be used in apps', async () => {
    answer = () => new Response(JSON.stringify({ error: { code: 'subscription_sharing_user_not_eligible', message: 'Not eligible' } }), { status: 403 });
    await expect(callLLM([{ role: 'user', content: 'Hi' }], CONFIG)).rejects.toThrow(/OpenAI decides which plans/);
  });

  it('lists the models marked for pickers, by slug', async () => {
    answer = () => new Response(JSON.stringify({ data: [{ slug: 'gpt-5.5', display_name: 'GPT-5.5', visibility: 'list' }, { slug: 'internal-x', visibility: 'hide' }] }), { headers: { 'content-type': 'application/json' } });
    expect((await listModels(CONFIG)).map((m) => m.id)).toEqual(['gpt-5.5']);
    expect(requests[0].url).toBe('https://api.openai.com/v1/models');
    expect(requests[0].headers.Authorization).toBe('Bearer at-1');
  });
});

describe('setting up the ChatGPT plan', () => {
  it('is ready only when signed in with plan usage and a model chosen', () => {
    const settings = { provider: 'chatgpt' as const, models: { chatgpt: 'gpt-5.5' }, keys: {} };
    expect(configProblem(resolveConfig(settings))).toMatch(/Sign in with ChatGPT/);
    expect(configProblem(resolveConfig({ ...settings, chatgpt: { email: 'a@b.c', planUsage: false } }))).toMatch(/OpenAI decides which plans/);
    expect(configProblem(resolveConfig({ ...settings, chatgpt: { email: 'a@b.c', planUsage: true } }))).toBeNull();
  });
});
