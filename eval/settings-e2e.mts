// End-to-end check of the Settings page. Through its controls, as a user
// would: save a provider (the key is shown masked and never in the page),
// add a backup and move it up, turn off "Ask before buying" (a warning
// shows and the preference is saved), add a schedule with the form, and
// open Settings at a section from the side panel, switch the model from the
// panel's menu, and see its home screen. No real model is called:
// the provider's model list is answered by the test.
//
//   npm run build && npm run eval:settings   (-- --headed to watch)

import { chromium, type Route } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFixtureServer } from './server.mts';
import { openPanel } from './panel.mts';

declare const chrome: any;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXTENSION_DIR = path.join(ROOT, '.output', 'chrome-mv3');
const headed = process.argv.includes('--headed');
const KEY = 'gsk_test_key_0123456789abcdef4f2a';

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `  — ${detail}`}`);
  if (!ok) failures++;
}

async function main(): Promise<void> {
  if (!fs.existsSync(path.join(EXTENSION_DIR, 'manifest.json'))) throw new Error('Build the extension first: npm run build');
  const fixtures = await startFixtureServer();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tabi-settings-e2e-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium', headless: !headed, viewport: { width: 1280, height: 900 },
    args: [`--disable-extensions-except=${EXTENSION_DIR}`, `--load-extension=${EXTENSION_DIR}`],
  });
  try {
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker', { timeout: 15_000 });
    const id = new URL(worker.url()).host;
    // The providers' model lists ("Test"), answered here
    const models = (list: string[]) => async (route: Route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: list.map((m) => ({ id: m })) }) });
    await context.route('https://api.groq.com/openai/v1/models', models(['qwen/qwen3.8-27b', 'llama-3.1-8b-instant']));
    await context.route('https://openrouter.ai/api/v1/models', models(['deepseek/deepseek-chat']));

    const settings = await context.newPage();
    await settings.goto(`chrome-extension://${id}/options.html#models`);

    // 1. The main provider: paste a key, test it, save
    const main = settings.locator('section', { has: settings.getByText('Main provider', { exact: true }) });
    await main.getByRole('textbox', { name: 'API key' }).fill(KEY);
    await main.getByRole('button', { name: 'Test' }).click();
    await main.getByText(/Key works/).waitFor({ timeout: 10_000 });
    check('Test says the key works', await main.getByText('Working').isVisible());
    await main.getByRole('button', { name: /Save changes|Use as main provider/ }).click();
    await main.getByText(/Saved\. Tabi now uses Groq/).waitFor({ timeout: 10_000 });
    const stored: any = await worker.evaluate(() => chrome.storage.local.get('tabi_llm'));
    check('the provider and key are saved', stored.tabi_llm?.provider === 'groq' && stored.tabi_llm?.keys?.groq === KEY, JSON.stringify(stored.tabi_llm?.provider));
    await settings.reload();
    await settings.getByLabel('Saved API key').waitFor({ timeout: 5_000 });
    check('the key shows masked, never in full', (await settings.getByLabel('Saved API key').innerText()).includes('4f2a') && !(await settings.content()).includes(KEY));

    // 2. Two backups, then the second moved up
    for (const [value, provider, key, model] of [['openrouter', 'OpenRouter', 'sk-or-test-91aa', 'deepseek/deepseek-chat'], ['ollama', 'Ollama (local)', '', 'llama3.1:8b']]) {
      await settings.getByRole('button', { name: 'Add a backup' }).click();
      const editor = settings.locator('[data-testid="backups"]');
      await editor.getByRole('combobox', { name: 'Provider' }).selectOption(value);
      if (key) await editor.getByRole('textbox', { name: 'API key' }).fill(key);
      await editor.getByRole('combobox', { name: 'Model' }).fill(model);
      await editor.getByRole('button', { name: 'Save as backup' }).click();
      await editor.getByRole('list', { name: 'Backup providers' }).getByText(provider, { exact: true }).waitFor({ timeout: 10_000 });
    }
    await settings.getByRole('button', { name: 'More for Ollama (local)' }).click();
    await settings.getByRole('menuitem', { name: 'Move up' }).click();
    await settings.waitForTimeout(500);
    const after: any = await worker.evaluate(() => chrome.storage.local.get('tabi_llm'));
    check('backups are added, and the order changes', JSON.stringify(after.tabi_llm?.fallbacks) === '["ollama","openrouter"]', JSON.stringify(after.tabi_llm?.fallbacks));

    // 3. Safety: turning off "Ask before buying" warns, and is saved
    await settings.getByRole('link', { name: 'Safety & sites' }).click();
    await settings.getByRole('switch', { name: 'Ask before buying, sending or deleting' }).click();
    const warning = await settings.getByText('Tabi won’t ask first.').isVisible();
    const prefs: any = await worker.evaluate(() => chrome.storage.local.get('tabi_prefs'));
    check('turning off confirmations shows a warning and saves', warning && prefs.tabi_prefs?.confirmRisky === false, JSON.stringify(prefs.tabi_prefs));
    check('the section is in the address, to link to', settings.url().endsWith('#safety'), settings.url());

    // 4. A schedule, added with the form
    await worker.evaluate(() => chrome.storage.local.set({ tabi_workflows: [{ name: 'order-coffee', goal: 'Order coffee', startUrl: 'https://example.com/', steps: [{ action: { action: 'wait' } }] }] }));
    await settings.getByRole('link', { name: 'Schedules' }).click();
    await settings.getByRole('combobox', { name: 'What to run' }).selectOption('workflow:order-coffee');
    await settings.getByRole('radio', { name: 'Weekly' }).click();
    await settings.getByRole('combobox', { name: 'Day' }).selectOption({ label: 'Friday' });
    await settings.getByRole('button', { name: 'Add schedule' }).click();
    await settings.getByText('Weekly · Fri 9:00').waitFor({ timeout: 5_000 }).catch(() => {});
    const schedules: any = await worker.evaluate(() => chrome.storage.local.get('tabi_schedules'));
    const s = schedules.tabi_schedules?.[0];
    check('a schedule is added from the form', s?.name === 'order-coffee' && s?.frequency === 'weekly' && s?.weekday === 5 && await settings.getByText('Weekly · Fri 9:00').isVisible(), JSON.stringify(s));

    // 5. From the side panel: Settings opens at a section, in the tab already open
    const page = await context.newPage();
    await page.goto(`${fixtures.baseUrl}/search.html`);
    const panel = await openPanel(context, worker, page);
    await panel.evaluate(() => chrome.runtime.sendMessage({ action: 'OPEN_SETTINGS', payload: { section: 'agent' } }));
    await settings.waitForURL(/#agent$/, { timeout: 5_000 }).catch(() => {});
    const open = context.pages().filter((p) => p.url().includes('/options.html')).length;
    check('the panel opens Settings at a section, reusing its tab', settings.url().endsWith('#agent') && open === 1
      && await settings.getByRole('heading', { name: 'Agent' }).isVisible(), settings.url());

    // 6. The key that opens Tabi, as the browser assigned it, in Settings and the panel
    const assigned = await worker.evaluate(() => chrome.commands.getAll().then((c: any[]) => c.find((x) => x.name === '_execute_action')?.shortcut ?? ''));
    await settings.getByRole('link', { name: 'Appearance & keyboard' }).click();
    const shown = await settings.getByTestId('open-shortcut').innerText({ timeout: 5_000 }).catch(() => '');
    const footer = await panel.locator('footer').innerText();
    check('the open-Tabi shortcut is Alt+T, and Settings and the panel show it',
      assigned === 'Alt+T' && shown === 'Alt+T' && footer.includes('Alt+T') && !footer.includes('Ctrl+G'), `browser: "${assigned}", Settings: "${shown}"`);
    const askKey = await settings.getByTestId('ask-shortcut').innerText({ timeout: 5_000 }).catch(() => '');
    check('the ask-about-selection shortcut is Alt+J, and Settings shows it', askKey === 'Alt+J', askKey);

    // 7. The autofill profile: starts empty, takes details of the user's own, keeps their order
    await settings.getByRole('link', { name: 'Autofill profile' }).click();
    const rows = settings.getByTestId('profile-row');
    await rows.first().waitFor({ timeout: 5_000 });
    const answers = await rows.locator('textarea').evaluateAll((boxes) => boxes.map((b) => (b as HTMLTextAreaElement).value));
    check('a new profile has the common details, all empty (no made-up person)', answers.length === 8 && answers.every((a) => a === ''), JSON.stringify(answers));
    await settings.getByRole('textbox', { name: 'Mobile number' }).fill('+91 98765 43210');
    await settings.getByRole('button', { name: 'Date of birth' }).click();
    await settings.getByRole('textbox', { name: 'Date of birth' }).fill('15 March 2004');
    await settings.getByRole('button', { name: 'Add a detail' }).click();
    await rows.last().getByRole('textbox', { name: 'Detail' }).fill('Roll number');
    await settings.getByRole('textbox', { name: 'Roll number' }).fill('22CSE1043');
    await settings.getByRole('button', { name: 'Move Roll number up' }).click();
    await settings.getByRole('button', { name: 'Remove Country' }).click();
    await settings.getByRole('button', { name: 'Add a detail' }).click();
    await rows.last().getByRole('textbox', { name: 'Answer' }).fill('an answer with no name');
    await settings.getByRole('button', { name: 'Save profile' }).click();
    const refused = await settings.getByText('Give every answer a name').isVisible({ timeout: 3_000 }).catch(() => false);
    await rows.last().getByRole('button', { name: /^Remove/ }).click();
    await settings.getByRole('button', { name: 'Save profile' }).click();
    await settings.getByText('Saved on this device.').waitFor({ timeout: 5_000 });
    const profile: any[] = (await worker.evaluate(() => chrome.storage.local.get('tabi_profile'))).tabi_profile ?? [];
    const labels = profile.map((f) => f.label);
    check('an answer without a name is refused', refused);
    check('details are added, moved, removed and saved in order',
      labels.join('|') === 'Full name|Email|Mobile number|Street address|City|State / Province|Postal code|Roll number|Date of birth'
      && profile.find((f) => f.label === 'Roll number')?.value === '22CSE1043' && profile.find((f) => f.label === 'Mobile number')?.value === '+91 98765 43210',
      JSON.stringify(profile));
    await settings.reload();
    check('the profile is there after a reload', await settings.getByRole('textbox', { name: 'Roll number' }).inputValue({ timeout: 5_000 }).catch(() => '') === '22CSE1043');

    // 8. The panel's model menu: the providers set up, main first; picking a backup swaps the two
    await panel.getByRole('button', { name: /^Model: Groq/ }).click();
    const menu = panel.getByRole('menu', { name: 'Model' });
    const listed = (await menu.getByRole('menuitemradio').allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim());
    check('the model menu lists the main provider and the backups, in order',
      listed.length === 3 && /^Groq .*Main$/.test(listed[0]) && /^Ollama.*Backup 1$/.test(listed[1]) && /^OpenRouter.*Backup 2$/.test(listed[2]), JSON.stringify(listed));
    await panel.keyboard.press('Escape');
    check('Escape closes the model menu', !(await menu.isVisible()));
    await panel.getByRole('button', { name: /^Model: Groq/ }).click();
    await menu.getByRole('menuitemradio', { name: /OpenRouter/ }).click();
    await panel.getByRole('button', { name: /^Model: OpenRouter/ }).waitFor({ timeout: 5_000 }).catch(() => {});
    const swapped: any = (await worker.evaluate(() => chrome.storage.local.get('tabi_llm'))).tabi_llm;
    check('picking a backup makes it the main model, and the old main takes its place',
      swapped?.provider === 'openrouter' && JSON.stringify(swapped?.fallbacks) === '["ollama","groq"]'
      && await panel.getByRole('button', { name: /^Model: OpenRouter/ }).isVisible(), JSON.stringify({ provider: swapped?.provider, fallbacks: swapped?.fallbacks }));
    await panel.getByRole('button', { name: /^Model: OpenRouter/ }).click();
    await menu.getByRole('menuitem', { name: 'Add a provider or change models' }).click();
    await settings.waitForURL(/#models$/, { timeout: 5_000 }).catch(() => {});
    check('the menu’s last item opens Settings at Models & keys', settings.url().endsWith('#models'), settings.url());

    // 9. The home screen: no list of commands on a page (they're behind /), a welcome elsewhere
    const idle = panel.getByTestId('idle');
    check('on a page, the home screen points to / instead of listing commands',
      await idle.getByRole('heading', { name: 'What should Tabi do here?' }).isVisible() && !(await idle.getByText('Summarize this page').count()));
    await idle.getByRole('button', { name: 'Open the / menu' }).click();
    const picker = panel.getByRole('listbox');
    check('its / opens the menu of commands and routines', await picker.isVisible({ timeout: 3_000 }).catch(() => false)
      && (await picker.innerText()).includes('Autofill') && await panel.getByRole('textbox', { name: /Ask about this page/ }).inputValue() === '/');
    await panel.getByRole('textbox', { name: /Ask about this page/ }).fill('');
    await page.goto('about:blank');
    await idle.getByRole('heading', { name: 'Hi, I’m Tabi.' }).waitFor({ timeout: 5_000 }).catch(() => {});
    const welcome = await idle.innerText().catch(() => '');
    check('off the web, it welcomes you and shows the keys to know', welcome.includes('Hi, I’m Tabi.') && welcome.includes('Alt+T') && welcome.includes('Alt+J'), welcome.slice(0, 200));
  } finally {
    await context.close().catch(() => {});
    await fixtures.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
}

main()
  .then(() => {
    console.log(failures ? `\n${failures} check(s) failed.` : '\nAll settings checks passed.');
    process.exit(failures ? 1 : 0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
