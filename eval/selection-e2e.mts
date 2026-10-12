// End-to-end check of the toolbar on selected text (lib/dom/selectionToolbar.ts).
// Reading: selecting a word shows Ask, Explain, Translate, Copy; Explain
// streams an answer into a small chat window, from the selection and its
// passage; a follow-up continues the conversation; Ask takes a typed
// question; "Continue in panel" puts the conversation in the side panel; the
// shortcut (Alt+J) with nothing selected asks about the page. Writing: in a
// text box or an editor it offers Improve, Fix grammar..., and Replace puts
// the rewrite back. Never in password fields; it stays out of text boxes, off a
// site, or everywhere when told; and the agent's view of the page never
// includes it. A fake model answers (streamed); no real model or API key.
//
// Its shadow root is closed, so the page (and Playwright) can't see inside:
// the check finds its parts through the DevTools protocol, which can, and
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

/** The fake model's answer to a conversation. */
function reply(messages: { role: string; content: string }[]): string {
  const system = messages[0]?.content ?? '';
  const last = messages.at(-1)?.content ?? '';
  if (last === 'And at night?') return 'At night, plants **rest** and use stored sugar.';
  if (system.includes('Show it as code')) return 'Like this:\n\n```cpp\nint light = sun();\nreturn light * 2;\n```\n\nThat doubles it.';
  if (system.includes('Explain what the selected text means')) return '**Photosynthesis** is how plants turn light into chemical energy.';
  if (system.includes('Fix spelling, grammar')) return 'The plant needs sunlight to grow.';
  if (system.includes('Improve the writing')) return 'I have an idea about leaves.';
  if (system.includes('asking about the web page')) return 'It explains how **photosynthesis** works.';
  return 'It happens in the **chloroplasts**.';
}

/** A streamed answer (server-sent events), in two pieces. */
function streamed(text: string) {
  const half = Math.ceil(text.length / 2);
  const event = (content: string) => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;
  return { status: 200, contentType: 'text/event-stream', body: `${event(text.slice(0, half))}${event(text.slice(half))}data: [DONE]\n\n` };
}

interface DomNode { nodeId: number; nodeName: string; attributes?: string[]; children?: DomNode[]; shadowRoots?: DomNode[] }

/** A node anywhere in the page, closed shadow roots included, by tag and attribute. */
async function findNode(cdp: CDPSession, tag: string, attr: string, value: string): Promise<number | null> {
  const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true }) as { root: DomNode };
  const walk = (node: DomNode): number | null => {
    const attrs = node.attributes ?? [];
    for (let i = 0; i < attrs.length; i += 2) {
      if (node.nodeName === tag && attrs[i] === attr && (attrs[i + 1] === value || attrs[i + 1].split(' ').includes(value))) return node.nodeId;
    }
    for (const child of [...(node.shadowRoots ?? []), ...(node.children ?? [])]) {
      const found = walk(child);
      if (found) return found;
    }
    return null;
  };
  return walk(root);
}

/** Click a part of the toolbar or window, as a user would. */
async function click(page: Page, cdp: CDPSession, tag: string, attr: string, value: string): Promise<boolean> {
  const id = await findNode(cdp, tag, attr, value);
  if (!id) return false;
  const box = await cdp.send('DOM.getBoxModel', { nodeId: id }).catch(() => null) as { model: { content: number[] } } | null;
  if (!box) return false;
  const q = box.model.content;
  await page.mouse.click((q[0] + q[4]) / 2, (q[1] + q[5]) / 2);
  return true;
}
const clickButton = (page: Page, cdp: CDPSession, action: string) => click(page, cdp, 'BUTTON', 'data-action', action);

/** The text of a part of it: the bar, or the window. */
async function partText(cdp: CDPSession, cls: 'win' | 'bar'): Promise<string> {
  const id = await findNode(cdp, 'DIV', 'class', cls);
  if (!id) return '';
  const { outerHTML } = await cdp.send('DOM.getOuterHTML', { nodeId: id }) as { outerHTML: string };
  return outerHTML.replace(/<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

const state = (page: Page) => page.evaluate(() => [...document.querySelectorAll('tabi-selection')].map((h) => h.getAttribute('data-state')).join(',') || 'none');

async function waitState(page: Page, want: string, ms = 5000): Promise<string> {
  let now = await state(page);
  for (let i = 0; i < ms / 100 && now !== want; i++) {
    await page.waitForTimeout(100);
    now = await state(page);
  }
  return now;
}

/** Select like a user: double-click a word, or Ctrl+A in a text box or editor. */
async function selectWord(page: Page, selector: string): Promise<void> {
  await page.mouse.click(5, 5); // clear any selection and close the toolbar
  await page.waitForTimeout(100);
  await page.dblclick(selector);
}
async function selectAllIn(page: Page, selector: string): Promise<void> {
  await page.mouse.click(5, 5);
  await page.waitForTimeout(100);
  await page.click(selector);
  await page.keyboard.press('Control+A');
}

async function main(): Promise<void> {
  if (!fs.existsSync(path.join(EXTENSION_DIR, 'manifest.json'))) throw new Error('Build the extension first: npm run build');
  const fixtures = await startFixtureServer();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tabi-selection-e2e-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless: !headed,
    viewport: { width: 1200, height: 900 },
    args: [`--disable-extensions-except=${EXTENSION_DIR}`, `--load-extension=${EXTENSION_DIR}`],
  });
  try {
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker', { timeout: 15_000 });
    await worker.evaluate((base) => chrome.storage.local.set({
      tabi_llm: { provider: 'custom', models: { custom: 'mock' }, keys: { custom: 'k' }, customBaseUrl: base },
    }), MODEL);

    const requests: { stream: boolean; messages: { role: string; content: string }[] }[] = [];
    await context.route(`${MODEL}/**`, async (route: Route) => {
      const body = route.request().postDataJSON() ?? {};
      requests.push({ stream: !!body.stream, messages: body.messages ?? [] });
      return route.fulfill(streamed(reply(body.messages ?? [])));
    });
    const lastPrompt = () => (requests.at(-1)?.messages ?? []).map((m) => m.content).join('\n');

    const page = await context.newPage();
    await page.goto(`${fixtures.baseUrl}/article.html`);
    await page.waitForTimeout(500);
    const cdp = await context.newCDPSession(page);
    const tabId = await tabIdOf(worker, page);

    // 1. Reading: selecting a word shows the bar; nothing is sent yet
    await selectWord(page, '#term');
    check('selecting a word shows the toolbar', await waitState(page, 'bar') === 'bar', await state(page));
    const actions = await Promise.all(['ask', 'explain', 'translate', 'copy', 'more'].map((a) => findNode(cdp, 'BUTTON', 'data-action', a)));
    check('with Ask, Explain, Translate, Copy and More', actions.every(Boolean) && (await partText(cdp, 'bar')).includes('Ask'));
    check('nothing goes to the AI provider before a button is pressed', requests.length === 0, `${requests.length} calls`);

    // 2. Explain: a streamed answer in a chat window, from the word and its passage
    await clickButton(page, cdp, 'explain');
    check('Explain answers in a chat window beside the text', await waitState(page, 'answer') === 'answer', await state(page));
    check('the answer is streamed, and shown formatted', requests[0]?.stream === true && (await partText(cdp, 'win')).includes('Photosynthesis is how plants turn light into chemical energy'), await partText(cdp, 'win'));
    check('the model got the selection and the passage around it',
      lastPrompt().includes('"""photosynthesis"""') && lastPrompt().includes('inside their chloroplasts') && lastPrompt().includes('How plants make food'));

    // 3. A follow-up continues the conversation
    await click(page, cdp, 'TEXTAREA', 'aria-label', 'Ask a follow-up');
    await page.keyboard.type('And at night?');
    await page.keyboard.press('Enter');
    await waitState(page, 'streaming', 1000);
    check('a follow-up gets its own answer in the window', await waitState(page, 'answer') === 'answer' && (await partText(cdp, 'win')).includes('At night, plants rest'));
    const turns = requests.at(-1)!.messages.slice(2);
    check('with the conversation so far', turns.length === 2 && turns[0].role === 'assistant' && turns[0].content.startsWith('**Photosynthesis**') && turns[1].content === 'And at night?', JSON.stringify(turns).slice(0, 200));

    // 4. The agent's view of the page never includes it
    const snapshot: any = await worker.evaluate((id: number) => chrome.tabs.sendMessage(id, { action: 'AGENT_SNAPSHOT' }), tabId);
    check('the agent’s snapshot of the page leaves it out', !!snapshot?.text && !snapshot.text.includes('Ask a follow-up') && !snapshot.text.includes('chemical energy'), snapshot?.text?.slice(0, 200));

    // 5. Continue in panel opens Chrome's side panel, which takes the conversation.
    // Playwright can't see inside the real side panel, so then, with it switched off, the
    // conversation waits for a panel opened later (within 30s): the test's own panel window.
    const sidePanels = () => worker.evaluate(() => chrome.runtime.getContexts({ contextTypes: ['SIDE_PANEL'] }).then((c: any[]) => c.length));
    await clickButton(page, cdp, 'continue');
    let open = 0;
    for (let i = 0; i < 30 && !open; i++) { await page.waitForTimeout(100); open = await sidePanels(); }
    check('Continue in panel opens the side panel and closes the window', open > 0 && await state(page) === 'none', `${open} side panel(s)`);
    await worker.evaluate(() => chrome.sidePanel.setOptions({ enabled: false }));
    for (let i = 0; i < 30 && open; i++) { await page.waitForTimeout(100); open = await sidePanels(); }
    await selectWord(page, '#term');
    await waitState(page, 'bar');
    await clickButton(page, cdp, 'explain');
    await waitState(page, 'answer');
    await click(page, cdp, 'TEXTAREA', 'aria-label', 'Ask a follow-up');
    await page.keyboard.type('And at night?');
    await page.keyboard.press('Enter');
    await waitState(page, 'answer');
    await clickButton(page, cdp, 'continue');
    const panel = await openPanel(context, worker, page);
    const answers = panel.locator('[data-testid="answers"]');
    await answers.getByText('At night, plants rest').waitFor({ timeout: 5_000 }).catch(() => {});
    const inPanel = await answers.innerText().catch(() => '');
    check('the panel shows the whole conversation', inPanel.includes('Explain: “photosynthesis”') && inPanel.includes('Photosynthesis is how plants turn light')
      && inPanel.includes('And at night?') && inPanel.includes('At night, plants rest'), inPanel.slice(0, 300));
    await panel.close();
    await worker.evaluate(() => chrome.sidePanel.setOptions({ enabled: true }));
    await page.bringToFront();

    // 6. Ask: a typed question; Escape closes
    await selectWord(page, '#term');
    await waitState(page, 'bar');
    await clickButton(page, cdp, 'ask');
    await page.keyboard.type('Where does it happen?');
    await page.keyboard.press('Enter');
    check('Ask answers a typed question', await waitState(page, 'answer') === 'answer' && (await partText(cdp, 'win')).includes('It happens in the chloroplasts'));
    check('with the question in the prompt', lastPrompt().includes('Where does it happen?') && lastPrompt().includes('"""photosynthesis"""'));
    await page.keyboard.press('Escape');
    check('Escape closes it', await waitState(page, 'none') === 'none');

    // 6b. Code in an answer: its own Copy copies just the code; the question box has no scrollbar while it fits
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: fixtures.baseUrl });
    await selectWord(page, '#term');
    await waitState(page, 'bar');
    await clickButton(page, cdp, 'ask');
    await page.keyboard.type('Show it as code');
    await page.keyboard.press('Enter');
    await waitState(page, 'answer');
    const codeWin = await partText(cdp, 'win');
    await click(page, cdp, 'BUTTON', 'data-copy-code', '');
    await page.waitForTimeout(200);
    const copied = await page.evaluate(() => navigator.clipboard.readText()).catch(() => '');
    check('a code block says its language, and its Copy copies just the code', codeWin.includes('cpp') && copied.replace(/\r\n/g, '\n') === 'int light = sun();\nreturn light * 2;', JSON.stringify(copied));
    await cdp.send('CSS.enable').catch(() => {});
    const textarea = await findNode(cdp, 'TEXTAREA', 'aria-label', 'Ask a follow-up');
    const style = textarea ? await cdp.send('CSS.getComputedStyleForNode', { nodeId: textarea }).catch(() => null) as { computedStyle: { name: string; value: string }[] } | null : null;
    const overflow = style?.computedStyle.find((p) => p.name === 'overflow-y')?.value;
    check('the question box has no scrollbar while its text fits', overflow === 'hidden', String(overflow));

    // 6c. Pinned, it stays open on a click elsewhere; unpinned, it closes
    await clickButton(page, cdp, 'pin');
    await page.mouse.click(5, 5);
    await page.waitForTimeout(300);
    const pinnedState = await state(page);
    await clickButton(page, cdp, 'pin');
    await page.mouse.click(5, 5);
    await page.waitForTimeout(300);
    check('pinned, the window stays open when you click elsewhere; unpinned, it closes', pinnedState === 'answer' && await state(page) === 'none', `${pinnedState}, then ${await state(page)}`);

    // 7. The shortcut (Alt+J) with nothing selected asks about the page
    await page.mouse.click(5, 5);
    await worker.evaluate((id: number) => chrome.tabs.sendMessage(id, { action: 'SELECTION_SHORTCUT' }), tabId);
    await waitState(page, 'window');
    await page.keyboard.type('What is this page about?');
    await page.keyboard.press('Enter');
    check('the shortcut with nothing selected asks about the page', await waitState(page, 'answer') === 'answer'
      && (await partText(cdp, 'win')).includes('Ask about this page') && lastPrompt().includes('PAGE TEXT:') && lastPrompt().includes('Calvin cycle'));
    await page.keyboard.press('Escape');

    // 8. Writing: in a text box, fix the grammar and replace the selection
    await selectAllIn(page, '#draft');
    check('selecting text in a text box shows the writing tools', await waitState(page, 'bar-write') === 'bar-write', await state(page));
    check('Improve, Fix grammar and Tone', (await partText(cdp, 'bar')).includes('Improve') && (await partText(cdp, 'bar')).includes('Fix grammar') && (await partText(cdp, 'bar')).includes('Tone'));
    await clickButton(page, cdp, 'grammar');
    await waitState(page, 'answer');
    check('the rewrite is the text alone', lastPrompt().includes('Reply with ONLY the new text') && lastPrompt().includes('"""teh plant need sunlight to grow"""'));
    await clickButton(page, cdp, 'replace');
    await page.waitForTimeout(200);
    check('Replace puts it in the text box', await page.inputValue('#draft') === 'The plant needs sunlight to grow.' && await state(page) === 'none', await page.inputValue('#draft'));

    // 9. In an editor (contenteditable), Improve and replace
    await selectAllIn(page, '#editor');
    await waitState(page, 'bar-write');
    await clickButton(page, cdp, 'improve');
    await waitState(page, 'answer');
    await clickButton(page, cdp, 'replace');
    await page.waitForTimeout(200);
    const edited = (await page.innerText('#editor')).trim();
    check('in an editor too', edited === 'I have an idea about leaves.', edited);

    // 10. Never in a password field
    await selectAllIn(page, '#pw');
    await page.waitForTimeout(300);
    check('never in a password field', await state(page) === 'none', await state(page));

    // 11. "Don't show in text boxes" keeps reading on
    await selectAllIn(page, '#draft');
    await waitState(page, 'bar-write');
    await clickButton(page, cdp, 'more');
    await clickButton(page, cdp, 'off-writing');
    await page.waitForTimeout(300);
    await selectAllIn(page, '#draft');
    await page.waitForTimeout(300);
    const offInBoxes = await state(page);
    await selectWord(page, '#term');
    check('“Don’t show in text boxes” turns off only the writing tools', offInBoxes === 'none' && await waitState(page, 'bar') === 'bar', `${offInBoxes}, then ${await state(page)}`);

    // 12. "Don't show on this site", from its menu
    await clickButton(page, cdp, 'more');
    await clickButton(page, cdp, 'hide-site');
    await page.waitForTimeout(300);
    const prefs: any = (await worker.evaluate(() => chrome.storage.local.get('tabi_selection')) as any).tabi_selection;
    await selectWord(page, '#term');
    await page.waitForTimeout(300);
    check('“Don’t show on this site” keeps it off here', prefs?.hiddenOn?.includes('127.0.0.1') && await state(page) === 'none', JSON.stringify(prefs));

    // 13. Turned off everywhere (from Settings), then on again
    await worker.evaluate(() => chrome.storage.local.set({ tabi_selection: { enabled: false, writing: true, hiddenOn: [] } }));
    await page.waitForTimeout(200);
    await selectWord(page, '#term');
    await page.waitForTimeout(300);
    check('turned off, it doesn’t show', await state(page) === 'none');
    await worker.evaluate(() => chrome.storage.local.set({ tabi_selection: { enabled: true, writing: true, hiddenOn: [] } }));
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
