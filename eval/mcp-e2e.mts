// End-to-end check of tabi-mcp, the way an AI app uses it: an MCP client
// starts the tabi-mcp server over stdio, the real extension in real
// Chromium pairs with it, and the tools log in on a fixture page. The script
// plays the AI app, so no model or API key is involved.
//
//   npm run build && npm run build:mcp && npm run eval:mcp   (-- --headed to watch)

import { chromium } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { Client } from '../mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StdioClientTransport } from '../mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js';
import { startFixtureServer } from './server.mts';
import { newToken } from '../mcp/src/protocol.ts';

declare const chrome: any;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXTENSION_DIR = path.join(ROOT, '.output', 'chrome-mv3');
const SERVER = path.join(ROOT, 'mcp', 'dist', 'server.js');
const headed = process.argv.includes('--headed');

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
  });
}

const textOf = (result: any): string => result.content?.map((c: any) => c.text ?? `[${c.type}]`).join('\n') ?? '';
let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `  — ${detail}`}`);
  if (!ok) failures++;
}

async function main(): Promise<void> {
  for (const [file, hint] of [[path.join(EXTENSION_DIR, 'manifest.json'), 'npm run build'], [SERVER, 'npm run build:mcp']]) {
    if (!fs.existsSync(file)) throw new Error(`${file} is missing: run ${hint} first`);
  }
  const token = newToken();
  const port = await freePort();
  const fixtures = await startFixtureServer();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tabi-mcp-e2e-'));

  // 1. The "AI app" starts tabi-mcp, exactly as Claude Code would
  const client = new Client({ name: 'tabi-e2e', version: '1.0.0' });
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [SERVER],
    env: { ...process.env, TABI_MCP_TOKEN: token, TABI_MCP_PORT: String(port) } as Record<string, string>,
    stderr: 'pipe',
  }));

  // 2. The browser with Tabi, paired with that token
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless: !headed,
    viewport: { width: 1280, height: 900 },
    args: [`--disable-extensions-except=${EXTENSION_DIR}`, `--load-extension=${EXTENSION_DIR}`],
  });
  try {
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker', { timeout: 15_000 });
    await worker.evaluate(([t, p]) => chrome.storage.local.set({ tabi_mcp: { enabled: true, token: t, port: p } }), [token, port] as const);

    // 3. Wait for the extension to connect
    let tabs = '';
    for (let i = 0; i < 50; i++) {
      const res: any = await client.callTool({ name: 'browser_tabs', arguments: {} });
      if (!res.isError) { tabs = textOf(res); break; }
      await new Promise((r) => setTimeout(r, 200));
    }
    check('extension pairs with tabi-mcp', tabs.startsWith('['), 'never connected');
    if (!tabs) return;

    // 4. Log in through the tools, like a model would
    const opened = textOf(await client.callTool({ name: 'browser_open', arguments: { url: `${fixtures.baseUrl}/login.html` } }));
    check('browser_open loads the page', /Opened ".*" \(.*login\.html\) in tab \d+/.test(opened), opened);

    const snapshot = textOf(await client.callTool({ name: 'browser_snapshot', arguments: {} }));
    const idOf = (re: RegExp) => Number(snapshot.split('\n').find((l) => re.test(l))?.match(/^\[(\d+)\]/)?.[1]);
    const user = idOf(/"Username"/);
    const pass = idOf(/type="password"/);
    const submit = idOf(/<button>.*"Sign in"/);
    check('browser_snapshot lists numbered elements', [user, pass, submit].every(Number.isInteger), snapshot.slice(0, 300));

    const acted = textOf(await client.callTool({
      name: 'browser_act',
      arguments: { actions: [
        { action: 'type', elementId: user, text: 'demo' },
        { action: 'type', elementId: pass, text: 'hunter2' },
        { action: 'click', elementId: submit },
      ] },
    }));
    await new Promise((r) => setTimeout(r, 500));
    const login = fixtures.events.find((e) => e.path === '/api/login');
    check('browser_act fills and submits the form', login?.data?.username === 'demo' && login?.data?.password === 'hunter2', acted);

    const shot: any = await client.callTool({ name: 'browser_screenshot', arguments: {} });
    const image = shot.content?.[0];
    check('browser_screenshot returns an image', image?.type === 'image' && image.mimeType === 'image/jpeg' && image.data.length > 1000, textOf(shot));

    const refused: any = await client.callTool({ name: 'browser_open', arguments: { url: 'file:///etc/passwd' } });
    check('refuses non-http URLs', refused.isError === true && textOf(refused).includes('Only http(s) URLs'), textOf(refused));
  } finally {
    await client.close().catch(() => {});
    await context.close().catch(() => {});
    await fixtures.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
}

main()
  .then(() => {
    console.log(failures ? `\n${failures} check(s) failed.` : '\nAll tabi-mcp checks passed.');
    process.exit(failures ? 1 : 0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
