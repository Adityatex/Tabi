// What the extension does for tabi-mcp's requests (background only). The
// AI app on the other end reads pages and acts through the same snapshot and
// action code as Tabi's own agent. Chrome specifics are injected so this
// can be unit-tested.

import type { BridgeMethod } from '@/mcp/src/protocol';
import { runAction, waitForPage, type RunnerDeps } from '@/lib/agent/runner';
import { parseAgentAction } from '@/lib/agent/parseAction';
import { describeAction } from '@/lib/agent/history';
import type { AgentAction } from '@/lib/agent/actionExecutor';
import { urlStatus } from '@/lib/agent/sites';

export interface TabSummary {
  id: number;
  title?: string;
  url?: string;
  active: boolean;
}

export interface HandlerDeps extends Pick<RunnerDeps, 'getTab' | 'send' | 'sleep' | 'navigate' | 'siteRules'> {
  listTabs(): Promise<TabSummary[]>;
  /** The active tab of the last focused window. */
  activeTabId(): Promise<number | undefined>;
  createTab(url: string): Promise<number>;
  /** Bring a tab (and its window) to the front. */
  focusTab(tabId: number): Promise<void>;
  /** Page loads seen in a tab so far. */
  loads(tabId: number): number;
  screenshot(tabId: number, visual: unknown): Promise<string | null>;
  /** Run Tabi's own agent on a goal; resolves with its final message. */
  runTask(tabId: number, goal: string): Promise<string>;
  /** Tabi's own agent is running in this tab. */
  isBusy(tabId: number): boolean;
  /** Drop the debugger (and Chrome's banner) once the AI app has gone quiet. */
  releaseInput(tabId: number): void;
}

/** Actions per browser_act call. */
const MAX_ACTIONS = 10;
/** Release trusted input this long after the last action. */
const RELEASE_AFTER_MS = 60_000;
const SNAPSHOT_TIMEOUT_MS = 20_000;

function httpUrl(raw: unknown): string {
  let url: URL;
  try {
    url = new URL(String(raw ?? ''));
  } catch {
    throw new Error(`Not a full URL: "${raw}"`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`Only http(s) URLs can be opened, not ${url.protocol}`);
  return url.href;
}

export function createHandlers(deps: HandlerDeps) {
  /** The tab the AI app is working in: the last one it opened or selected. */
  let workingTab: number | undefined;
  const releaseTimers = new Map<number, ReturnType<typeof setTimeout>>();

  async function tabFor(params: Record<string, unknown>): Promise<number> {
    if (typeof params.tabId === 'number') return params.tabId;
    if (workingTab !== undefined) {
      try {
        await deps.getTab(workingTab);
        return workingTab;
      } catch { workingTab = undefined; /* closed */ }
    }
    const active = await deps.activeTabId();
    if (active === undefined) throw new Error('No tab to work in: open one with browser_open');
    return active;
  }

  async function ready(tabId: number): Promise<{ title?: string; url?: string }> {
    try {
      return await waitForPage(deps, tabId);
    } catch {
      throw new Error(`Tab ${tabId} isn't ready for Tabi. It may be a browser page (chrome://, the Web Store) where extensions can't run, or it opened before Tabi was installed: reload it.`);
    }
  }

  /**
   * The user's site lists apply to AI apps too. No one is at the side panel to
   * ask, so a site off the allow list is refused like a blocked one.
   */
  async function siteProblem(url: string | undefined): Promise<string | null> {
    const rules = await deps.siteRules?.().catch(() => undefined);
    if (!rules) return null;
    const { site, status } = urlStatus(url, rules);
    if (status === 'blocked') return `${site} is on the user's block list in Tabi, so it can't be opened, read or used from here`;
    if (status === 'unlisted') return `${site} isn't on the user's list of allowed sites in Tabi, so it can't be opened, read or used from here`;
    return null;
  }

  /** Throw if the tab is on a site the user's lists rule out. */
  async function checkTab(tabId: number): Promise<void> {
    const problem = await siteProblem((await deps.getTab(tabId)).url);
    if (problem) throw new Error(`Tab ${tabId}: ${problem}.`);
  }

  function scheduleRelease(tabId: number): void {
    clearTimeout(releaseTimers.get(tabId));
    releaseTimers.set(tabId, setTimeout(() => {
      releaseTimers.delete(tabId);
      deps.releaseInput(tabId);
    }, RELEASE_AFTER_MS));
  }

  const handlers: Record<BridgeMethod, (params: Record<string, unknown>) => Promise<unknown>> = {
    async tabs_list() {
      const tabs = await deps.listTabs();
      return tabs.map((t) => ({ ...t, working: t.id === workingTab }));
    },

    async tab_open(params) {
      const url = httpUrl(params.url);
      const problem = await siteProblem(url);
      if (problem) throw new Error(`${problem}.`);
      let tabId: number;
      if (params.newTab === false) {
        tabId = await tabFor(params);
        await deps.navigate(tabId, url);
      } else {
        tabId = await deps.createTab(url);
      }
      workingTab = tabId;
      await deps.sleep(500);
      const tab = await ready(tabId);
      return `Opened "${tab.title || 'untitled page'}" (${tab.url}) in tab ${tabId}.`;
    },

    async tab_select(params) {
      const tabId = Number(params.tabId);
      await deps.focusTab(tabId);
      workingTab = tabId;
      const tab = await deps.getTab(tabId);
      return `Working in tab ${tabId}: "${tab.title || 'untitled page'}" (${tab.url}).`;
    },

    async page_snapshot(params) {
      const tabId = await tabFor(params);
      await ready(tabId);
      await checkTab(tabId);
      const snapshot = await deps.send(tabId, { action: 'AGENT_SNAPSHOT' }, SNAPSHOT_TIMEOUT_MS);
      return `Tab ${tabId}\n${String(snapshot?.text ?? '')}`;
    },

    async page_act(params) {
      const tabId = await tabFor(params);
      if (deps.isBusy(tabId)) throw new Error(`Tabi's own agent is working in tab ${tabId}; wait for it to finish or stop it from the Tabi side panel.`);
      const raw = Array.isArray(params.actions) ? params.actions : [];
      if (raw.length === 0) throw new Error('No actions given');
      if (raw.length > MAX_ACTIONS) throw new Error(`At most ${MAX_ACTIONS} actions per call`);
      const actions: AgentAction[] = raw.map((a, i) => {
        const parsed = parseAgentAction(JSON.stringify(a));
        if (!parsed.ok) throw new Error(`Action ${i + 1}: ${parsed.error}`);
        if (parsed.action.action === 'done' || parsed.action.action === 'use_skill' || parsed.action.action === 'run_code') {
          throw new Error(`Action ${i + 1}: "${parsed.action.action}" is only for Tabi's own agent`);
        }
        return parsed.action;
      });

      await ready(tabId);
      await checkTab(tabId);
      const lines: string[] = [];
      for (const [i, action] of actions.entries()) {
        const blocked = action.action === 'navigate' ? await siteProblem(action.url) : null;
        if (blocked) {
          lines.push(`${describeAction(action)} → ❌ not run: ${blocked}`);
          break;
        }
        const { result, pageChanged } = await runAction(deps, tabId, action, () => deps.loads(tabId));
        lines.push(`${describeAction(action)} → ${result}`);
        // A click can lead somewhere the lists rule out: stop there
        const landed = pageChanged ? await siteProblem((await deps.getTab(tabId)).url) : null;
        if (landed) {
          lines.push(`(stopped: the page went where it can't be used: ${landed})`);
          break;
        }
        const left = actions.length - i - 1;
        if (left > 0 && (pageChanged || result.startsWith('❌'))) {
          lines.push(`(${left} more action${left === 1 ? '' : 's'} not run: ${pageChanged ? 'the page changed; take a new browser_snapshot, since element IDs change' : 'the action above failed'})`);
          break;
        }
      }
      scheduleRelease(tabId);
      return lines.join('\n');
    },

    async page_screenshot(params) {
      const tabId = await tabFor(params);
      await ready(tabId);
      await checkTab(tabId);
      const snapshot = await deps.send(tabId, { action: 'AGENT_SNAPSHOT', visual: true }, SNAPSHOT_TIMEOUT_MS);
      if (!snapshot?.visual) throw new Error('Could not measure the page for a screenshot');
      const image = await deps.screenshot(tabId, snapshot.visual);
      if (!image) throw new Error(`Tab ${tabId} isn't visible, so it can't be captured. Bring it to the front with browser_select_tab, or turn on "Real mouse & keyboard input" in Tabi, which can capture background tabs.`);
      scheduleRelease(tabId);
      return image;
    },

    async run_task(params) {
      const goal = String(params.goal ?? '').trim();
      if (!goal) throw new Error('No goal given');
      const tabId = await tabFor(params);
      if (deps.isBusy(tabId)) throw new Error(`Tabi's own agent is already working in tab ${tabId}`);
      await ready(tabId);
      return deps.runTask(tabId, goal);
    },
  };

  return async (method: BridgeMethod, params: Record<string, unknown>): Promise<unknown> => {
    const handler = handlers[method];
    if (!handler) throw new Error(`Unknown request: ${method}`);
    return handler(params);
  };
}
