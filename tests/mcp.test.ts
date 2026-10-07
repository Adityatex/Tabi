// @vitest-environment node
import { describe, it, expect, vi, afterEach } from 'vitest';
import WebSocketNode from 'ws';
// The SDK is installed with tabi-mcp (mcp/), not at the root
import { Client } from '../mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { InMemoryTransport } from '../mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/inMemory.js';
import { ExtensionBridge, NOT_CONNECTED, allowedOrigin } from '@/mcp/src/bridgeServer';
import { createServer } from '@/mcp/src/server';
import { randomHex, newToken, isValidToken, normalizeToken } from '@/mcp/src/protocol';
import { BridgeClient, type BridgeStatus } from '@/lib/mcp/bridgeClient';
import { createHandlers, type HandlerDeps } from '@/lib/mcp/handlers';

/** What Chrome does for an extension's WebSocket: sets its origin. */
class ExtensionSocket extends WebSocketNode {
  constructor(url: string) {
    super(url, { origin: 'chrome-extension://abcdefghijklmnop' });
  }
}

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

async function startServer(token: string) {
  const bridge = new ExtensionBridge(token, 0);
  await bridge.start();
  cleanup.push(() => bridge.stop());
  return bridge;
}

function startClient(port: number, token: string, handle = vi.fn(async (method: string) => `did ${method}`)) {
  const statuses: { status: BridgeStatus; detail?: string }[] = [];
  const client = new BridgeClient({ WebSocket: ExtensionSocket as any, handle, onStatus: (status, detail) => statuses.push({ status, detail }) });
  client.start(port, token);
  cleanup.push(() => client.stop());
  return { client, statuses, handle };
}

const until = async (check: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe('pairing tokens', () => {
  it('are tbk_ and 64 hex characters', () => {
    expect(newToken()).toMatch(/^tbk_[0-9a-f]{64}$/);
    expect(isValidToken(newToken())).toBe(true);
  });

  it('accept pasted ones with stray whitespace or capitals, and nothing else', () => {
    const hex = randomHex(32);
    expect(normalizeToken(`  TBK_${hex.toUpperCase()}
`)).toBe(`tbk_${hex}`);
    expect(isValidToken(`  TBK_${hex.toUpperCase()} `)).toBe(true);
    expect(isValidToken(hex)).toBe(false);
    expect(isValidToken('tbk_1234')).toBe(false);
    expect(isValidToken(`gbk_${hex}`)).toBe(false);
  });
});

describe('tabi-mcp bridge', () => {
  it('pairs with the right token, then carries requests and answers', async () => {
    const token = newToken();
    const bridge = await startServer(token);
    const { client, handle } = startClient(bridge.address, token);
    await until(() => bridge.connected && client.current === 'connected');
    await expect(bridge.request('tabs_list', { a: 1 })).resolves.toBe('did tabs_list');
    expect(handle).toHaveBeenCalledWith('tabs_list', { a: 1 });
  });

  it('passes errors back to the AI app', async () => {
    const token = newToken();
    const bridge = await startServer(token);
    startClient(bridge.address, token, vi.fn(async () => { throw new Error('No tab to work in'); }));
    await until(() => bridge.connected);
    await expect(bridge.request('page_snapshot')).rejects.toThrow('No tab to work in');
  });

  it('refuses to take commands from a server with a different token', async () => {
    const bridge = await startServer(newToken()); // e.g. something else listening on the port
    const { client, statuses, handle } = startClient(bridge.address, newToken());
    await until(() => client.current === 'rejected');
    expect(statuses.at(-1)).toEqual({ status: 'rejected', detail: 'The tabi-mcp server has a different pairing token' });
    expect(bridge.connected).toBe(false);
    expect(handle).not.toHaveBeenCalled();
  });

  it('says clearly when the extension is not connected', async () => {
    const bridge = await startServer(newToken());
    await expect(bridge.request('tabs_list')).rejects.toThrow(NOT_CONNECTED);
  });

  it('only lets browser extensions connect, not web pages', async () => {
    expect(allowedOrigin('chrome-extension://abcdefghijklmnop')).toBe(true);
    expect(allowedOrigin('https://evil.example')).toBe(false);
    expect(allowedOrigin('http://localhost:3000')).toBe(false);
    expect(allowedOrigin(undefined)).toBe(false);

    const bridge = await startServer(newToken());
    const page = new WebSocketNode(`ws://127.0.0.1:${bridge.address}`, { origin: 'https://evil.example' });
    const refused = await new Promise<boolean>((resolve) => {
      page.on('open', () => resolve(false));
      page.on('error', () => resolve(true));
    });
    expect(refused).toBe(true);
  });
});

describe('tabi-mcp tools', () => {
  async function connect(request: (method: string, params?: Record<string, unknown>) => Promise<unknown>) {
    const server = createServer({ request: request as any });
    const client = new Client({ name: 'test', version: '1.0.0' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
    cleanup.push(() => client.close());
    return client;
  }

  it('offers the browser tools', async () => {
    const client = await connect(async () => 'ok');
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'browser_act', 'browser_open', 'browser_run_task', 'browser_screenshot', 'browser_select_tab', 'browser_snapshot', 'browser_tabs',
    ]);
  });

  it('forwards actions to the extension and returns what they did', async () => {
    const request = vi.fn(async () => 'click [3] → ✅ Clicked <button> "Sign in"');
    const client = await connect(request);
    const result: any = await client.callTool({ name: 'browser_act', arguments: { actions: [{ action: 'click', elementId: 3 }] } });
    expect(request).toHaveBeenCalledWith('page_act', { tabId: undefined, actions: [{ action: 'click', elementId: 3 }] });
    expect(result.content[0].text).toBe('click [3] → ✅ Clicked <button> "Sign in"');
  });

  it('returns screenshots as images', async () => {
    const client = await connect(async () => 'data:image/jpeg;base64,QUJD');
    const result: any = await client.callTool({ name: 'browser_screenshot', arguments: {} });
    expect(result.content[0]).toEqual({ type: 'image', data: 'QUJD', mimeType: 'image/jpeg' });
  });

  it('reports failures as tool errors', async () => {
    const client = await connect(async () => { throw new Error(NOT_CONNECTED); });
    const result: any = await client.callTool({ name: 'browser_snapshot', arguments: {} });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('The Tabi extension is not connected');
  });
});

describe('what the extension does for the bridge', () => {
  function fakeDeps(over: Partial<HandlerDeps> = {}) {
    const tab = { status: 'complete', url: 'https://shop.test/', title: 'Shop' };
    const deps: HandlerDeps = {
      getTab: vi.fn(async () => ({ ...tab })),
      send: vi.fn(async (_id: number, m: any) => {
        if (m.action === 'AGENT_SNAPSHOT') return { text: 'PAGE: Shop', ...(m.visual ? { visual: { marks: [] } } : {}) };
        if (m.action === 'AGENT_EXECUTE') return m.payload.elementId === 9 ? '❌ Element [9] not found' : `✅ ran ${m.payload.action}`;
        return { ok: true };
      }),
      sleep: vi.fn(async () => {}),
      navigate: vi.fn(async () => {}),
      listTabs: vi.fn(async () => [{ id: 1, title: 'Shop', url: tab.url, active: true }]),
      activeTabId: vi.fn(async () => 1),
      createTab: vi.fn(async () => 5),
      focusTab: vi.fn(async () => {}),
      loads: () => 0,
      screenshot: vi.fn(async () => 'data:image/jpeg;base64,AA'),
      runTask: vi.fn(async () => '## ✅ Task Complete'),
      isBusy: () => false,
      releaseInput: vi.fn(),
      ...over,
    };
    return { deps, handle: createHandlers(deps) };
  }

  it('reads the active tab when the AI app has not picked one', async () => {
    const { handle } = fakeDeps();
    await expect(handle('page_snapshot', {})).resolves.toBe('Tab 1\nPAGE: Shop');
  });

  it('works in the tab it last opened', async () => {
    const { deps, handle } = fakeDeps();
    await expect(handle('tab_open', { url: 'https://shop.test/cart' })).resolves.toBe('Opened "Shop" (https://shop.test/) in tab 5.');
    await handle('page_snapshot', {});
    expect((deps.send as any).mock.calls.at(-1)[0]).toBe(5);
    await expect(handle('tabs_list', {})).resolves.toEqual([{ id: 1, title: 'Shop', url: 'https://shop.test/', active: true, working: false }]);
  });

  it('runs actions in order and stops after one fails', async () => {
    const { handle } = fakeDeps();
    const result = await handle('page_act', { actions: [{ action: 'type', elementId: 1, text: 'demo' }, { action: 'click', elementId: 9 }, { action: 'click', elementId: 2 }] });
    expect(result).toBe('type [1] "demo" → ✅ ran type\nclick [9] → ❌ Element [9] not found\n(1 more action not run: the action above failed)');
  });

  it('rejects bad actions and unsafe URLs before touching the page', async () => {
    const { deps, handle } = fakeDeps();
    await expect(handle('page_act', { actions: [{ action: 'click' }] })).rejects.toThrow('Action 1: click requires a numeric elementId');
    await expect(handle('tab_open', { url: 'javascript:alert(1)' })).rejects.toThrow('Only http(s) URLs');
    await expect(handle('tab_open', { url: 'file:///C:/secrets.txt' })).rejects.toThrow('Only http(s) URLs');
    expect(deps.createTab).not.toHaveBeenCalled();
  });

  it("stays out of the way while Tabi's own agent works in the tab", async () => {
    const { handle } = fakeDeps({ isBusy: () => true });
    await expect(handle('page_act', { actions: [{ action: 'click', elementId: 1 }] })).rejects.toThrow("Tabi's own agent is working in tab 1");
  });

  it('explains when a hidden tab cannot be captured', async () => {
    const { handle } = fakeDeps({ screenshot: vi.fn(async () => null) });
    await expect(handle('page_screenshot', {})).rejects.toThrow("isn't visible");
  });
  it("keeps AI apps off the user's blocked sites, and off unlisted ones when there's an allow list", async () => {
    const rules = { blocked: ['mybank.com'], allowed: [] as string[] };
    const { deps, handle } = fakeDeps({ siteRules: vi.fn(async () => rules) });
    await expect(handle('tab_open', { url: 'https://login.mybank.com/' })).rejects.toThrow("mybank.com is on the user's block list");
    expect(deps.createTab).not.toHaveBeenCalled();
    const acted = String(await handle('page_act', { actions: [{ action: 'navigate', url: 'https://mybank.com/pay' }, { action: 'click', elementId: 1 }] }));
    expect(acted).toContain("navigate https://mybank.com/pay → ❌ not run: mybank.com is on the user's block list");
    expect(acted).not.toContain('click'); // the batch stops there
    expect(deps.navigate).not.toHaveBeenCalled();
    rules.allowed = ['other.test'];
    await expect(handle('page_snapshot', {})).rejects.toThrow("shop.test isn't on the user's list of allowed sites");
    rules.allowed = ['shop.test'];
    expect(String(await handle('page_snapshot', {}))).toContain('PAGE: Shop');
  });
});
