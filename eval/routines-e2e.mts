// End-to-end check of routines, through the side panel and Settings as a user
// would, with the edge cases that matter:
// - Workflows: a finished task is saved, replays from the home screen's
//   "Saved for this site" with no model calls, and when the page has changed
//   (the button was renamed) the agent takes over, finishes, and "Update
//   workflow" saves the fix, so the next replay needs no model again.
// - Shortcuts: added in Settings with a blank; /name words fills it; /name
//   alone puts the request in the box to finish, running nothing; two blanks
//   take comma-separated words; renaming one moves its schedule, deleting it
//   removes the schedule; "Save as shortcut" saves a finished task's request.
// - Skills: one saved for a site is used there, kept off other sites even when
//   it fits the task, and still used anywhere when chosen by /name.
// A fake model answers; no real model or API key is involved.
//
//   npm run build && npm run eval:routines   (-- --headed to watch)

import { chromium, type Page, type Route } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFixtureServer } from './server.mts';
import { composer, openPanel, runState, sendTask } from './panel.mts';

declare const chrome: any;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXTENSION_DIR = path.join(ROOT, '.output', 'chrome-mv3');
const MODEL = 'https://mock-llm.test/v1';
const MARKER = 'SKILL-MARK-5521';
const headed = process.argv.includes('--headed');

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `  — ${detail}`}`);
  if (!ok) failures++;
}

async function until<T>(get: () => Promise<T>, ok: (v: T) => boolean, ms: number): Promise<T> {
  const end = Date.now() + ms;
  let value = await get();
  while (!ok(value) && Date.now() < end) {
    await new Promise((r) => setTimeout(r, 250));
    value = await get();
  }
  return value;
}

/** The fee page: version 2 renames its button, as a site redesign would. */
let version = 1;
const receiptPage = () => `<!doctype html><meta charset="utf-8"><title>Hostel fees</title>
<h1>Hostel fees</h1><p>Semester 1 fee: paid on 3 August.</p>
<button id="get">${version === 1 ? 'Download receipt' : 'Get my receipt'}</button><p id="out"></p>
<script>
document.getElementById('get').onclick = async () => {
  await fetch('/api/receipt', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ v: ${version} }) });
  document.getElementById('out').textContent = 'Receipt downloaded';
};
</script>`;

async function main(): Promise<void> {
  if (!fs.existsSync(path.join(EXTENSION_DIR, 'manifest.json'))) throw new Error('Build the extension first: npm run build');
  const fixtures = await startFixtureServer();
  const other = fixtures.baseUrl.replace('127.0.0.1', 'localhost');
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tabi-routines-e2e-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless: !headed,
    viewport: { width: 1280, height: 900 },
    args: [`--disable-extensions-except=${EXTENSION_DIR}`, `--load-extension=${EXTENSION_DIR}`],
  });
  try {
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker', { timeout: 15_000 });
    const extensionId = new URL(worker.url()).host;
    await worker.evaluate((base) => chrome.storage.local.set({
      tabi_llm: { provider: 'custom', models: { custom: 'mock' }, keys: { custom: 'k' }, customBaseUrl: base },
      tabi_prefs: { trustedInput: false },
    }), MODEL);
    await context.route(/\/receipt\.html(\?.*)?$/, (route: Route) => route.fulfill({ status: 200, contentType: 'text/html', body: receiptPage() }));

    // The fake model: clicks the receipt button when told to, else says it's done. Keeps each task's first prompt.
    let clickReceipt = false;
    let calls = 0;
    const firstPrompts: string[] = [];
    await context.route(`${MODEL}/**`, async (route: Route) => {
      calls++;
      const messages = route.request().postDataJSON()?.messages ?? [];
      const prompt = messages.map((m: any) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n');
      const first = !prompt.includes('ACTION HISTORY (steps already taken)');
      if (first) firstPrompts.push(prompt);
      const page = prompt.split('CURRENT PAGE DOM SNAPSHOT:')[1] ?? '';
      const button = /\[(\d+)\] <button>[^\n]*receipt/i.exec(page);
      const content = clickReceipt && button && !page.includes('Receipt downloaded')
        ? JSON.stringify({ action: 'click', elementId: Number(button[1]) })
        : JSON.stringify({ action: 'done', summary: 'Done.' });
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }) });
    });
    const receipts = () => fixtures.events.filter((e) => e.path === '/api/receipt');
    let opened = 0;
    /** A new tab on `url`, with its own side panel. */
    const open = async (url: string): Promise<{ page: Page; panel: Page }> => {
      const page = await context.newPage();
      // A query of its own: the panel finds its tab by address
      await page.goto(`${url}?tab=${++opened}`);
      return { page, panel: await openPanel(context, worker, page) };
    };
    const finished = (panel: Page) => panel.locator('[data-run-status="done"]').waitFor({ timeout: 30_000 }).then(() => true, () => false);

    // ---- Workflows
    clickReceipt = true;
    const first = await open(`${fixtures.baseUrl}/receipt.html`);
    await sendTask(first.panel, 'Download my hostel fee receipt');
    const done = await finished(first.panel);
    check('a task clicks the button (the model is told to)', done && receipts().length === 1, `${receipts().length} receipt request(s)`);
    await first.panel.getByRole('button', { name: 'Save as workflow' }).click();
    const savedText = await first.panel.getByTestId('save-result').innerText({ timeout: 10_000 }).catch(() => '');
    const workflow: any = (await worker.evaluate(async () => (await chrome.storage.local.get('tabi_workflows')).tabi_workflows?.[0]));
    const name = workflow?.name ?? '';
    check('"Save as workflow" saves its steps', /^Workflow saved: \//.test(savedText) && workflow?.steps?.length === 1, savedText);

    const second = await open(`${fixtures.baseUrl}/receipt.html`);
    const callsBefore = calls;
    await second.panel.getByTestId('idle').getByRole('button', { name: `Run /${name}` }).click({ timeout: 5_000 });
    const replayed = await finished(second.panel);
    check('the home screen offers it for this site, and Run replays it with no model calls',
      replayed && calls === callsBefore && receipts().length === 2 && (await runState(second.panel))?.replay === 'replayed'
      && await second.page.locator('#out').innerText() === 'Receipt downloaded',
      `calls ${callsBefore} → ${calls}, ${receipts().length} receipts, replay ${(await runState(second.panel))?.replay}`);

    version = 2;
    const third = await open(`${fixtures.baseUrl}/receipt.html`);
    await sendTask(third.panel, `/${name}`);
    const healed = await finished(third.panel);
    const healedState = await runState(third.panel);
    check('on a changed page the agent takes over from the step that no longer fits, and finishes',
      healed && calls > callsBefore && receipts().at(-1)?.data?.v === 2 && healedState?.replay === 'healed',
      `replay ${healedState?.replay}, last receipt v${receipts().at(-1)?.data?.v}`);
    await third.panel.getByRole('button', { name: 'Update workflow' }).click();
    const updated = await third.panel.getByTestId('save-result').innerText({ timeout: 10_000 }).catch(() => '');
    const fixed: any = await worker.evaluate(async () => (await chrome.storage.local.get('tabi_workflows')).tabi_workflows);
    check('"Update workflow" saves the fix under the same name',
      updated.startsWith(`Workflow updated: /${name}`) && fixed?.length === 1 && JSON.stringify(fixed[0].steps).includes('Get my receipt'), updated);
    const callsAfterFix = calls;
    await sendTask(third.panel, `/${name}`);
    await until(async () => receipts().length, (n) => n === 4, 20_000);
    await finished(third.panel);
    check('the updated workflow replays on the new page with no model calls', calls === callsAfterFix && receipts().length === 4, `calls ${callsAfterFix} → ${calls}`);
    clickReceipt = false;

    // ---- Shortcuts
    const settings = await context.newPage();
    await settings.goto(`chrome-extension://${extensionId}/options.html#shortcuts`);
    await settings.getByRole('button', { name: 'Add a shortcut' }).click();
    await settings.getByLabel('Name (optional)').fill('price-check');
    await settings.getByLabel('Request').fill('Find the price of {product} on this site');
    await settings.getByRole('button', { name: 'Save shortcut' }).click();
    await settings.getByText('Saved. Type / in the side panel to use it.').waitFor({ timeout: 5_000 });
    await settings.evaluate(() => chrome.runtime.sendMessage({ action: 'SAVE_SHORTCUT', payload: { name: 'compare', prompt: 'Compare {first} and {second}' } }));

    const shop = await open(`${fixtures.baseUrl}/search.html`);
    const box = composer(shop.panel);
    const goalOf = async () => (await runState(shop.panel))?.goal;
    await sendTask(shop.panel, '/price-check running shoes');
    await finished(shop.panel);
    check('/name words fills the blank and runs the request', await goalOf() === 'Find the price of running shoes on this site', String(await goalOf()));

    let before = calls;
    await box.fill('/price-check');
    await box.press('Enter');
    const notice = await shop.panel.getByText('Fill in {product}, then press Enter.').waitFor({ timeout: 5_000 }).then(() => true, () => false);
    await shop.panel.waitForTimeout(500);
    check('/name alone puts the request in the box to finish, and runs nothing',
      notice && await box.inputValue() === 'Find the price of {product} on this site' && calls === before, await box.inputValue());

    await sendTask(shop.panel, '/compare apples, pears');
    await until(goalOf, (g) => g === 'Compare apples and pears', 10_000);
    await finished(shop.panel);
    check('two blanks take comma-separated words', await goalOf() === 'Compare apples and pears', String(await goalOf()));
    before = calls;
    await box.fill('/compare apples');
    await box.press('Enter');
    await shop.panel.waitForTimeout(500);
    check('with a blank left over, it waits in the box', await box.inputValue() === 'Compare apples and {second}' && calls === before, await box.inputValue());
    await box.fill('');

    await shop.panel.getByRole('button', { name: 'Save as shortcut' }).click();
    const shortcutSaved = await shop.panel.getByTestId('save-result').innerText({ timeout: 10_000 }).catch(() => '');
    const shortcuts: any[] = await worker.evaluate(async () => (await chrome.storage.local.get('tabi_shortcuts')).tabi_shortcuts ?? []);
    check('"Save as shortcut" saves a finished task’s request', shortcutSaved.startsWith('Shortcut saved: /') && shortcuts.some((s) => s.prompt === 'Compare apples and pears'), shortcutSaved);

    await settings.evaluate((url) => chrome.runtime.sendMessage({
      action: 'SAVE_SCHEDULE', payload: { kind: 'shortcut', name: 'price-check', args: 'running shoes', url, frequency: 'daily', time: '09:00' },
    }), `${fixtures.baseUrl}/search.html`);
    await settings.reload();
    await settings.getByRole('button', { name: 'Edit /price-check' }).click();
    await settings.getByLabel('Name (optional)').fill('shoe-price');
    await settings.getByRole('button', { name: 'Save shortcut' }).click();
    await settings.getByRole('button', { name: 'Delete /shoe-price' }).waitFor({ timeout: 5_000 });
    const afterRename: any = await worker.evaluate(async () => ({
      shortcuts: ((await chrome.storage.local.get('tabi_shortcuts')).tabi_shortcuts ?? []).map((s: any) => s.name),
      schedules: ((await chrome.storage.local.get('tabi_schedules')).tabi_schedules ?? []).map((s: any) => s.name),
    }));
    check('renaming a shortcut replaces it, and its schedule follows the new name',
      afterRename.shortcuts.includes('shoe-price') && !afterRename.shortcuts.includes('price-check') && JSON.stringify(afterRename.schedules) === '["shoe-price"]', JSON.stringify(afterRename));
    await settings.getByRole('button', { name: 'Delete /shoe-price' }).click();
    const deletedSaid = await settings.getByText('Deleted /shoe-price. Its schedule was removed too.').waitFor({ timeout: 5_000 }).then(() => true, () => false);
    const schedulesLeft = await worker.evaluate(async () => ((await chrome.storage.local.get('tabi_schedules')).tabi_schedules ?? []).length);
    check('deleting a scheduled shortcut removes its schedule, and says so', deletedSaid && schedulesLeft === 0, `${schedulesLeft} schedule(s) left`);

    // ---- Skills for one site
    await worker.evaluate((marker) => chrome.storage.local.set({
      tabi_skills: [{ name: 'fee-receipts', description: 'Download hostel fee receipts', sites: ['127.0.0.1'], body: `1. ${marker}` }],
    }), MARKER);
    const onSite = await open(`${fixtures.baseUrl}/receipt.html`);
    let prompts = firstPrompts.length;
    await sendTask(onSite.panel, 'Download my hostel fee receipt');
    await finished(onSite.panel);
    check('a skill for this site is used on it', firstPrompts.length > prompts && firstPrompts.at(-1)!.includes(MARKER));

    const offSite = await open(`${other}/receipt.html`);
    prompts = firstPrompts.length;
    await sendTask(offSite.panel, 'Download my hostel fee receipt');
    await finished(offSite.panel);
    const offPrompt = firstPrompts.at(-1) ?? '';
    check('it stays off other sites, however well it fits (only listed, to load by name)',
      firstPrompts.length > prompts && !offPrompt.includes(MARKER) && /OTHER SKILLS[^]*fee-receipts/.test(offPrompt));
    prompts = firstPrompts.length;
    await sendTask(offSite.panel, '/fee-receipts download the receipt');
    await until(async () => firstPrompts.length, (n) => n > prompts, 10_000);
    await finished(offSite.panel);
    check('chosen by /name, it is used on any site', firstPrompts.length > prompts && firstPrompts.at(-1)!.includes(MARKER));
  } finally {
    await context.close().catch(() => {});
    await fixtures.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
}

main()
  .then(() => {
    console.log(failures ? `\n${failures} check(s) failed.` : '\nAll routine checks passed.');
    process.exit(failures ? 1 : 0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
