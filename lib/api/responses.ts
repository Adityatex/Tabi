// The OpenAI Responses API, as the ChatGPT plan uses it
// (developers.openai.com/siwc/token-sharing-open-source/models-and-inference):
// Tabi's chat messages and tools turned into a request, and the streamed
// answer turned back into text or tool calls. The plan's requests must stream
// and not be stored, and take no temperature, top_p or token cap.

import type { ToolCall, ToolDef } from '@/lib/agent/tools';

type Part = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };

export interface ResponsesMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | Part[];
}

export interface ResponsesOptions {
  tools?: ToolDef[];
  /** Let the model answer without calling a tool (some models refuse "required"). */
  toolChoiceAuto?: boolean;
  noImages?: boolean;
}

/** The request body: system messages become instructions, the rest the input. */
export function responsesBody(model: string, messages: ResponsesMessage[], opts: ResponsesOptions = {}): Record<string, unknown> {
  const instructions = messages.filter((m) => m.role === 'system').map((m) => textOf(m.content)).join('\n\n');
  const input = messages.filter((m) => m.role !== 'system').map((m) => {
    const parts = typeof m.content === 'string' ? [{ type: 'text' as const, text: m.content }] : m.content;
    if (m.role === 'assistant') return { role: 'assistant', content: [{ type: 'output_text', text: textOf(m.content) }] };
    return {
      role: 'user',
      content: parts
        .filter((p) => p.type === 'text' || !opts.noImages)
        .map((p) => (p.type === 'text' ? { type: 'input_text', text: p.text } : { type: 'input_image', image_url: p.image_url.url })),
    };
  });
  const body: Record<string, unknown> = { model, input, store: false, stream: true };
  if (instructions) body.instructions = instructions;
  if (opts.tools?.length) {
    body.tools = opts.tools.map((t) => ({ type: 'function', name: t.function.name, description: t.function.description, parameters: t.function.parameters }));
    body.tool_choice = opts.toolChoiceAuto ? 'auto' : 'required';
  }
  return body;
}

function textOf(content: string | Part[]): string {
  return typeof content === 'string' ? content : content.map((p) => (p.type === 'text' ? p.text : '')).filter(Boolean).join('\n\n');
}

/** What a streamed answer came to. */
export interface ResponsesResult {
  text: string;
  calls: ToolCall[];
  usage?: { prompt: number; completion: number };
  /** completed is the only success; cut = the stream ended without saying how it went. */
  ended: 'completed' | 'failed' | 'incomplete' | 'cut';
  error?: { code: string; message: string; param?: string };
  /** Why it was incomplete (e.g. max_output_tokens). */
  reason?: string;
}

/** Read the parts of a finished response object (a completed event, or a non-streamed body). */
function fromResponse(response: any, into: ResponsesResult): void {
  for (const item of response?.output ?? []) {
    if (item?.type === 'function_call' && !into.calls.some((c) => (c as any).id === item.call_id)) {
      into.calls.push({ function: { name: item.name, arguments: item.arguments ?? '{}' }, id: item.call_id } as ToolCall);
    }
    if (item?.type === 'message' && !into.text) {
      into.text = (item.content ?? []).filter((c: any) => c?.type === 'output_text').map((c: any) => c.text).join('');
    }
  }
  const u = response?.usage;
  if (u) into.usage = { prompt: u.input_tokens ?? 0, completion: u.output_tokens ?? 0 };
}

/** One server-sent event (its JSON data), folded into the result. */
export function foldEvent(event: any, result: ResponsesResult, onText?: (soFar: string) => void): void {
  switch (event?.type) {
    case 'response.output_text.delta':
      if (typeof event.delta === 'string' && event.delta) {
        result.text += event.delta;
        onText?.(result.text);
      }
      break;
    case 'response.output_item.done':
      if (event.item?.type === 'function_call') fromResponse({ output: [event.item] }, result);
      break;
    case 'response.completed':
      result.ended = 'completed';
      fromResponse(event.response, result);
      break;
    case 'response.incomplete':
      result.ended = 'incomplete';
      result.reason = event.response?.incomplete_details?.reason;
      fromResponse(event.response, result);
      break;
    case 'response.failed': {
      result.ended = 'failed';
      const e = event.response?.error ?? {};
      result.error = { code: String(e.code ?? ''), message: String(e.message ?? 'The response failed'), param: e.param ?? undefined };
      break;
    }
    case 'error':
      result.ended = 'failed';
      result.error = { code: String(event.code ?? event.error?.code ?? ''), message: String(event.message ?? event.error?.message ?? 'The response failed'), param: event.param ?? event.error?.param ?? undefined };
      break;
  }
}

/** A whole (not streamed) response object, or an error body. */
function readWhole(text: string, result: ResponsesResult, onText?: (soFar: string) => void): void {
  let data;
  try { data = JSON.parse(text); } catch { throw new Error(`OpenAI sent an answer Tabi couldn’t read: ${text.slice(0, 80)}`); }
  result.ended = data?.status === 'completed' ? 'completed' : data?.status === 'incomplete' ? 'incomplete' : data?.error ? 'failed' : 'completed';
  if (data?.error) result.error = { code: String(data.error.code ?? ''), message: String(data.error.message ?? ''), param: data.error.param };
  fromResponse(data, result);
  if (result.text) onText?.(result.text);
}

/**
 * Read a streamed response through its last event. Whether it is a stream is
 * told from the body itself, not its content-type (the real server's isn't
 * always text/event-stream): a body that starts with "{" is one finished
 * response object.
 */
export async function readResponses(response: Response, onText?: (soFar: string) => void, readTimeout?: <T>(p: Promise<T>) => Promise<T>): Promise<ResponsesResult> {
  const result: ResponsesResult = { text: '', calls: [], ended: 'cut' };
  if (!response.body) {
    readWhole(await response.text(), result, onText);
    return result;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let whole: boolean | undefined;
  const fold = (line: string) => {
    if (!line.startsWith('data:')) return;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') return;
    try { foldEvent(JSON.parse(data), result, onText); } catch { /* a line that isn't JSON */ }
  };
  for (;;) {
    const { value, done } = await (readTimeout ? readTimeout(reader.read()) : reader.read());
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    whole ??= buffer.trimStart() ? buffer.trimStart().startsWith('{') : undefined;
    if (whole !== false) continue;
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    lines.forEach(fold);
    if (result.ended === 'failed') break;
  }
  buffer += decoder.decode();
  if (whole) readWhole(buffer, result, onText);
  else if (result.ended !== 'failed') fold(buffer); // a last event with no newline after it
  result.text = result.text.trim();
  return result;
}

/** An error body's code, message and param ({"error": {...}}, or {"detail": "..."} before the stream opens). */
export function responsesError(body: string): { code: string; message: string; param?: string } {
  try {
    const parsed = JSON.parse(body);
    const e = parsed?.error;
    if (e && typeof e === 'object') return { code: String(e.code ?? ''), message: String(e.message ?? '').slice(0, 300), param: e.param ?? undefined };
    if (typeof parsed?.detail === 'string') return { code: '', message: parsed.detail.slice(0, 300) };
  } catch { /* not JSON */ }
  return { code: '', message: body.slice(0, 300) };
}
