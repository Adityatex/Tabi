// End-to-end check of schedules: Settings saves a schedule for a workflow,
// a real Chrome alarm goes off, the workflow replays in a background tab with
// no model, the result is recorded, the tab closes and a notification shows.
// No model or API key is involved.
//
//   npm run build && npm run eval:schedule   (-- --headed to watch)

import { chromium } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFixtureServer } from './server.mts';

declare const chrome: any;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXTENSION_DIR = path.join(ROOT, '.output', 'chrome-mv3');
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

async function main(): Promise<void> {
  if (!fs.existsSync(path.join(EXTENSION_DIR, 'manifest.json'))) throw new Error('Build the extension first: npm run build');
  const fixtures = await startFixtureServer();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tabi-schedule-e2e-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless: !headed,
    args: [`--disable-extensions-except=${EXTENSION_DIR}`, `--load-extension=${EXTENSION_DIR}`],
  });
  try {
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker', { timeout: 15_000 });
    const extensionId = new URL(worker.url()).host;

    // A workflow, as "Save as workflow" stores it: the login fixture's three steps
    const workflow = {
      name: 'log-in-as-demo',
      goal: 'Log in with username demo and password hunter2',
      startUrl: `${fixtures.baseUrl}/login.html`,
      steps: [
        { action: { action: 'type', text: 'demo' }, target: { key: '<input> "Username" placeholder="Username"', nth: 0 } },
        { action: { action: 'type', text: 'hunter2' }, target: { key: '<input> type="password" "Password" placeholder="Password"', nth: 0 } },
        { action: { action: 'click' }, target: { key: '<button> type="submit" "Sign in"', nth: 0 } },
      ],
      hasPassword: true,
    };
    await worker.evaluate((w) => chrome.storage.local.set({ tabi_workflows: [w] }), workflow);

    // Settings schedules it, as a user would
    const settings = await context.newPage();
    await settings.goto(`chrome-extension://${extensionId}/options.html`);
    const saved: any = await settings.evaluate(() => chrome.runtime.sendMessage({
      action: 'SAVE_SCHEDULE',
      payload: { kind: 'workflow', name: 'log-in-as-demo', frequency: 'daily', time: '03:00' },
    }));
    const schedule = saved?.data?.[0];
    check('Settings saves a schedule', saved?.success === true && schedule?.nextRun > Date.now(), JSON.stringify(saved));
    const alarm: any = await worker.evaluate((id) => chrome.alarms.get(`tabi-schedule:${id}`), schedule.id);
    check('its Chrome alarm is set for the next run', alarm?.scheduledTime === schedule.nextRun, JSON.stringify(alarm));
    const tabsBefore = context.pages().length;

    // Make the alarm go off now, as it would at 03:00
    await worker.evaluate((id) => chrome.alarms.create(`tabi-schedule:${id}`, { when: Date.now() + 1000 }), schedule.id);
    const login = await until(async () => fixtures.events.find((e) => e.path === '/api/login'), Boolean, 30_000);
    check('the alarm replays the workflow in a background tab', login?.data?.username === 'demo' && login?.data?.password === 'hunter2', 'no login reached the server');

    const after: any = await until(
      () => worker.evaluate(async () => (await chrome.storage.local.get('tabi_schedules')).tabi_schedules?.[0]),
      (s: any) => !!s?.lastRun,
      30_000,
    );
    check('the result is recorded', after?.lastRun?.status === 'done' && /no model calls/.test(after?.lastRun?.summary ?? ''), JSON.stringify(after?.lastRun));
    check('the next run is set', after?.nextRun > Date.now(), String(after?.nextRun));

    // The scheduler records the result first and notifies after, so wait for it
    const notes: Record<string, unknown> = await until(
      () => worker.evaluate(() => new Promise<Record<string, unknown>>((resolve) => chrome.notifications.getAll(resolve))),
      (n) => Object.keys(n).length > 0,
      10_000,
    );
    check('a notification says how it went', Object.keys(notes).length === 1, JSON.stringify(notes));
    await until(async () => context.pages().length, (n) => n <= tabsBefore, 10_000);
    check('the background tab closes after a successful run', context.pages().length <= tabsBefore, `${context.pages().length} pages open`);
  } finally {
    await context.close().catch(() => {});
    await fixtures.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
}

main()
  .then(() => {
    console.log(failures ? `\n${failures} check(s) failed.` : '\nAll schedule checks passed.');
    process.exit(failures ? 1 : 0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
