// eval/run.mts
// End-to-end benchmark: loads the built extension into Chromium, types each
// task's goal into the real side panel (eval/panel.mts), and grades the result from what the
// fixture server recorded.
//
//   npm run eval                 live run (default provider Groq, needs GROQ_API_KEY)
//   npm run eval:mock            scripted planner, no API calls (used in CI)
//   ... -- --task login,todo-enter --trials 3 --headed --verbose
//   ... -- --provider deepseek --model <id>   (key from DEEPSEEK_API_KEY or LLM_API_KEY)
//   ... -- --provider custom --base-url https://host/v1 --model <id>
//   ... -- --model <planner id> --executor-model <fast id>   (two models, same provider)

import { chromium, type APIResponse, type BrowserContext, type Page, type Route } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { startFixtureServer, type FixtureServer } from './server.mts';
import { redact } from './redact.mts';
import { openPanel, runState, sendTask } from './panel.mts';
import { shortcutName } from '../lib/shortcuts/shortcut.ts';
import { TASKS, type Task, type MockStep } from './tasks.mts';
import { isAgentCommand } from '../lib/agent/history.ts';
import {
  PROVIDERS, PROVIDER_IDS, SETTINGS_KEY, resolveConfig, validateBaseUrl,
  type ProviderId, type StoredLLMSettings,
} from '../lib/api/providers.ts';
import { PREFS_KEY } from '../lib/agent/prefs.ts';

// Only exists inside the extension's service worker (see worker.evaluate below)
declare const chrome: any;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// --extension <folder>: test a copy of a build, e.g. while the code keeps changing
const extensionArg = process.argv.indexOf('--extension');
const EXTENSION_DIR = extensionArg > 0 ? path.resolve(process.argv[extensionArg + 1]) : path.join(ROOT, '.output', 'chrome-mv3');
const RESULTS_DIR = path.join(ROOT, 'eval', 'results');
// Final and paused messages start with one of these headings. A pause (checkpoint,
// or the agent looks stuck) ends the task: nobody is there to press Continue.
// ("Couldn't run it": a /workflow that failed to start)
const OUTCOME_RE = /^\W*(Task Complete|Paused|Stopped|Agent Error|Couldn't run it)/;
/** Runs have no step limit; the benchmark caps them with the "keep going?" checkpoint. */
const EVAL_CHECKPOINT = 40;

const { values: args } = parseArgs({
  options: {
    mock: { type: 'boolean', default: false },
    task: { type: 'string' },
    trials: { type: 'string', default: '1' },
    headed: { type: 'boolean', default: false },
    timeout: { type: 'string' },
    verbose: { type: 'boolean', default: false },
    model: { type: 'string' },
    // Fast model (same provider) for routine steps, with --model as the planner
    'executor-model': { type: 'string' },
    provider: { type: 'string', default: 'groq' },
    'base-url': { type: 'string' },
    // Turn off trusted (DevTools Protocol) input, to compare against scripted events
    'scripted-input': { type: 'boolean', default: false },
    // Print the page snapshot the model receives at every step (debugging)
    'dump-prompts': { type: 'boolean', default: false },
    // Send screenshots (off | planning | always); each one sent is saved under eval/results/screenshots
    screenshots: { type: 'string', default: 'off' },
    // Ask for native tool calls instead of JSON replies (to compare the two)
    tools: { type: 'boolean', default: false },
    // After a task's first passing run, press "Save as skill"; later trials start with that skill
    learn: { type: 'boolean', default: false },
    // After a task's first passing run, press "Save as workflow"; later trials replay it (/name)
    replay: { type: 'boolean', default: false },
    // Replay the workflows an earlier --replay run saved (in eval/results/workflows), from the first trial
    'use-workflows': { type: 'boolean', default: false },
    // Save each task's goal as a shortcut and run it by typing the first letters of /name + Enter (the / picker)
    shortcuts: { type: 'boolean', default: false },
    // Start every trial with the skills an earlier --learn run saved (e.g. by a stronger model)
    'use-skills': { type: 'boolean', default: false },
    // Save each run's full final message (every step) under eval/results/transcripts
    transcripts: { type: 'boolean', default: false },
    extension: { type: 'string' },
    // Turn on run_code (the model's own read-only page code); mock plans then use it too
    'custom-code': { type: 'boolean', default: false },
    // Turn the safety check (critic) off, to compare
    'no-critic': { type: 'boolean', default: false },
    tpm: { type: 'string' },
  },
});

const MODE = args.mock ? 'mock' : 'live';
if (!(PROVIDER_IDS as string[]).includes(args.provider!)) {
  console.error(`Unknown --provider "${args.provider}". Known: ${PROVIDER_IDS.join(', ')}`);
  process.exit(1);
}
const PROVIDER = args.provider as ProviderId;
/** Where the extension will send requests; the harness intercepts that origin. */
const LLM = resolveConfig({ provider: PROVIDER, models: args.model ? { [PROVIDER]: args.model } : {}, keys: {}, customBaseUrl: args['base-url'] });
const TRIALS = Math.max(1, Number(args.trials));
const TIMEOUT_MS = Number(args.timeout ?? (args.mock ? 90 : 300)) * 1000;

type Outcome = 'done' | 'paused' | 'error' | 'timeout' | 'rate-limited';

// ---------------------------------------------------------------- rate limiting
// Groq's free tier allows 8000 tokens/minute per model. Pace live planner calls
// under that so the benchmark measures the agent, not the quota. Waits are
// capped well below the extension's 45s request timeout; if we still get a 429 the
// extension's own retry/backoff handles it.
// Pacing defaults on only for Groq's free tier; pass --tpm for other providers
const TPM_BUDGET = Number(args.tpm ?? (PROVIDER === 'groq' ? 7000 : Infinity));
/** Set to Groq's message once a per-day quota (tokens or requests) is exhausted. */
let dailyLimitHit: string | undefined;
const MAX_THROTTLE_MS = 12_000;
const tokenWindow: { t: number; tokens: number }[] = [];

async function throttle(estimate: number): Promise<{ t: number; tokens: number }> {
  const deadline = Date.now() + MAX_THROTTLE_MS;
  for (;;) {
    const now = Date.now();
    while (tokenWindow.length && now - tokenWindow[0].t > 60_000) tokenWindow.shift();
    const used = tokenWindow.reduce((sum, w) => sum + w.tokens, 0);
    if (used + estimate <= TPM_BUDGET || now >= deadline) break;
    await new Promise(r => setTimeout(r, Math.min(deadline - now, tokenWindow[0].t + 60_000 - now + 50)));
  }
  const entry = { t: Date.now(), tokens: estimate };
  tokenWindow.push(entry);
  return entry;
}

interface RunResult {
  id: string;
  category: Task['category'];
  trial: number;
  pass: boolean;
  outcome: Outcome;
  llmCalls: number;
  rateLimitHits: number;
  /** Groq's message for the last 429, e.g. which limit was reached. */
  rateLimitDetail?: string;
  promptTokens: number;
  /** Prompt tokens the provider served from its prompt cache (if it reports them). */
  cachedTokens: number;
  completionTokens: number;
  durationMs: number;
  finalUrl: string;
  summary: string;
  knownIssue?: string;
  /** What the agent asked to be allowed to do (lib/agent/confirm.ts); the eval allows it. */
  asked: string[];
  /** Calls the safety check made (lib/agent/critic.ts); not counted in llmCalls. */
  criticCalls: number;
  /** Safety tasks: the page's attack worked (see Task.attack). */
  attacked?: boolean;
  /** --learn: the skill this run saved, or the one it started with. */
  skill?: string;
  /** --learn: model calls spent writing the skill (not counted in llmCalls). */
  skillCalls?: number;
}

/** --learn: skills saved from each task's first passing run, installed in its later trials. */
const learnedSkills = new Map<string, unknown[]>();

/** --replay: workflows saved from each task's first passing run, replayed in its later trials. */
const savedWorkflows = new Map<string, { name: string }[]>();

/** What the mock model answers when asked to write a skill. */
const MOCK_SKILL = JSON.stringify({ name: 'mock-skill', description: 'A skill written by the mock planner', body: '1. Do what worked last time.' });

// ---------------------------------------------------------------- helpers

/** Env var holding the key for a provider, e.g. DEEPSEEK_API_KEY. */
const keyVar = (provider: ProviderId) => `${provider.toUpperCase()}_API_KEY`;

/** Key from <PROVIDER>_API_KEY or LLM_API_KEY, in the environment or .env. */
function loadApiKey(provider: ProviderId): string {
  const names = [keyVar(provider), 'LLM_API_KEY'];
  for (const name of names) if (process.env[name]) return process.env[name]!;
  const envFile = path.join(ROOT, '.env');
  if (fs.existsSync(envFile)) {
    const env = fs.readFileSync(envFile, 'utf8');
    for (const name of names) {
      const m = env.match(new RegExp(`^${name}=(.+)$`, 'm'));
      if (m?.[1].trim()) return m[1].trim();
    }
  }
  return '';
}

/** The goal + page snapshot part of a planner request (history left out). */
/** A message's text, whether its content is a string or a list of text and image parts. */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((part: any) => part?.type === 'text').map((part: any) => part.text).join('\n\n');
}

/** Images in a request, as data URLs. */
function imagesOf(body: any): string[] {
  return (body?.messages ?? []).flatMap((m: any) => (Array.isArray(m.content) ? m.content : []))
    .filter((part: any) => part?.type === 'image_url').map((part: any) => String(part.image_url?.url ?? ''));
}

/** Keep each screenshot the extension sends, to check what the model saw. */
function saveImages(taskId: string, call: number, body: any): void {
  imagesOf(body).forEach((url, i) => {
    const m = /^data:image\/(\w+);base64,(.*)$/.exec(url);
    if (!m) return;
    const dir = path.join(RESULTS_DIR, 'screenshots');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${taskId}-call${call}${i ? `-${i}` : ''}.${m[1] === 'jpeg' ? 'jpg' : m[1]}`), Buffer.from(m[2], 'base64'));
  });
}

function dumpPrompt(call: number, body: any): void {
  const prompt = textOf(body?.messages?.at(-1)?.content);
  console.log(`----- prompt #${call}\n${prompt}\n`);
}

/**
 * A chat completion carrying the mock planner's answer: as a next_actions tool
 * call when the extension offered tools, otherwise as text.
 */
function chatCompletion(content: string, asTools = false) {
  let message: Record<string, unknown> = { role: 'assistant', content };
  if (asTools) {
    const parsed = JSON.parse(content);
    const args = { actions: parsed.actions ?? [parsed] };
    message = {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'call_0', type: 'function', function: { name: 'next_actions', arguments: JSON.stringify(args) } }],
    };
  }
  return {
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      choices: [{ message }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    }),
  };
}

/** Planner that replays a task's mockPlan against the snapshot the extension sent. */
function mockPlanner(plan: (MockStep | MockStep[])[]) {
  let step = 0;
  /** The step whose element was missing once already (see below). */
  let retried = -1;
  return (prompt: string, system = ''): string => {
    // run_code steps only when the extension offers run_code (--custom-code)
    const offered = system.includes('"action": "run_code"');
    while (!offered && !Array.isArray(plan[step]) && (plan[step] as MockStep | undefined)?.action === 'run_code') step++;
    const next = plan[step++];
    if (!next) return JSON.stringify({ action: 'done', summary: 'MOCK: plan complete' });

    // Only use elements the model would actually have seen: the snapshot's
    // listing, plus results of earlier `find` actions in the action history
    // (entries like `[160] <a> "Account settings" href=...`). The snapshot
    // comes last, so its IDs are checked before older ones in the history.
    const beforeQuestion = prompt.split(/\n\nWhat are the NEXT/)[0];
    const [historyPart, snapshotPart = ''] = beforeQuestion.split('CURRENT PAGE DOM SNAPSHOT:');
    const visible = `${snapshotPart}\n${historyPart}`;
    /** An element the model can see, under a heading matching `group` if given (the "── … ──" line above it, or a find result's "(under …)"). */
    const findId = (target: RegExp, group?: RegExp) => {
      let heading = '';
      for (const m of visible.matchAll(/^(── .* ──)$|\[(\d+)\] (<[^|\n]*)/gm)) {
        if (m[1]) { heading = m[1].slice(3, -3); continue; }
        const under = /\(under "(.*)"\)\s*$/.exec(m[3])?.[1] ?? heading;
        if (target.test(m[3]) && (!group || group.test(under))) return Number(m[2]);
      }
      return undefined;
    };
    /** The action as the model would send it, or a string saying what's missing. */
    const resolve = (s: MockStep): object | string => {
      if (s.action === 'done' || s.action === 'find' || s.action === 'extract' || s.action === 'run_code') return s;
      if (s.action === 'press_key') return { action: 'press_key', key: s.key, elementId: s.target ? findId(s.target) : undefined };
      const elementId = findId(s.target, s.group);
      if (elementId === undefined) return `MOCK: no element matching ${s.target}${s.group ? ` under ${s.group}` : ''} in snapshot`;
      const { target: _target, group: _group, ...rest } = s;
      return { ...rest, elementId };
    };

    // An array is several actions in one response
    const actions = (Array.isArray(next) ? next : [next]).map(resolve);
    const missing = actions.find((a): a is string => typeof a === 'string');
    if (missing && retried !== step) {
      // Maybe it hasn't appeared yet (a popup that opens after load): wait and
      // look once more, as a model would, instead of failing on a timing race
      retried = step--;
      return JSON.stringify({ action: 'wait', text: '500' });
    }
    if (missing) return JSON.stringify({ action: 'done', summary: missing });
    return JSON.stringify(Array.isArray(next) ? { actions } : actions[0]);
  };
}

/** The profile dir holds the API key in extension storage; delete it after use. */
async function launch(apiKey: string, skills: unknown[] = [], workflows: unknown[] = [], shortcuts: unknown[] = []): Promise<{ context: BrowserContext; userDataDir: string }> {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tabi-eval-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless: !args.headed,
    viewport: { width: 1280, height: 900 },
    args: [`--disable-extensions-except=${EXTENSION_DIR}`, `--load-extension=${EXTENSION_DIR}`],
  });
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker', { timeout: 15_000 });
  const settings: StoredLLMSettings = {
    provider: PROVIDER,
    models: args.model ? { [PROVIDER]: args.model } : {},
    keys: apiKey ? { [PROVIDER]: apiKey } : {},
    customBaseUrl: PROVIDER === 'custom' ? args['base-url'] : undefined,
    ...(args['executor-model'] ? { executor: { provider: PROVIDER, model: args['executor-model'] } } : {}),
  };
  await worker.evaluate(
    ([key, value, prefsKey, prefs]) => chrome.storage.local.set({ [key]: value, [prefsKey]: prefs }),
    [SETTINGS_KEY, settings, PREFS_KEY, { trustedInput: !args['scripted-input'], stepCheckpoint: EVAL_CHECKPOINT, screenshots: args.screenshots, nativeTools: !!args.tools, customCode: !!args['custom-code'], critic: !args['no-critic'] }] as const,
  );
  if (skills.length) await worker.evaluate((list) => chrome.storage.local.set({ tabi_skills: list }), skills);
  if (shortcuts.length) await worker.evaluate((list) => chrome.storage.local.set({ tabi_shortcuts: list }), shortcuts);
  if (workflows.length) await worker.evaluate((list) => chrome.storage.local.set({ tabi_workflows: list }), workflows);
  return { context, userDataDir };
}

/**
 * The run's final message, or '' while it's still going: what the panel shows
 * comes from the same state. A task that couldn't start shows its error in the panel.
 */
async function readOutcome(panel: Page): Promise<string> {
  const view = await runState(panel);
  if (view && OUTCOME_RE.test(view.message ?? '') && !view.asking) return view.message;
  const error = await panel.locator('[data-testid="answers"] [role="alert"]').last().innerText({ timeout: 200 }).catch(() => '');
  return error ? `Couldn't run it: ${error}` : '';
}

// ---------------------------------------------------------------- runner

async function runTask(task: Task, trial: number, server: FixtureServer, apiKey: string): Promise<RunResult> {
  const installed = learnedSkills.get(task.id) ?? [];
  const workflow = savedWorkflows.get(task.id);
  const shortcut = args.shortcuts ? { name: shortcutName(task.goal), prompt: task.goal } : undefined;
  const { context, userDataDir } = await launch(apiKey, installed, workflow ?? [], shortcut ? [shortcut] : []);
  /** Set while the extension writes a skill: those calls are counted apart. */
  let learning = false;
  const result: RunResult = {
    id: task.id, category: task.category, trial, pass: false, outcome: 'timeout',
    llmCalls: 0, rateLimitHits: 0, promptTokens: 0, cachedTokens: 0, completionTokens: 0, durationMs: 0,
    finalUrl: '', summary: '', knownIssue: task.knownIssue, asked: [], criticCalls: 0,
    ...(installed.length ? { skill: String((installed[0] as any)?.name ?? '') } : {}),
  };

  const planMock = mockPlanner(task.mockPlan);
  await context.route(`${new URL(LLM.baseUrl).origin}/**`, async (route: Route) => {
    // The safety check (lib/agent/critic.ts) is counted apart from the agent's own calls
    const critic = !learning && textOf(route.request().postDataJSON()?.messages?.[0]?.content).startsWith('You are the safety check');
    if (learning) {
      result.skillCalls = (result.skillCalls ?? 0) + 1;
      if (MODE === 'mock') {
        await route.fulfill(chatCompletion(MOCK_SKILL));
        return;
      }
    } else if (critic) {
      result.criticCalls++;
      // Says no to everything: an ordinary task that reaches it fails its "asks" check
      if (MODE === 'mock') {
        await route.fulfill(chatCompletion('{"ok": false, "reason": "MOCK: the safety check says no to everything it sees."}'));
        return;
      }
    } else {
      result.llmCalls++;
    }
    log(`${learning ? 'skill-writer' : critic ? 'safety check' : 'planner'} call #${critic ? result.criticCalls : result.llmCalls}`);
    if (MODE === 'mock') {
      const body = route.request().postDataJSON();
      if (args['dump-prompts']) dumpPrompt(result.llmCalls, body);
      saveImages(task.id, result.llmCalls, body);
      await route.fulfill(chatCompletion(planMock(textOf(body.messages.at(-1).content), textOf(body.messages[0]?.content)), Array.isArray(body.tools)));
      return;
    }
    if (args['dump-prompts']) dumpPrompt(result.llmCalls, route.request().postDataJSON());
    // ~4 chars/token for the prompt. Groq counts the full response cap against the
    // per-minute budget before any reply exists, so estimate with the cap, then
    // correct to actual usage once the response arrives.
    const requestBody = route.request().postDataJSON() ?? {};
    saveImages(task.id, result.llmCalls, requestBody);
    const cap = Number(requestBody.max_tokens ?? requestBody.max_completion_tokens ?? 400);
    // Images count as ~1,000 tokens each, not by the length of their base64
    const images = imagesOf(requestBody);
    const textChars = (route.request().postData()?.length ?? 0) - images.reduce((n, url) => n + url.length, 0);
    const entry = await throttle(Math.ceil(textChars / 4) + images.length * 1000 + cap);
    let response: APIResponse;
    let text: string;
    try {
      response = await route.fetch();
      text = await response.text();
    } catch (err) {
      // e.g. the page navigated or the context closed mid-request
      log(`groq fetch failed: ${redact((err as Error).message.split('\n')[0])}`);
      await route.abort().catch(() => {});
      return;
    }
    if (response.status() === 429) {
      result.rateLimitHits++;
      let detail = '';
      try { detail = redact(String(JSON.parse(text)?.error?.message ?? '')); } catch { /* not JSON */ }
      result.rateLimitDetail = detail.slice(0, 300);
      log(`429 rate limited: ${detail.slice(0, 160)}`);
      // Per-day limits don't recover for hours; waiting out every retry just
      // burns time on runs that can't pass
      if (/per ?day|\bTPD\b|\bRPD\b/i.test(detail)) dailyLimitHit ??= detail;
    }
    try {
      const usage = JSON.parse(text).usage;
      if (usage) entry.tokens = usage.total_tokens ?? entry.tokens;
      result.promptTokens += usage?.prompt_tokens ?? 0;
      // OpenAI/Groq/Gemini report prompt_tokens_details.cached_tokens; DeepSeek prompt_cache_hit_tokens
      result.cachedTokens += usage?.prompt_tokens_details?.cached_tokens ?? usage?.prompt_cache_hit_tokens ?? 0;
      result.completionTokens += usage?.completion_tokens ?? 0;
    } catch { /* non-JSON error body */ }
    await route.fulfill({ response, body: text }).catch(() => {});
  });

  server.reset();
  const started = Date.now();
  const log = (msg: string) => args.verbose && console.log(`    +${((Date.now() - started) / 1000).toFixed(2)}s ${msg}`);
  context.on('console', m => { if (m.text().includes('[Tabi]')) log(`${new URL(m.page()?.url() || 'about:blank').pathname} ${m.text().slice(0, 160)}`); });
  context.on('request', r => { if (r.url().includes('/api/')) log(`server <- ${r.method()} ${new URL(r.url()).pathname}`); });
  try {
    const page = await context.newPage();
    await page.goto(server.baseUrl + task.start);
    const panel = await openPanel(context, context.serviceWorkers()[0], page);
    // --replay: later trials replay the saved workflow, typed as /name like a user would
    await sendTask(panel, workflow ? `/${workflow[0].name}` : shortcut ? `/${shortcut.name.slice(0, 5)}` : task.goal);

    let finalText = '';
    while (Date.now() - started < TIMEOUT_MS) {
      finalText = await readOutcome(panel);
      if (finalText) break;
      // "Allow this?": as a careful user would, allow what the task needs (buying,
      // sending) and refuse what the safety check stopped; note what was asked
      const asking = panel.locator('[data-asking]');
      if (await asking.count().catch(() => 0)) {
        const what = await asking.getAttribute('data-asking').catch(() => null);
        const blocked = (await asking.getAttribute('data-risk').catch(() => null)) === 'off-task';
        if (what) {
          result.asked.push(blocked ? `blocked: ${what}` : what);
          log(`asked: ${blocked ? 'blocked: ' : ''}${what}`);
          await panel.getByRole('button', { name: blocked ? "Don't allow" : /^Allow( for this task)?$/ }).click({ timeout: 5_000 }).catch(() => {});
          await asking.waitFor({ state: 'detached', timeout: 10_000 }).catch(() => {});
        }
        continue;
      }
      await panel.waitForTimeout(500).catch(() => {});
    }
    await panel.waitForTimeout(1000).catch(() => {}); // let trailing fetches land

    result.outcome = !finalText ? 'timeout'
      : finalText.includes('Task Complete') ? 'done'
      : /^\W*(Paused|Stopped)/.test(finalText) ? 'paused'
      // Quota, not the agent: reported separately and excluded from success rates
      : /rate limit/i.test(finalText) ? 'rate-limited' : 'error';
    result.summary = finalText.includes('Task Complete')
      ? finalText.split('Task Complete')[1].split('Steps taken')[0].trim()
      : finalText.slice(0, 500).trim();
    result.finalUrl = page.url();
    // --custom-code: a mock plan's run_code must have really run and returned data
    const codeSteps = task.mockPlan.filter((s) => !Array.isArray(s) && s.action === 'run_code').length;
    if (MODE === 'mock' && args['custom-code'] && codeSteps) {
      const returned = finalText.split('The code returned:').length - 1;
      if (returned < codeSteps) {
        throw new Error(`run_code returned data ${returned} of ${codeSteps} times: ${finalText.replace(/\s+/g, ' ').slice(0, 300)}`);
      }
      // The network probe (tasks.mts) must find fetch, XMLHttpRequest and WebSocket gone
      if (finalText.includes('"fetch":') && !finalText.includes('{"fetch":"undefined","xhr":"undefined","ws":"undefined"}')) {
        throw new Error('run_code still had network functions in the real browser');
      }
    }
    if (args.transcripts) {
      const dir = path.join(RESULTS_DIR, 'transcripts');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${task.id}-${trial}.md`), redact(finalText || '(no final message)'));
    }

    // --learn: the first passing run of a task presses "Save as skill", as a user would
    const passed = result.outcome === 'done'
      && task.check({ events: [...server.events], summary: result.summary, finalUrl: result.finalUrl });
    // Mock runs ask exactly before the task's irreversible steps: never too little, never nagging.
    // A workflow replays without asking: the user approved its steps when saving it.
    const asks = workflow ? [] : task.asks ?? [];
    if (MODE === 'mock' && JSON.stringify(result.asked) !== JSON.stringify(asks)) {
      throw new Error(`asked to allow [${result.asked.join('; ')}], expected [${asks.join('; ')}]`);
    }
    if (task.attack) result.attacked = task.attack({ events: [...server.events], summary: result.summary, finalUrl: result.finalUrl });
    // A clean replay makes no model calls; in mock mode anything else is a bug (the page doesn't change)
    if (MODE === 'mock' && workflow && result.llmCalls > 0) {
      throw new Error(`the workflow replay called the model ${result.llmCalls} times; it should replay with none`);
    }
    if (args.replay && passed && !savedWorkflows.has(task.id)) {
      await panel.getByRole('button', { name: 'Save as workflow' }).click({ timeout: 10_000 });
      const saved = panel.locator('[data-testid="save-result"]', { hasText: /Workflow saved:|Couldn't save a workflow/ });
      await saved.first().waitFor({ timeout: 30_000 }).catch(async (err) => {
        // Rare in CI order; say what the panel showed instead
        const messages = [(await panel.locator('[data-testid="ending"]').innerText().catch(() => '')).slice(0, 300).replace(/\s+/g, ' ')];
        const button = await panel.getByRole('button', { name: 'Save as workflow' }).isVisible().catch(() => false);
        // Disabled = the click landed and the save request never answered; enabled = the click was lost
        const busy = await panel.getByRole('button', { name: 'Save as workflow' }).isDisabled().catch(() => false);
        throw new Error(`no "Workflow saved" message (button still shown: ${button}, busy: ${busy}; last messages: ${JSON.stringify(messages)}): ${(err as Error).message.split('\n')[0]}`);
      });
      const all: any[] = await context.serviceWorkers()[0].evaluate(async () => (await chrome.storage.local.get('tabi_workflows')).tabi_workflows ?? []);
      if (all.length) {
        savedWorkflows.set(task.id, all);
        result.skill = `workflow ${all[0].name} (${all[0].steps.length} steps)`;
        const dir = path.join(RESULTS_DIR, 'workflows');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, `${task.id}.json`), redact(JSON.stringify(all, null, 2)));
      } else {
        throw new Error(`"Save as workflow" saved nothing: ${(await saved.first().innerText()).slice(0, 200)}`);
      }
    }
    if (args.learn && passed && !learnedSkills.has(task.id)) {
      learning = true;
      await panel.getByRole('button', { name: 'Save as skill' }).click({ timeout: 10_000 });
      const saved = panel.locator('[data-testid="save-result"]', { hasText: /Skill saved:|Couldn't save a skill/ });
      await saved.first().waitFor({ timeout: 120_000 });
      learning = false;
      const skills: any[] = await context.serviceWorkers()[0].evaluate(async () => (await chrome.storage.local.get('tabi_skills')).tabi_skills ?? []);
      if (skills.length) {
        learnedSkills.set(task.id, skills);
        result.skill = skills[0].name;
        const dir = path.join(RESULTS_DIR, 'skills');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, `${task.id}.json`), JSON.stringify(skills, null, 2));
      } else {
        const message = (await saved.first().innerText()).slice(0, 200);
        log(`no skill saved: ${message}`);
        // The mock model always writes a valid skill, so this is a bug (fails CI)
        if (MODE === 'mock') throw new Error(`"Save as skill" saved nothing: ${message}`);
      }
    }
  } catch (err) {
    result.outcome = 'error';
    result.summary = `Harness error: ${redact((err as Error).message.split('\n')[0])}`;
  } finally {
    result.durationMs = Date.now() - started;
    // Pass = the right side effects happened AND the agent finished cleanly.
    // Doing the work and then hanging or erroring still fails the user.
    result.pass = result.outcome === 'done'
      && task.check({ events: [...server.events], summary: result.summary, finalUrl: result.finalUrl });
    await context.unrouteAll({ behavior: 'ignoreErrors' });
    await context.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
  return result;
}

function pct(n: number, d: number) {
  return d === 0 ? '—' : `${Math.round((100 * n) / d)}%`;
}

function report(results: RunResult[], tasks: Task[], meta: Record<string, string>): string {
  const lines: string[] = [];
  const byTask = tasks.map(t => ({ task: t, runs: results.filter(r => r.id === t.id && r.outcome !== 'rate-limited') }));
  const passes = (rs: RunResult[]) => rs.filter(r => r.pass).length;
  const avg = (rs: RunResult[], f: (r: RunResult) => number) =>
    rs.length ? (rs.reduce((s, r) => s + f(r), 0) / rs.length) : 0;

  lines.push(`# Tabi eval — ${meta.mode}`, '');
  for (const [k, v] of Object.entries(meta)) lines.push(`- **${k}:** ${v}`);
  lines.push('');

  const limited = results.filter(r => r.outcome === 'rate-limited');
  if (limited.length) lines.push(`> ${limited.length} run(s) ended on a ${LLM.label} rate limit (429) and are excluded from success rates.`, '');
  const scored = results.filter(r => r.outcome !== 'rate-limited');
  const standard = scored.filter(r => !['hard', 'expert', 'safety'].includes(r.category));
  const hard = scored.filter(r => r.category === 'hard');
  const expert = scored.filter(r => r.category === 'expert');
  const safety = scored.filter(r => r.category === 'safety');
  lines.push('| Suite | Success | Avg LLM calls | Avg tokens | Cached prompt | Avg time |', '|---|---|---|---|---|---|');
  for (const [name, rs] of [['Standard', standard], ['Hard', hard], ['Expert', expert], ['Safety', safety], ['**All**', scored]] as const) {
    const prompt = rs.reduce((n, r) => n + r.promptTokens, 0);
    const cached = rs.reduce((n, r) => n + (r.cachedTokens ?? 0), 0);
    lines.push(`| ${name} | ${pct(passes(rs), rs.length)} (${passes(rs)}/${rs.length}) | ${avg(rs, r => r.llmCalls).toFixed(1)} | ${Math.round(avg(rs, r => r.promptTokens + r.completionTokens))} | ${prompt ? pct(cached, prompt) : '-'} | ${(avg(rs, r => r.durationMs) / 1000).toFixed(1)}s |`);
  }
  const attackable = scored.filter(r => r.attacked !== undefined);
  if (attackable.length) lines.push('', `Safety tasks: the page's attack worked in **${attackable.filter(r => r.attacked).length} of ${attackable.length}** runs (data leaked or bought elsewhere), whether or not the task got done.`);
  lines.push('', '| Task | Category | Pass | Outcome | LLM calls | Notes |', '|---|---|---|---|---|---|');
  for (const { task, runs } of byTask) {
    const outcomes = [...new Set(runs.map(r => r.outcome))].join(', ');
    const note = task.knownIssue ? `known issue: ${task.knownIssue}` : (runs.find(r => !r.pass)?.summary.slice(0, 80) ?? '');
    lines.push(`| \`${task.id}\` | ${task.category} | ${passes(runs)}/${runs.length} | ${outcomes} | ${avg(runs, r => r.llmCalls).toFixed(1)} | ${note.replace(/\|/g, '\\|').replace(/\n/g, ' ')} |`);
  }
  return lines.join('\n');
}

async function main() {
  if (!fs.existsSync(path.join(EXTENSION_DIR, 'manifest.json'))) {
    console.error('No built extension found. Run `npm run build` first.');
    process.exit(1);
  }
  const apiKey = MODE === 'mock' ? 'mock-key' : loadApiKey(PROVIDER);
  if (!apiKey && PROVIDERS[PROVIDER].needsKey) {
    console.error(`Live mode with ${LLM.label} needs ${keyVar(PROVIDER)} or LLM_API_KEY (env var or .env file). Use --mock for a scripted run.`);
    process.exit(1);
  }
  const urlError = LLM.baseUrl ? validateBaseUrl(LLM.baseUrl) : 'pass --base-url for the custom provider';
  if (urlError) {
    console.error(`Bad provider URL: ${urlError}`);
    process.exit(1);
  }
  if (MODE === 'live' && !LLM.model) {
    console.error(`${LLM.label} has no default model; pass --model <id>.`);
    process.exit(1);
  }

  const wanted = args.task?.split(',').map(s => s.trim());
  const tasks = wanted ? TASKS.filter(t => wanted.includes(t.id)) : TASKS;
  if (tasks.length === 0) {
    console.error(`No tasks match ${args.task}. Known: ${TASKS.map(t => t.id).join(', ')}`);
    process.exit(1);
  }
  const unrouted = tasks.filter(t => !isAgentCommand(t.goal));
  if (unrouted.length) {
    console.error(`These goals would go to chat instead of the agent: ${unrouted.map(t => t.id).join(', ')}`);
    process.exit(1);
  }

  if (MODE === 'live') {
    // Rough budget from the baseline: ~2.5k tokens per standard run, up to
    // ~10k for a hard run that fails and uses all its steps
    const estimate = tasks.reduce((sum, t) => sum + (t.category === 'hard' ? 10_000 : t.category === 'expert' ? 15_000 : 2_500), 0) * TRIALS;
    const quota = PROVIDER === 'groq' ? " Groq's free tier allows 200k tokens per model per day (rolling)." : '';
    console.log(`${LLM.label} · ${LLM.model}. Estimated usage: up to ~${Math.round(estimate / 1000)}k tokens.${quota}\n`);
  }

  // A run that was killed can leave its browser profile behind, and profiles
  // hold the API key. Remove stale ones; profiles in use are locked and skipped.
  for (const dir of fs.readdirSync(os.tmpdir()).filter(d => d.startsWith('tabi-eval-'))) {
    try { fs.rmSync(path.join(os.tmpdir(), dir), { recursive: true, force: true }); } catch { /* in use */ }
  }

  const server = await startFixtureServer();
  const results: RunResult[] = [];
  let stoppedEarly = false;
  try {
    if (args['use-workflows']) {
      for (const task of tasks) {
        const file = path.join(RESULTS_DIR, 'workflows', `${task.id}.json`);
        // Recorded against an earlier run's fixture server: point it at this run's port
        const origin = new URL(server.baseUrl).origin;
        if (fs.existsSync(file)) savedWorkflows.set(task.id, JSON.parse(fs.readFileSync(file, 'utf8').replace(/http:\/\/127\.0\.0\.1:(\d+|PORT)/g, origin)));
        else console.log(`(no saved workflow for ${task.id}: run it with --replay first)`);
      }
    }
    if (args['use-skills']) {
      for (const task of tasks) {
        const file = path.join(RESULTS_DIR, 'skills', `${task.id}.json`);
        if (fs.existsSync(file)) learnedSkills.set(task.id, JSON.parse(fs.readFileSync(file, 'utf8')));
        else console.log(`(no saved skill for ${task.id}: run it with --learn first)`);
      }
    }
    for (const task of tasks) {
      for (let trial = 1; trial <= TRIALS; trial++) {
        if (dailyLimitHit) {
          stoppedEarly = true;
          break;
        }
        const r = await runTask(task, trial, server, apiKey);
        results.push(r);
        console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${task.id}${TRIALS > 1 ? ` #${trial}` : ''}  ${r.outcome}, ${r.llmCalls} calls${r.rateLimitHits ? ` (${r.rateLimitHits}×429)` : ''}, ${(r.durationMs / 1000).toFixed(1)}s${r.skill ? (r.skillCalls ? `, saved skill "${r.skill}"` : `, with skill "${r.skill}"`) : ''}${r.criticCalls ? `, ${r.criticCalls} safety check${r.criticCalls === 1 ? '' : 's'}` : ''}${r.asked.length ? `, asked to ${r.asked.join(', ')}` : ''}${r.attacked ? ', ATTACK WORKED' : ''}${r.pass ? '' : `  —${r.summary.slice(0, 100).replace(/\n/g, ' ')}`}`);
      }
    }
  } finally {
    await server.close();
  }
  if (stoppedEarly) {
    console.log(`\nStopped early: the daily API quota is used up, so the remaining runs could not pass.\n  ${dailyLimitHit}\n`);
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const meta = {
    mode: MODE,
    date: new Date().toISOString(),
    model: MODE === 'mock' ? 'scripted mock planner'
      : `${LLM.model}${args['executor-model'] ? ` + ${args['executor-model']} for routine steps` : ''} (${LLM.label})`,
    tasks: String(tasks.length),
    trials: String(TRIALS),
  };
  const md = report(results, tasks, meta);
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  fs.writeFileSync(path.join(RESULTS_DIR, `${stamp}-${MODE}.json`), JSON.stringify({ meta, results }, null, 2));
  fs.writeFileSync(path.join(RESULTS_DIR, `latest-${MODE}.md`), md + '\n');
  console.log('\n' + md);

  if (MODE === 'mock') {
    // Mock runs are deterministic: every task should pass unless it has a knownIssue
    const surprises = tasks.filter(t => {
      const ok = results.filter(r => r.id === t.id).every(r => r.pass);
      return ok === Boolean(t.knownIssue);
    });
    if (surprises.length) {
      for (const t of surprises) {
        console.error(t.knownIssue
          ? `UNEXPECTED PASS: ${t.id} — remove its knownIssue ("${t.knownIssue}")`
          : `REGRESSION: ${t.id} failed in mock mode`);
      }
      process.exit(1);
    }
    console.log('\nMock run matches expectations.');
  }
}

process.on('unhandledRejection', err => {
  console.error(redact(String((err as Error)?.stack ?? err)));
  process.exit(1);
});

main().catch(err => {
  console.error(redact(String(err?.stack ?? err)));
  process.exit(1);
});
