// End-to-end check of the run timeline (lib/agent/timeline.ts) and the
// History page. A fake model signs in on a test page (typing a password),
// then says done. The run must be saved, listed, and shown step by step
// with its model calls and token counts, searchable and filterable, the password masked everywhere,
// including the Markdown export and the side panel's steps. "See the full
// timeline" in the panel must open the page at that run, and Delete must
// remove it. No real model or API key is involved.
//
//   npm run build && npm run eval:history   (-- --headed to watch)

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
const MODEL = 'https://mock-llm.test/v1';
const PASSWORD = 'tr4il-RUNNER-secret';
const GOAL = 'Sign in as demo';
const headed = process.argv.includes('--headed');

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `  — ${detail}`}`);
  if (!ok) failures++;
}

/** A chat completion that reports token usage, like real providers do. */
const answer = (content: string) => ({
  status: 200,
  contentType: 'application/json',
  body: JSON.stringify({ choices: [{ message: { role: 'assistant', content } }], usage: { prompt_tokens: 1200, completion_tokens: 80, total_tokens: 1280 } }),
});

async function main(): Promise<void> {
  if (!fs.existsSync(path.join(EXTENSION_DIR, 'manifest.json'))) throw new Error('Build the extension first: npm run build');
  const fixtures = await startFixtureServer();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tabi-history-e2e-'));
  const downloads = fs.mkdtempSync(path.join(os.tmpdir(), 'tabi-history-dl-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless: !headed,
    viewport: { width: 1280, height: 900 },
    acceptDownloads: true,
    downloadsPath: downloads,
    args: [`--disable-extensions-except=${EXTENSION_DIR}`, `--load-extension=${EXTENSION_DIR}`],
  });
  try {
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker', { timeout: 15_000 });
    await worker.evaluate((base) => chrome.storage.local.set({
      tabi_llm: { provider: 'custom', models: { custom: 'mock' }, keys: { custom: 'k' }, customBaseUrl: base },
      tabi_prefs: { trustedInput: false },
    }), MODEL);

    // The fake model: fill the sign-in form, then finish
    let calls = 0;
    await context.route(`${MODEL}/**`, async (route: Route) => {
      calls++;
      const prompt = String(route.request().postDataJSON()?.messages?.at(-1)?.content ?? '');
      if (calls > 1) return route.fulfill(answer('{"action":"done","summary":"Signed in as demo."}'));
      const id = (re: RegExp) => Number(re.exec(prompt)?.[1]);
      return route.fulfill(answer(JSON.stringify({ actions: [
        { action: 'type', elementId: id(/\[(\d+)\][^\n]*"Username"/), text: 'demo' },
        { action: 'type', elementId: id(/\[(\d+)\][^\n]*type="password"/), text: PASSWORD },
        { action: 'click', elementId: id(/\[(\d+)\] <button>[^\n]*"Sign in"/) },
      ] })));
    });

    // 1. A run from the side panel
    const page = await context.newPage();
    await page.goto(`${fixtures.baseUrl}/login.html`);
    const panel = await openPanel(context, worker, page);
    await sendTask(panel, GOAL);
    await panel.locator('[data-run-status="done"]').waitFor({ timeout: 30_000 });
    // The steps the panel shows (in the stream while it runs; the done screen sums up instead)
    const steps = ((await runState(panel))?.steps ?? []).map((st: any) => st.action).join(' | ');
    check('the panel has the steps in plain words, password hidden',
      steps.includes('Typed a password into “Password”') && steps.includes('Clicked “Sign in”') && !steps.includes(PASSWORD) && !(await panel.content()).includes(PASSWORD), steps.slice(0, 400));

    // 2. It's saved
    let stored: any[] = [];
    for (let i = 0; i < 20 && !stored.some((r) => r.ended); i++) {
      if (i) await page.waitForTimeout(250);
      stored = (await worker.evaluate(() => chrome.storage.local.get('tabi_runs')) as any).tabi_runs ?? [];
    }
    const run = stored[0];
    check('the run is saved when it ends', stored.length === 1 && run?.goal === GOAL && run?.status === 'done' && !!run?.ended, JSON.stringify(stored).slice(0, 300));
    check('with its model calls and tokens', run?.calls === 2 && run?.tokens === 2560, `calls ${run?.calls}, tokens ${run?.tokens}`);
    check('and the password masked', !JSON.stringify(stored).includes(PASSWORD) && JSON.stringify(stored).includes('••••'));

    // 3. The History page, from "See the full timeline" in the panel
    const opened = context.waitForEvent('page', { predicate: (p) => p.url().includes('/history.html') });
    await panel.getByRole('button', { name: 'See the full timeline' }).click();
    const history = await opened;
    await history.waitForLoadState();
    check('it opens at that run', history.url().endsWith(`/history.html#${run?.id}`), history.url());
    const title = history.getByRole('heading', { level: 1 });
    await title.waitFor({ timeout: 10_000 });
    const rows = history.getByRole('navigation', { name: 'Runs' }).locator('button[data-run-id]');
    check('the run is listed and shown', (await rows.count()) === 1 && (await title.innerText()) === GOAL
      && (await history.locator('article').getAttribute('data-run-status')) === 'done');
    check('its source and totals show', (await history.locator('article').innerText()).includes('started from the side panel')
      && (await history.locator('dl').innerText()).includes('2.6k'));
    // The steps that worked fold into one row; open it
    const timeline = history.getByRole('list', { name: 'Timeline' });
    for (const fold of await timeline.locator('button[aria-expanded="false"]').all()) await fold.click();
    const text = await timeline.innerText();
    check('the timeline shows the model calls, the steps and the end',
      (await timeline.locator('[data-kind="model"]').count()) === 2 && (await timeline.locator('[data-kind="step"]').count()) >= 3
        && text.includes('1.3k tokens') && (await timeline.locator('[data-kind="end"]').innerText()).includes('Done'),
      text.slice(0, 600));
    check('steps are in plain words, by the label of what they acted on', text.includes('Typed a password into “Password”') && text.includes('Clicked “Sign in”'), text.slice(0, 600));
    check('the page never shows the password', !(await history.content()).includes(PASSWORD));

    // Search and the filter chips
    await history.getByRole('searchbox', { name: 'Search runs' }).fill('no such run');
    const none = await rows.count() === 0 && await history.getByText('No runs match.').isVisible();
    await history.getByRole('searchbox', { name: 'Search runs' }).fill('');
    await history.getByRole('button', { name: 'Failed' }).click();
    const noFailed = await rows.count() === 0;
    await history.getByRole('button', { name: 'Done', exact: true }).click();
    check('search and the filter chips narrow the list', none && noFailed && await rows.count() === 1);

    // --screenshot: save what the page looks like (eval/results/history.png)
    if (process.argv.includes('--screenshot')) {
      fs.mkdirSync(path.join(ROOT, 'eval', 'results'), { recursive: true });
      await history.screenshot({ path: path.join(ROOT, 'eval', 'results', 'history.png'), fullPage: true });
    }

    // 4. Export as Markdown
    const download = history.waitForEvent('download');
    await history.getByRole('button', { name: 'Export Markdown' }).click();
    const file = await (await download).path();
    const md = file ? fs.readFileSync(file, 'utf8') : '';
    check('Export saves the run as Markdown, password masked', md.startsWith(`# Tabi run: ${GOAL}`) && md.includes('2 model calls') && !md.includes(PASSWORD), md.slice(0, 300));

    // 5. Delete
    await history.getByRole('button', { name: 'Delete this run' }).click();
    await history.getByText('No runs yet.').first().waitFor({ timeout: 5_000 }).catch(() => {});
    const left = (await worker.evaluate(() => chrome.storage.local.get('tabi_runs')) as any).tabi_runs ?? [];
    check('Delete removes it', left.length === 0 && await history.getByText('No runs yet.').first().isVisible(), JSON.stringify(left).slice(0, 200));
  } finally {
    await context.close().catch(() => {});
    await fixtures.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
    fs.rmSync(downloads, { recursive: true, force: true });
  }
}

main()
  .then(() => {
    console.log(failures ? `\n${failures} check(s) failed.` : '\nAll run history checks passed.');
    process.exit(failures ? 1 : 0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
