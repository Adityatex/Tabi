// eval/selection-e2e.mts
// End-to-end check of the toolbar on selected text (lib/dom/selectionToolbar.ts).
// Selecting a word shows it; Explain answers in a card beside the text, from
// the selection and its passage; Ask takes a typed question; "Continue in
// panel" puts the question and answer in the side panel. It never shows for
// text in a field, stays off a site hidden from its own menu and everywhere
// when turned off, and the agent's view of the page never includes it.
// A fake model answers; no real model or API key is involved.
//
// Its shadow root is closed, so the page (and Playwright) can't see inside:
// the check finds its buttons through the DevTools protocol, which can, and
// clicks them with the mouse like a user.
//
//   npm run build && npm run eval:selection   (-- --headed to watch)

import { chromium, type CDPSession, type Page, type Route } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFixtureServer } from './server.mts';
import { openPanel, tabIdOf } from './panel.mts';

declare const chrome: any;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXTENSION_DIR = path.join(ROOT, '.output', 'chrome-mv3');
const MODEL = 'https://mock-llm.test/v1';
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

interface DomNode { nodeId: number; nodeName: string; attributes?: string[]; children?: DomNode[]; shadowRoots?: DomNode[] }

/** A node anywhere in the page, closed shadow roots included, by tag and attribute. */
async function findNode(cdp: CDPSession, tag: string, attr: string, value: string): Promise<number | null> {
  const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true }) as { root: DomNode };
  const walk = (node: DomNode): number | null => {
    const attrs = node.attributes ?? [];
    for (let i = 0; i < attrs.length; i += 2) {
      if (node.nodeName === tag && attrs[i] === attr && attrs[i + 1].split(' ').includes(value)) return node.nodeId;
    }
    for (const child of [...(node.shadowRoots ?? []), ...(node.children ?? [])]) {
      const found = walk(child);
      if (found) return found;
    }
    return null;
  };
  return walk(root);
}

/** Click a toolbar button (data-action), as a user would. */
async function clickButton(page: Page, cdp: CDPSession, action: string): Promise<boolean> {
  const id = await findNode(cdp, 'BUTTON', 'data-action', action);
  if (!id) return false;
  const box = await cdp.send('DOM.getBoxModel', { nodeId: id }).catch(() => null) as { model: { content: number[] } } | null;
  if (!box) return false;
  const q = box.model.content;
  await page.mouse.click((q[0] + q[4]) / 2, (q[1] + q[5]) / 2);
  return true;
}

/** The toolbar's text: its card's, or the bar's. */
async function toolbarText(cdp: CDPSession, cls: 'card' | 'bar'): Promise<string> {
  const id = await findNode(cdp, 'DIV', 'class', cls);
  if (!id) return '';
  const { outerHTML } = await cdp.send('DOM.getOuterHTML', { nodeId: id }) as { outerHTML: string };
  return outerHTML.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

const state = (page: Page) => page.evaluate(() => document.querySelector('tabi-selection')?.getAttribute('data-state') ?? 'none');

async function waitState(page: Page, want: string, ms = 5000): Promise<string> {
  let now = await state(page);
  for (let i = 0; i < ms / 100 && now !== want; i++) {
    await page.waitForTimeout(100);
    now = await state(page);
  }
  return now;
}

/** Select a word like a user: a double-click on it. */
async function selectWord(page: Page, selector: string): Promise<void> {
  await page.mouse.click(5, 5); // clear any selection and close the toolbar
  await page.waitForTimeout(100);
  await page.dblclick(selector);
}

async function main(): Promise<void> {
  if (!fs.existsSync(path.join(EXTENSION_DIR, 'manifest.json'))) throw new Error('Build the extension first: npm run build');
  const fixtures = await startFixtureServer();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tabi-selection-e2e-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless: !headed,
    viewport: { width: 1200, height: 800 },
    args: [`--disable-extensions-except=${EXTENSION_DIR}`, `--load-extension=${EXTENSION_DIR}`],
  });
  try {
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker', { timeout: 15_000 });
    await worker.evaluate((base) => chrome.storage.local.set({
      tabi_llm: { provider: 'custom', models: { custom: 'mock' }, keys: { custom: 'k' }, customBaseUrl: base },
    }), MODEL);

    const prompts: string[] = [];
    await context.route(`${MODEL}/**`, async (route: Route) => {
      const messages = route.request().postDataJSON()?.messages ?? [];
      const prompt = messages.map((m: any) => m.content).join('\n');
      prompts.push(prompt);
      const reply = prompt.includes('Explain what the selected text means')
        ? '**Photosynthesis** is how plants turn light into chemical energy.'
        : 'It happens in the **chloroplasts**.';
      return route.fulfill(answer(reply));
    });

    const page = await context.newPage();
    await page.goto(`${fixtures.baseUrl}/article.html`);
    await page.waitForTimeout(500);
    const cdp = await context.newCDPSession(page);

    // 1. Selecting a word shows the bar; nothing is sent yet
    await selectWord(page, '#term');
    check('selecting a word shows the toolbar', await waitState(page, 'bar') === 'bar', await state(page));
    const bar = await toolbarText(cdp, 'bar');
    check('with Ask, Explain and Translate (Summarize only for a passage)', /Ask/.test(bar) && /Explain/.test(bar) && /Translate/.test(bar), bar);
    check('nothing goes to the AI provider before a button is pressed', prompts.length === 0, `${prompts.length} calls`);

    // 2. Explain: an answer in a card, from the word and its passage
    await clickButton(page, cdp, 'explain');
    check('Explain answers in a card beside the text', await waitState(page, 'answer') === 'answer', await state(page));
    const card = await toolbarText(cdp, 'card');
    check('the card shows the answer, formatted', card.includes('Photosynthesis is how plants turn light into chemical energy'), card);
    check('the model got the selection and the passage around it',
      prompts.length === 1 && prompts[0].includes('"""photosynthesis"""') && prompts[0].includes('inside their chloroplasts') && prompts[0].includes('How plants make food'), prompts[0]?.slice(-400));

    // 3. The agent's view of the page never includes it
    const tabId = await tabIdOf(worker, page);
    const snapshot: any = await worker.evaluate((id: number) => chrome.tabs.sendMessage(id, { action: 'AGENT_SNAPSHOT' }), tabId);
    check('the agent’s snapshot of the page leaves it out', !!snapshot?.text && !snapshot.text.includes('Continue in panel') && !snapshot.text.includes('chemical energy'), snapshot?.text?.slice(0, 200));

    // 4. Continue in panel opens Chrome's side panel, which takes the question and answer.
    // Playwright can't see inside the real side panel, so then, with it switched off, the
    // answer waits for a panel opened later (within 30s): the test's own panel window.
    const sidePanels = () => worker.evaluate(() => chrome.runtime.getContexts({ contextTypes: ['SIDE_PANEL'] }).then((c: any[]) => c.length));
    await clickButton(page, cdp, 'continue');
    let open = 0;
    for (let i = 0; i < 30 && !open; i++) { await page.waitForTimeout(100); open = await sidePanels(); }
    check('Continue in panel opens the side panel and closes the card', open > 0 && await state(page) === 'none', `${open} side panel(s)`);
    // Close it (switched off), so the next answer waits for the test's panel
    await worker.evaluate(() => chrome.sidePanel.setOptions({ enabled: false }));
    for (let i = 0; i < 30 && open; i++) { await page.waitForTimeout(100); open = await sidePanels(); }
    await selectWord(page, '#term');
    await waitState(page, 'bar');
    await clickButton(page, cdp, 'explain');
    await waitState(page, 'answer');
    await clickButton(page, cdp, 'continue');
    const panel = await openPanel(context, worker, page);
    const answers = panel.locator('[data-testid="answers"]');
    await answers.getByText('Photosynthesis is how plants turn light into chemical energy').waitFor({ timeout: 5_000 }).catch(() => {});
    const inPanel = await answers.innerText().catch(() => '');
    check('the panel shows the question and answer', inPanel.includes('Explain: “photosynthesis”') && inPanel.includes('Photosynthesis is how plants turn light into chemical energy'), inPanel.slice(0, 200));
    await panel.close();
    await worker.evaluate(() => chrome.sidePanel.setOptions({ enabled: true }));
    await page.bringToFront();

    // 5. Ask: a typed question
    await selectWord(page, '#term');
    await waitState(page, 'bar');
    await clickButton(page, cdp, 'ask');
    await page.keyboard.type('Where does it happen?');
    await page.keyboard.press('Enter');
    check('Ask answers a typed question', await waitState(page, 'answer') === 'answer' && (await toolbarText(cdp, 'card')).includes('It happens in the chloroplasts'));
    check('with the question in the prompt', prompts.at(-1)!.includes('Where does it happen?') && prompts.at(-1)!.includes('"""photosynthesis"""'));
    await page.keyboard.press('Escape');
    check('Escape closes it', await waitState(page, 'none') === 'none');

    // 6. Not for text in a field
    await page.mouse.click(5, 5);
    await page.dblclick('#notes');
    await page.waitForTimeout(300);
    check('it doesn’t show for text in a field', await state(page) === 'none', await state(page));

    // 7. "Don't show on this site", from its menu
    await selectWord(page, '#term');
    await waitState(page, 'bar');
    await clickButton(page, cdp, 'more');
    await clickButton(page, cdp, 'hide-site');
    await page.waitForTimeout(300);
    const prefs: any = (await worker.evaluate(() => chrome.storage.local.get('tabi_selection')) as any).tabi_selection;
    await selectWord(page, '#term');
    await page.waitForTimeout(300);
    check('“Don’t show on this site” keeps it off here', prefs?.hiddenOn?.includes('127.0.0.1') && await state(page) === 'none', JSON.stringify(prefs));

    // 8. Turned off everywhere (from Settings)
    await worker.evaluate(() => chrome.storage.local.set({ tabi_selection: { enabled: false, hiddenOn: [] } }));
    await page.waitForTimeout(200);
    await selectWord(page, '#term');
    await page.waitForTimeout(300);
    check('turned off, it doesn’t show', await state(page) === 'none');
    await worker.evaluate(() => chrome.storage.local.set({ tabi_selection: { enabled: true, hiddenOn: [] } }));
    await page.waitForTimeout(200);
    await selectWord(page, '#term');
    check('turned on again, it shows straight away (no reload)', await waitState(page, 'bar') === 'bar');
  } finally {
    await context.close().catch(() => {});
    await fixtures.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
}

main()
  .then(() => {
    console.log(failures ? `\n${failures} check(s) failed.` : '\nAll selection toolbar checks passed.');
    process.exit(failures ? 1 : 0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
