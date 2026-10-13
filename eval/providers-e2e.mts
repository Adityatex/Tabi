// End-to-end check of backup providers. Groq is the main provider and
// OpenRouter the backup, both answered by the test. Groq takes the first step
// of a task, then hits its rate limit: OpenRouter carries on from where it
// stopped (the steps so far are in its prompt) and finishes, and the panel's
// model button says a backup took over. The next task goes straight to the
// backup while Groq rests. When the backup's key is refused too, the task
// stops with a message saying why, instead of hanging. No real model or key.
//
//   npm run build && npm run eval:providers   (-- --headed to watch)

import { chromium, type Route } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFixtureServer } from './server.mts';
import { openPanel, runState, sendTask } from './panel.mts';

declare const chrome: any;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXTENSION_DIR = path.join(ROOT, '.output', 'chrome-mv3');
const headed = process.argv.includes('--headed');

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `  — ${detail}`}`);
  if (!ok) failures++;
}

const reply = (content: string) => ({ status: 200, contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }) });
const promptOf = (route: Route) => (route.request().postDataJSON()?.messages ?? [])
  .map((m: any) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n');

async function main(): Promise<void> {
  if (!fs.existsSync(path.join(EXTENSION_DIR, 'manifest.json'))) throw new Error('Build the extension first: npm run build');
  const fixtures = await startFixtureServer();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tabi-providers-e2e-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless: !headed,
    viewport: { width: 1280, height: 900 },
    args: [`--disable-extensions-except=${EXTENSION_DIR}`, `--load-extension=${EXTENSION_DIR}`],
  });
  try {
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker', { timeout: 15_000 });
    await worker.evaluate(() => chrome.storage.local.set({
      tabi_llm: {
        provider: 'groq', fallbacks: ['openrouter'],
        models: { groq: 'qwen/qwen3.8-27b', openrouter: 'deepseek/deepseek-chat' },
        keys: { groq: 'gsk_test_providers_0000', openrouter: 'sk-or-test-providers-0000' },
      },
      tabi_prefs: { trustedInput: false },
    }));

    // Groq: one step, then a rate limit for the next 10 minutes
    let groqCalls = 0;
    await context.route('https://api.groq.com/openai/v1/chat/completions', async (route: Route) => {
      groqCalls++;
      if (groqCalls === 1) {
        const box = /\[(\d+)\] <input[^\n]*Search products/.exec(promptOf(route).split('CURRENT PAGE DOM SNAPSHOT:')[1] ?? '');
        return route.fulfill(reply(JSON.stringify({ action: 'type', elementId: Number(box?.[1] ?? 1), text: 'wireless headphones' })));
      }
      return route.fulfill({ status: 429, contentType: 'application/json', headers: { 'retry-after': '600' }, body: JSON.stringify({ error: { message: 'Rate limit reached for model qwen/qwen3.8-27b: tokens per minute', type: 'tokens', code: 'rate_limit_exceeded' } }) });
    });
    // OpenRouter: finishes, until its key is refused
    let refuse = false;
    const openrouterPrompts: string[] = [];
    await context.route('https://openrouter.ai/api/v1/chat/completions', async (route: Route) => {
      openrouterPrompts.push(promptOf(route));
      if (refuse) return route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: { message: 'No auth credentials found', code: 401 } }) });
      return route.fulfill(reply(JSON.stringify({ action: 'done', summary: 'Typed the search for you.' })));
    });

    const page = await context.newPage();
    await page.goto(`${fixtures.baseUrl}/search.html`);
    const panel = await openPanel(context, worker, page);
    const status = () => panel.locator('[data-run-status]').getAttribute('data-run-status').catch(() => null);
    const ended = async () => { for (let i = 0; i < 120 && !['done', 'error', 'stopped'].includes(String(await status())); i++) await panel.waitForTimeout(250); };

    // 1. Groq takes a step, then its limit: the backup carries on with the steps so far
    await sendTask(panel, 'Search this site for wireless headphones');
    await ended();
    const state = await runState(panel);
    check('the task finishes on the backup after the main provider’s rate limit', state?.status === 'done' && groqCalls >= 2 && openrouterPrompts.length >= 1,
      JSON.stringify({ status: state?.status, groqCalls, backupCalls: openrouterPrompts.length }));
    check('the backup gets the steps already taken', /ACTION HISTORY[^]*wireless headphones/.test(openrouterPrompts[0] ?? ''));
    check('the page kept what the main provider typed', await page.locator('input[name="q"]').inputValue() === 'wireless headphones');
    check('the model button says a backup took over', /backup/i.test(await panel.locator('header').innerText()) && /OpenRouter/.test(String(state?.model)), String(state?.model));

    // 2. The next task goes straight to the backup while Groq rests
    const groqBefore = groqCalls;
    const backupBefore = openrouterPrompts.length;
    await panel.getByRole('button', { name: 'Start over' }).click().catch(() => {});
    await sendTask(panel, 'Search this site for a mechanical keyboard');
    await panel.waitForTimeout(500);
    await ended();
    check('the next task skips the resting provider', groqCalls === groqBefore && openrouterPrompts.length > backupBefore && (await runState(panel))?.status === 'done',
      `groq ${groqBefore} → ${groqCalls}`);

    // 3. Every provider refused: the task stops and says why
    refuse = true;
    await panel.getByRole('button', { name: 'Start over' }).click().catch(() => {});
    await sendTask(panel, 'Search this site for a laptop stand');
    await panel.waitForTimeout(500);
    await ended();
    const failed = await runState(panel);
    const shown = await panel.locator('main').innerText();
    check('when every provider fails, the task stops and names the one whose key was refused', failed?.status === 'error'
      && shown.includes('OpenRouter rejected your API key') && !shown.includes('Groq rejected'), `${failed?.status}: ${shown.slice(0, 300)}`);
  } finally {
    await context.close().catch(() => {});
    await fixtures.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
}

main()
  .then(() => {
    console.log(failures ? `\n${failures} check(s) failed.` : '\nAll backup provider checks passed.');
    process.exit(failures ? 1 : 0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
