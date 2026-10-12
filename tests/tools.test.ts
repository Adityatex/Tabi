import { describe, it, expect, vi, afterEach } from 'vitest';
import { AGENT_TOOLS, NEXT_ACTIONS_TOOL, toolCallsToResponse } from '@/lib/agent/tools';
import { parseAgentResponse } from '@/lib/agent/parseAction';
import { planAgentStep, acceptsTools, recoverFailedGeneration } from '@/lib/api/llmClient';
import type { LLMConfig } from '@/lib/api/providers';

const call = (name: string, args: unknown) => ({ function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) } });

describe('tool calls → response', () => {
  it('reads the plan and every action from one next_actions call', () => {
    const text = toolCallsToResponse([call(NEXT_ACTIONS_TOOL, {
      plan: ['[ ] Log in', '[ ] Open orders'],
      actions: [{ action: 'type', elementId: 1, text: 'demo' }, { action: 'click', elementId: 2 }],
    })]);
    expect(parseAgentResponse(text)).toEqual({
      ok: true,
      plan: ['[ ] Log in', '[ ] Open orders'],
      actions: [{ action: 'type', elementId: 1, text: 'demo' }, { action: 'click', elementId: 2 }],
      notes: [],
    });
  });

  it('also reads calls named after actions, if a model invents them', () => {
    const text = toolCallsToResponse([call('set_plan', { items: ['[ ] Search'] }), call('click', { elementId: 4 }), call('wait', { milliseconds: 800 })]);
    expect(parseAgentResponse(text)).toMatchObject({
      ok: true, plan: ['[ ] Search'], actions: [{ action: 'click', elementId: 4 }, { action: 'wait', text: '800' }],
    });
  });

  it('lets the parser report a call with broken arguments', () => {
    const r = parseAgentResponse(toolCallsToResponse([call(NEXT_ACTIONS_TOOL, '{"actions": [{"action": "click"')]));
    expect(r).toEqual({ ok: false, error: '"actions" is empty: send at least one action' });
  });

  it('accepts a plan on its own, asking for actions next', () => {
    const r = parseAgentResponse(toolCallsToResponse([call(NEXT_ACTIONS_TOOL, { plan: ['[ ] Search'], actions: [] })]));
    expect(r).toEqual({ ok: true, plan: ['[ ] Search'], actions: [], notes: ['plan saved; now send the actions to carry it out'] });
  });

  it('offers one tool whose action list covers every action', () => {
    expect(AGENT_TOOLS.map((t) => t.function.name)).toEqual([NEXT_ACTIONS_TOOL]);
    const item = (AGENT_TOOLS[0].function.parameters as any).properties.actions.items;
    expect([...item.properties.action.enum].sort()).toEqual(
      ['clear_and_type', 'click', 'done', 'extract', 'find', 'navigate', 'note', 'press_key', 'read', 'run_code', 'scroll', 'select', 'type', 'use_profile', 'use_skill', 'wait'],
    );
  });

  it("recovers Groq's tool_use_failed for a real tool call, keeping the action name", () => {
    const body = JSON.stringify({ error: { code: 'tool_use_failed', failed_generation: '[{"name":"click","arguments":{"elementId":3}}]' } });
    expect(JSON.parse(recoverFailedGeneration(body)!)).toEqual({ actions: [{ action: 'click', elementId: 3 }] });
  });
});

describe('planAgentStep with native tools', () => {
  afterEach(() => vi.unstubAllGlobals());
  const reply = (message: unknown) => new Response(JSON.stringify({ choices: [{ message }] }), { status: 200 });
  const cfg = (model: string): LLMConfig => ({ provider: 'groq', label: 'Groq', baseUrl: 'https://groq.test/v1', apiKey: 'k', model });

  it('offers the tools, requires a call, and reads the calls back', async () => {
    const fetchMock = vi.fn().mockResolvedValue(reply({ content: null, tool_calls: [call(NEXT_ACTIONS_TOOL, { actions: [{ action: 'click', elementId: 7 }] })] }));
    vi.stubGlobal('fetch', fetchMock);
    const text = await planAgentStep('Buy it', 'PAGE', [], [], cfg('tool-model'));
    expect(JSON.parse(text)).toEqual({ actions: [{ action: 'click', elementId: 7 }] });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.tool_choice).toBe('required');
    expect(body.tools.map((t: any) => t.function.name)).toEqual([NEXT_ACTIONS_TOOL]);
    expect(body.response_format).toBeUndefined();
    expect(body.messages[0].content).toContain('HOW TO ANSWER: call the next_actions tool, once');
  });

  it('falls back to JSON replies, remembered, when the model refuses tools', async () => {
    const config = cfg('no-tools-model');
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('{"error":{"message":"tools is not supported for this model"}}', { status: 400 }))
      .mockImplementation(async () => reply({ content: '{"action":"done","summary":"ok"}' }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(planAgentStep('Goal', 'PAGE', [], [], config)).resolves.toBe('{"action":"done","summary":"ok"}');
    expect(acceptsTools(config)).toBe(false);
    const retry = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(retry.tools).toBeUndefined();
    expect(retry.response_format).toEqual({ type: 'json_object' });
    expect(retry.messages[0].content).toContain('RESPONSE FORMAT (one JSON object');

    // Next time it goes straight to JSON
    await planAgentStep('Goal', 'PAGE', [], [], config);
    expect(JSON.parse(fetchMock.mock.calls[2][1].body).tools).toBeUndefined();
  });

  it('drops tool_choice "required" when the provider rejects it', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('{"error":{"message":"Invalid value for tool_choice: required"}}', { status: 400 }))
      .mockImplementation(async () => reply({ content: null, tool_calls: [call(NEXT_ACTIONS_TOOL, { actions: [{ action: 'done', summary: 'ok' }] })] }));
    vi.stubGlobal('fetch', fetchMock);
    await planAgentStep('Goal', 'PAGE', [], [], cfg('auto-only-model'));
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).tool_choice).toBe('auto');
  });

  it('still reads a model that answers in text despite the tools', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply({ content: '{"actions":[{"action":"scroll","direction":"down"}]}' })));
    const text = await planAgentStep('Goal', 'PAGE', [], [], cfg('texty-model'));
    expect(parseAgentResponse(text)).toMatchObject({ ok: true, actions: [{ action: 'scroll', direction: 'down' }] });
  });

  it('asks for JSON when tools are turned off', async () => {
    const fetchMock = vi.fn().mockResolvedValue(reply({ content: '{"action":"done","summary":"ok"}' }));
    vi.stubGlobal('fetch', fetchMock);
    await planAgentStep('Goal', 'PAGE', [], [], cfg('any-model'), { tools: false });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).tools).toBeUndefined();
  });
});
