// End-to-end check of "Allow this?" (lib/agent/confirm.ts). A fake model
// types a chat message and clicks Send. In the side panel the user answers
// "Don't allow": nothing is sent and the model is told to finish without it.
// Meanwhile the page shows the cue in amber; it goes when the task ends.
// Then the same task runs in a background tab: it shows in the task list with
// what it wants to do, a notification asks, and "Allow" in the panel's
// "tasks in other tabs" strip sends it, without switching tabs.
// No real model or API key is involved.
//
//   npm run build && npm run eval:confirm   (-- --headed to watch)

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
const GOAL = 'Type Hello team in the message box and click Send';
const headed = process.argv.includes('--headed');

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `  — ${detail}`}`);
  if (!ok) failures++;
}

const answer = (content: string) => ({
  status: 200,
  contentType: 'application/json',
  body: JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }),
});

/** The text of the prompt's last message (screenshots are off, so it's a string). */
const promptOf = (route: Route): string => String(route.request().postDataJSON()?.messages?.at(-1)?.content ?? '');

async function main(): Promise<void> {
  if (!fs.existsSync(path.join(EXTENSION_DIR, 'manifest.json'))) throw new Error('Build the extension first: npm run build');
  const fixtures = await startFixtureServer();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tabi-confirm-e2e-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless: !headed,
    viewport: { width: 1280, height: 900 },
    args: [`--disable-extensions-except=${EXTENSION_DIR}`, `--load-extension=${EXTENSION_DIR}`],
  });
  const sent = () => fixtures.events.some((e) => e.path === '/api/message');
  try {
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker', { timeout: 15_000 });
    // Asking is on by default: nothing in the prefs turns it on
    await worker.evaluate((base) => chrome.storage.local.set({
      tabi_llm: { provider: 'custom', models: { custom: 'mock' }, keys: { custom: 'k' }, customBaseUrl: base },
      tabi_prefs: { trustedInput: false },
    }), MODEL);

    // The fake model: type the message and click Send; once answered, finish
    await context.route(`${MODEL}/**`, async (route: Route) => {
      const prompt = promptOf(route);
      if (prompt.includes("the user didn't allow it")) {
        return route.fulfill(answer('{"action":"done","summary":"Typed the message; sending it is left to you."}'));
      }
      if (prompt.includes('(the user allowed it)')) return route.fulfill(answer('{"action":"done","summary":"Sent it."}'));
      const box = /\[(\d+)\][^\n]*"Message #general"/.exec(prompt)?.[1];
      const send = /\[(\d+)\] <button> "Send"/.exec(prompt)?.[1];
      return route.fulfill(answer(JSON.stringify({
        actions: [{ action: 'type', elementId: Number(box), text: 'Hello team' }, { action: 'click', elementId: Number(send) }],
      })));
    });

    // 1. In the side panel: Don't allow
    const page = await context.newPage();
    await page.goto(`${fixtures.baseUrl}/editor.html`);
    const panel = await openPanel(context, worker, page);
    await sendTask(panel, GOAL);
    const asking = panel.locator('[data-asking]');
    await asking.waitFor({ timeout: 20_000 });
    check('the panel asks before clicking "Send"', (await asking.getAttribute('data-asking')) === 'click "Send"', String(await asking.getAttribute('data-asking')));
    check('and says why', (await asking.innerText()).includes('sending a message or post'));
    check('the message is typed, not sent, while it asks', !sent() && (await page.locator('#editor').innerText()).includes('Hello team'));
    await page.locator('tabi-cue[data-state="needs"]').waitFor({ state: 'attached', timeout: 5_000 }).catch(() => {});
    check('the page shows the cue in amber: Tabi needs your OK', (await page.locator('tabi-cue[data-state="needs"]').count()) === 1);
    await panel.getByRole('button', { name: "Don't allow" }).click();
    await panel.locator('[data-run-status="done"]').waitFor({ timeout: 20_000 });
    const text: string = (await runState(panel))?.message ?? '';
    check("Don't allow: nothing is sent", !sent(), JSON.stringify(fixtures.events));
    check('the model is told, and finishes without it', text.includes("the user didn't allow it") && text.includes('left to you'), text.slice(0, 400));
    check('the question goes away', (await asking.count()) === 0);
    await page.locator('tabi-cue').waitFor({ state: 'detached', timeout: 5_000 }).catch(() => {});
    check('and the cue leaves the page when the task ends', (await page.locator('tabi-cue').count()) === 0);

    // 2. In a background tab: the task list and a notification ask; Allow from the panel's strip
    fixtures.reset();
    await sendTask(panel, GOAL, { background: true });
    let task: any;
    for (let i = 0; i < 80 && !task; i++) {
      const tasks = (await panel.evaluate(() => chrome.runtime.sendMessage({ action: 'LIST_TASKS' })) as any)?.data ?? [];
      task = tasks.find((t: any) => t.asking);
      if (!task) await panel.waitForTimeout(250);
    }
    check('the task list shows what a background task wants to do', task?.asking?.action === 'click "Send"', JSON.stringify(task));
    // The notification follows the task list by a moment (it checks the tab first)
    let notes: string[] = [];
    for (let i = 0; i < 20 && !notes.includes(`tabi-task:${task?.tabId}`); i++) {
      if (i) await panel.waitForTimeout(250);
      notes = Object.keys(await worker.evaluate(() => new Promise((resolve) => chrome.notifications.getAll(resolve))) as object);
    }
    check('a notification asks for the OK', notes.includes(`tabi-task:${task?.tabId}`), JSON.stringify(notes));
    check('nothing is sent before the answer', !sent());
    const strip = panel.locator('[data-testid="tasks-elsewhere"]');
    await strip.getByText('1 needs you').waitFor({ timeout: 10_000 });
    check('the panel says a task elsewhere needs you', (await strip.innerText()).includes('1 task in other tabs'), await strip.innerText());
    await strip.getByRole('button', { name: /task in other tabs/ }).click();
    await strip.getByRole('button', { name: 'Allow', exact: true }).click({ timeout: 10_000 });
    for (let i = 0; i < 40 && !sent(); i++) await panel.waitForTimeout(250);
    check('Allow in the panel, without switching tabs: it sends', sent(), JSON.stringify(fixtures.events));
  } finally {
    await context.close().catch(() => {});
    await fixtures.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
}

main()
  .then(() => {
    console.log(failures ? `\n${failures} check(s) failed.` : '\nAll confirmation checks passed.');
    process.exit(failures ? 1 : 0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
