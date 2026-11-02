// End-to-end check of Sign in with ChatGPT: the real extension in Chromium,
// with OpenAI's sign-in, token and Responses servers played by the test.
// A new user picks "Continue with ChatGPT" on the first-run screen, signs in
// in the window that opens (OpenAI sends it back to 127.0.0.1, where Tabi reads
// the code), and runs a task on their plan. The fake server checks PKCE and
// signs real ID tokens. Then: the token is refreshed when it runs out, the
// welcome and usage link show in Settings, no token ever reaches a page,
// closing the window cancels, and signing out revokes the refresh token.
//
//   npm run build && npm run eval:chatgpt   (-- --headed to watch)

import { chromium, type Page, type Route } from 'playwright';
import { createHash, webcrypto } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFixtureServer } from './server.mts';
import { extensionId, openPanel, runState, sendTask } from './panel.mts';

declare const chrome: any;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXTENSION_DIR = path.join(ROOT, '.output', 'chrome-mv3');
const headed = process.argv.includes('--headed');
const CLIENT = 'oaiapp_e2e_client';
const subtle = webcrypto.subtle;

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `  — ${detail}`}`);
  if (!ok) failures++;
}

const b64url = (buf: Buffer | Uint8Array) => Buffer.from(buf).toString('base64url');

async function main(): Promise<void> {
  if (!fs.existsSync(path.join(EXTENSION_DIR, 'manifest.json'))) throw new Error('Build the extension first: npm run build');
  const keys = await subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  const jwk = { ...(await subtle.exportKey('jwk', keys.publicKey)), kid: 'e2e' };
  const idToken = async (nonce: string) => {
    const head = b64url(Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'e2e' })));
    const body = b64url(Buffer.from(JSON.stringify({ iss: 'https://auth.openai.com', sub: 'user-ada', aud: CLIENT, email: 'ada@example.com', nonce, exp: Math.floor(Date.now() / 1000) + 3600 })));
    return `${head}.${body}.${b64url(new Uint8Array(await subtle.sign('RSASSA-PKCS1-v1_5', keys.privateKey, Buffer.from(`${head}.${body}`))))}`;
  };

  const fixtures = await startFixtureServer();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tabi-chatgpt-e2e-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless: !headed,
    viewport: { width: 1280, height: 900 },
    args: [`--disable-extensions-except=${EXTENSION_DIR}`, `--load-extension=${EXTENSION_DIR}`],
  });

  // ---- OpenAI's auth server, played by the test
  const authorized: URLSearchParams[] = [];
  const grants: URLSearchParams[] = [];
  const revoked: URLSearchParams[] = [];
  let issued = 0;
  await context.route('https://auth.openai.com/**', async (route: Route) => {
    const url = new URL(route.request().url());
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.pathname === '/api/accounts/authorize') {
      authorized.push(url.searchParams);
      const back = `${url.searchParams.get('redirect_uri')}?code=code-${authorized.length}&state=${url.searchParams.get('state')}&client_id=${CLIENT}`;
      return route.fulfill({ contentType: 'text/html', body: `<!doctype html><title>Sign in to ChatGPT</title><h1>Sign in to ChatGPT</h1><p>Tabi wants to use your ChatGPT plan.</p><a id="go" href="${back}">Continue</a>` });
    }
    if (url.pathname === '/.well-known/openid-configuration') return json({ jwks_uri: 'https://auth.openai.com/jwks.json', revocation_endpoint: 'https://auth.openai.com/oauth/revoke' });
    if (url.pathname === '/jwks.json') return json({ keys: [jwk] });
    if (url.pathname === '/oauth/revoke') { revoked.push(new URLSearchParams(route.request().postData() ?? '')); return route.fulfill({ status: 200, body: '' }); }
    if (url.pathname === '/api/accounts/oauth/token') {
      const form = new URLSearchParams(route.request().postData() ?? '');
      grants.push(form);
      if (form.get('grant_type') === 'authorization_code') {
        // As slow as the real one, so Settings checks in while the code is exchanged
        await new Promise((r) => setTimeout(r, 3000));
        // PKCE: the verifier must hash to the challenge the authorize request carried
        const asked = authorized.at(-1)!;
        const challenge = createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url');
        if (challenge !== asked.get('code_challenge') || form.get('redirect_uri') !== asked.get('redirect_uri')) return json({ error: 'invalid_grant' }, 400);
        issued++;
        return json({ access_token: `at-${issued}`, refresh_token: `rt-${issued}`, id_token: await idToken(asked.get('nonce')!), expires_in: 3600, token_type: 'Bearer', scope: 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct' });
      }
      if (form.get('grant_type') === 'refresh_token') {
        issued++;
        return json({ access_token: `at-${issued}`, refresh_token: `rt-${issued}`, expires_in: 3600, token_type: 'Bearer', scope: 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct' });
      }
      return json({ error: 'unsupported_grant_type' }, 400);
    }
    return json({ error: 'not found' }, 404);
  });

  // ---- The Responses API: type the search, then finish
  const bearers: string[] = [];
  const bodies: any[] = [];
  await context.route('https://api.openai.com/v1/**', async (route: Route) => {
    const url = new URL(route.request().url());
    bearers.push(route.request().headers().authorization ?? '');
    if (url.pathname === '/v1/models') {
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data: [{ slug: 'gpt-5.5', display_name: 'GPT-5.5', visibility: 'list' }, { slug: 'hidden-model', visibility: 'hide' }] }) });
    }
    const body = route.request().postDataJSON();
    bodies.push(body);
    const prompt = (body.input ?? []).flatMap((i: any) => i.content ?? []).map((c: any) => c.text ?? '').join('\n');
    const typed = /ACTION HISTORY/.test(prompt);
    const box = /\[(\d+)\] <input[^\n]*Search products/.exec(prompt.split('CURRENT PAGE DOM SNAPSHOT:')[1] ?? '')?.[1] ?? '1';
    const args = typed ? { actions: [{ action: 'done', summary: 'Searched for it.' }] } : { actions: [{ action: 'type', elementId: Number(box), text: 'wireless headphones' }] };
    // A tool call when tools are offered, else the JSON answer the prompt asks for
    const item = body.tools?.length
      ? { type: 'function_call', call_id: `c${bodies.length}`, name: body.tools[0].name, arguments: JSON.stringify(args) }
      : { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify(args) }] };
    const events = [
      { type: 'response.output_item.done', item },
      { type: 'response.completed', response: { status: 'completed', output: [item], usage: { input_tokens: 900, output_tokens: 30 } } },
    ];
    // Not labelled text/event-stream: the real server's stream wasn't either, the first time it was tried
    return route.fulfill({ contentType: 'application/json', body: events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('') });
  });

  /** Click Continue on the fake sign-in page that opens in its own window. */
  const signInWindow = async (): Promise<Page> => {
    // It opens blank, then goes to the sign-in page
    for (let i = 0; i < 150; i++) {
      const popup = context.pages().find((p) => p.url().startsWith('https://auth.openai.com/'));
      if (popup) {
        await popup.waitForLoadState('domcontentloaded');
        return popup;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('The sign-in window never opened');
  };

  try {
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker', { timeout: 15_000 });
    const id = extensionId(worker);
    await worker.evaluate(() => chrome.storage.local.set({ tabi_prefs: { trustedInput: false } }));
    const page = await context.newPage();
    await page.goto(`${fixtures.baseUrl}/search.html`);
    const panel = await openPanel(context, worker, page);

    // 1. First run: Continue with ChatGPT, sign in, done
    const setup = panel.getByTestId('setup-chatgpt');
    await setup.waitFor({ timeout: 10_000 });
    const opening = signInWindow();
    await setup.getByRole('button', { name: 'Continue with ChatGPT' }).click();
    const popup = await opening;
    const asked = authorized[0];
    check('the sign-in registers Tabi with a host ID, PKCE and a 127.0.0.1 callback',
      asked?.get('client_id') === 'dynamic_agent_client' && asked.get('agent_name_hint') === 'Tabi' && /^urn:uuid:[0-9a-f-]{36}$/.test(asked.get('ext_agent_host_id') ?? '')
        && asked.get('code_challenge_method') === 'S256' && /^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/.test(asked.get('redirect_uri') ?? '')
        && (asked.get('scope') ?? '').includes('chatgpt.tokens.use.direct') && asked.get('resource') === 'https://api.openai.com/v1',
      asked ? [...asked.keys()].join(',') : 'no authorize request');
    const closed = popup.waitForEvent('close', { timeout: 15_000 }).then(() => true).catch(() => false);
    await popup.locator('#go').click();
    check('Tabi reads the answer from 127.0.0.1 and closes the sign-in window', await closed);
    // Once the plan is saved the panel goes to its home screen, with the model button showing the plan
    await panel.getByTestId('setup').waitFor({ state: 'detached', timeout: 15_000 }).catch(() => {});
    const header = await panel.locator('header').innerText().catch(() => '');
    check('the first run ends on the home screen, on the ChatGPT plan with a model from it', /ChatGPT plan/.test(header) && /gpt-5\.5/.test(header) && !/hidden-model/.test(header), header);
    check('the code is exchanged with the PKCE verifier, at the issued client', grants[0]?.get('grant_type') === 'authorization_code' && grants[0]?.get('client_id') === CLIENT && issued === 1,
      grants[0] ? Object.fromEntries(grants[0]).grant_type : 'no token request');
    await panel.getByTestId('setup').waitFor({ state: 'detached', timeout: 10_000 }).catch(() => {});

    // 2. A task on the plan
    await sendTask(panel, 'Search this site for wireless headphones');
    await panel.locator('[data-run-status="done"]').waitFor({ timeout: 30_000 }).catch(() => {});
    const state = await runState(panel);
    check('a task runs on the ChatGPT plan', state?.status === 'done' && await page.locator('input[name="q"]').inputValue() === 'wireless headphones', `${state?.status}: ${state?.outcome ?? ''}`);
    check('each request carries the signed-in token, streamed and not stored', bodies.length >= 2 && bodies.every((b) => b.store === false && b.stream === true && b.model === 'gpt-5.5' && !('temperature' in b))
      && bearers.every((b) => b === 'Bearer at-1'), JSON.stringify({ n: bodies.length, bearers: [...new Set(bearers)] }));

    // 3. The token runs out: refreshed before the next request, and the new refresh token kept
    await worker.evaluate(() => chrome.storage.local.get('tabi_chatgpt_auth').then((s: any) => {
      s.tabi_chatgpt_auth.account.expiresAt = Date.now();
      return chrome.storage.local.set(s);
    }));
    const before = bodies.length;
    await panel.getByRole('button', { name: 'Start over' }).click().catch(() => {});
    await sendTask(panel, 'Search this site for wireless headphones');
    for (let i = 0; i < 120 && bodies.length < before + 2; i++) await panel.waitForTimeout(250);
    const stored = await worker.evaluate(() => chrome.storage.local.get('tabi_chatgpt_auth').then((s: any) => s.tabi_chatgpt_auth.account));
    check('an expired token is refreshed once, and the replacement refresh token kept',
      grants.filter((g) => g.get('grant_type') === 'refresh_token').length === 1 && grants.at(-1)?.get('refresh_token') === 'rt-1' && stored?.refreshToken === 'rt-2' && bearers.at(-1) === 'Bearer at-2',
      JSON.stringify({ grants: grants.map((g) => g.get('grant_type')), last: bearers.at(-1) }));

    // 4. Settings: who is signed in, the usage link, and never a token
    const settings = await context.newPage();
    await settings.goto(`chrome-extension://${id}/options.html#models`);
    const accountCard = settings.getByTestId('chatgpt-account');
    await accountCard.waitFor({ timeout: 10_000 });
    const text = await accountCard.innerText();
    check('Settings shows the account, that the plan is in use, and where to manage usage',
      text.includes('ada@example.com') && text.includes('Using ChatGPT plan') && await accountCard.getByRole('link', { name: 'Manage usage' }).getAttribute('href') === 'https://chatgpt.com/settings/usage', text);
    const llm = await worker.evaluate(() => chrome.storage.local.get('tabi_llm').then((s: any) => JSON.stringify(s.tabi_llm)));
    const shown = await settings.evaluate(() => chrome.runtime.sendMessage({ action: 'GET_LLM_SETTINGS' }).then((r: any) => JSON.stringify(r)));
    const pages = (await Promise.all([settings.content(), panel.content(), page.content()])).join('');
    check('no token is in the settings, in what Settings is sent, or on any page',
      !/at-\d|rt-\d|eyJ/.test(llm) && !/at-\d|rt-\d|eyJ/.test(shown) && !/at-\d|rt-\d/.test(pages), `${llm.slice(0, 120)} | ${shown.slice(0, 120)}`);

    // 5. Signing out, and in again
    await accountCard.getByRole('button', { name: 'Sign out' }).click();
    await settings.getByText('Signed out of ChatGPT.').waitFor({ timeout: 10_000 }).catch(() => {});
    check('signing out revokes the refresh token at OpenAI', revoked.length === 1 && revoked[0].get('token') === 'rt-2' && revoked[0].get('token_type_hint') === 'refresh_token' && revoked[0].get('client_id') === CLIENT,
      JSON.stringify(revoked.map((r) => Object.fromEntries(r))));
    const signIn = settings.getByTestId('chatgpt-sign-in');
    const again = signInWindow();
    await signIn.getByRole('button', { name: 'Continue with ChatGPT' }).click();
    const second = await again;
    check('signing in again reuses Tabi’s client for that account', authorized.at(-1)?.get('client_id') === CLIENT && authorized.at(-1)?.get('login_hint') === 'ada@example.com' && !authorized.at(-1)?.has('agent_name_hint'));
    // A real sign-in can take minutes, and Chrome may stop the worker meanwhile
    const cdp = await context.newCDPSession(settings);
    await cdp.send('ServiceWorker.enable');
    await cdp.send('ServiceWorker.stopAllWorkers');
    await new Promise((r) => setTimeout(r, 1000));
    await second.locator('#go').click();
    const back = await settings.getByTestId('chatgpt-account').waitFor({ timeout: 15_000 }).then(() => true).catch(() => false);
    check('a sign-in finishes even when the background stopped while it was open', back, await settings.locator('main').innerText().catch(() => ''));

    // 6. Closing the sign-in window cancels it
    await settings.getByTestId('chatgpt-account').getByRole('button', { name: 'Sign out' }).click();
    await signIn.waitFor({ timeout: 10_000 });
    const third = signInWindow();
    await signIn.getByRole('button', { name: 'Continue with ChatGPT' }).click();
    await (await third).close();
    const cancelled = await signIn.getByText('You closed the sign-in window, so nothing changed.').waitFor({ timeout: 10_000 }).then(() => true).catch(() => false);
    check('closing the sign-in window cancels it and says so', cancelled, await signIn.innerText().catch(() => ''));

    // 7. Signed out: the panel offers the sign-in again, and a task says what to do
    const tab = await context.newPage();
    await tab.goto(`${fixtures.baseUrl}/search.html?tab=2`);
    const fresh = await openPanel(context, worker, tab);
    const offered = await fresh.getByTestId('setup-chatgpt').waitFor({ timeout: 10_000 }).then(() => true).catch(() => false);
    const started = await fresh.evaluate(() => chrome.runtime.sendMessage({ action: 'START_AGENT', payload: { tabId: Number(document.querySelector('[data-panel-tab]')?.getAttribute('data-panel-tab')), goal: 'Search for a laptop stand' } }));
    check('signed out, the panel offers Continue with ChatGPT and a task asks to sign in', offered && !started?.success && /Sign in with ChatGPT/.test(started?.error ?? ''), JSON.stringify(started));
  } finally {
    await context.close().catch(() => {});
    await fixtures.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
}

main()
  .then(() => {
    console.log(failures ? `\n${failures} check(s) failed.` : '\nAll ChatGPT sign-in checks passed.');
    process.exit(failures ? 1 : 0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
