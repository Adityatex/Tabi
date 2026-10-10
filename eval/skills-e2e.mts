// eval/skills-e2e.mts
// End-to-end check of choosing a skill in the side panel's / menu. A saved
// skill must be listed under Skills with its description; picking it puts
// "/name " in the box to say what to do; sending that runs the task with the
// skill's instructions in the model's very first prompt, and the task card
// says so. In a background tab too. An unknown /name says so instead of
// running. A fake model answers; no real model or API key is involved.
//
//   npm run build && npm run eval:skills   (-- --headed to watch)

import { chromium, type Route } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFixtureServer } from './server.mts';
import { composer, openPanel, runState } from './panel.mts';

declare const chrome: any;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXTENSION_DIR = path.join(ROOT, '.output', 'chrome-mv3');
const MODEL = 'https://mock-llm.test/v1';
const MARKER = 'Always sign off with SKILL-MARKER-7731.';
const SKILL = { name: 'house-style', description: 'Write messages in our house style', sites: [], body: `1. Keep it short.\n2. ${MARKER}` };
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

async function main(): Promise<void> {
  if (!fs.existsSync(path.join(EXTENSION_DIR, 'manifest.json'))) throw new Error('Build the extension first: npm run build');
  const fixtures = await startFixtureServer();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tabi-skills-e2e-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless: !headed,
    viewport: { width: 1280, height: 900 },
    args: [`--disable-extensions-except=${EXTENSION_DIR}`, `--load-extension=${EXTENSION_DIR}`],
  });
  try {
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker', { timeout: 15_000 });
    await worker.evaluate(({ base, skill }) => chrome.storage.local.set({
      tabi_llm: { provider: 'custom', models: { custom: 'mock' }, keys: { custom: 'k' }, customBaseUrl: base },
      tabi_prefs: { trustedInput: false },
      tabi_skills: [skill],
    }), { base: MODEL, skill: SKILL });

    // The fake model: records each run's first prompt, then says it's done
    const firstPrompts: string[] = [];
    let calls = 0;
    await context.route(`${MODEL}/**`, async (route: Route) => {
      calls++;
      const messages = route.request().postDataJSON()?.messages ?? [];
      const prompt = messages.map((m: any) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n');
      if (!prompt.includes('ACTION HISTORY (steps already taken)')) firstPrompts.push(prompt);
      return route.fulfill(answer('{"action":"done","summary":"Done."}'));
    });

    const page = await context.newPage();
    await page.goto(`${fixtures.baseUrl}/contact.html`);
    const panel = await openPanel(context, worker, page);
    const box = composer(panel);

    // 1. Typing / lists the skill under Skills, with its description
    await box.fill('/');
    const menu = panel.getByRole('listbox', { name: /skills/i });
    await menu.waitFor({ timeout: 5_000 });
    const listed = await menu.innerText();
    check('/ lists the skill under Skills, with its description', /SKILLS/i.test(listed) && listed.includes('/house-style') && listed.includes(SKILL.description), listed);

    // 2. Picking it puts its name in the box, to say what to do
    await box.fill('/house');
    await box.press('Enter');
    check('picking it puts "/house-style " in the box and says what to do next',
      (await box.inputValue()) === '/house-style ' && await panel.getByText('Now say what to do with /house-style').waitFor({ timeout: 5_000 }).then(() => true, () => false), await box.inputValue());

    // 3. The task runs with the skill in the first prompt, and the card says so
    await box.press('End');
    await box.pressSequentially('write a thank-you note to Sam');
    await box.press('Enter');
    await panel.locator('[data-run-status="done"]').waitFor({ timeout: 30_000 });
    const state = await runState(panel);
    check('the task is the words after the name', state?.goal === 'write a thank-you note to Sam', String(state?.goal));
    check('the skill is in the model’s first prompt', firstPrompts.length === 1 && firstPrompts[0].includes(MARKER), `${firstPrompts.length} first prompt(s)`);
    check('the task card says which skill', (await panel.getByTestId('chosen-skills').innerText().catch(() => '')).includes('/house-style'));

    // 4. A task without one doesn't get it (this skill doesn't fit the words)
    await panel.getByRole('button', { name: /^Auto/ }).click();
    await panel.getByRole('menuitemradio', { name: /Do it/ }).click();
    await box.fill('find the support email');
    await box.press('Enter');
    for (let i = 0; i < 40 && firstPrompts.length < 2; i++) await panel.waitForTimeout(250);
    check('a task without /house-style doesn’t get it', firstPrompts.length === 2 && !firstPrompts[1].includes(MARKER), `${firstPrompts.length} first prompt(s)`);

    // 5. In a background tab too
    await box.fill('/house-style draft a reply to the latest message');
    await panel.getByRole('button', { name: 'Background' }).click();
    await box.press('Enter');
    for (let i = 0; i < 60 && firstPrompts.length < 3; i++) await panel.waitForTimeout(250);
    check('a background task gets the skill too', firstPrompts.length === 3 && firstPrompts[2].includes(MARKER) && firstPrompts[2].includes('draft a reply'), `${firstPrompts.length} first prompt(s)`);
    await panel.getByRole('button', { name: 'Background' }).click();

    // 6. An unknown name says so instead of running anything
    const before = calls;
    await box.fill('/no-such-skill do something');
    await box.press('Enter');
    const error = await panel.getByText('There’s no workflow, shortcut, skill or command called /no-such-skill').waitFor({ timeout: 5_000 }).then(() => true, () => false);
    await panel.waitForTimeout(500);
    check('an unknown /name says so, and runs nothing', error && calls === before, `calls ${before} → ${calls}`);
  } finally {
    await context.close().catch(() => {});
    await fixtures.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
}

main()
  .then(() => {
    console.log(failures ? `\n${failures} check(s) failed.` : '\nAll skill menu checks passed.');
    process.exit(failures ? 1 : 0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
