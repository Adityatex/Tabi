// The background service worker: routes messages, runs agent tasks, calls the model and keeps storage.

import { summarizePage, explainText, chatWithPage, callLLM, selectionMessages, WRITING_ACTIONS, planAgentStep, listModels, acceptsImages, type SelectionAction, type SelectionRequest, type TokenUsage } from '@/lib/api/llmClient';
import {
  startRun, stopRun, resumeRun, answerRun, hintRun, forgetRun, getRunView, getRunRecord, listRuns, isRunning, notifyTabLoading,
  type RunnerDeps, type RunOptions, type RunView,
} from '@/lib/agent/runner';
import {
  PROVIDERS, PROVIDER_IDS, SETTINGS_KEY, readSettings, resolveConfig, resolveChain, resolveExecutor, configProblem, makeMain,
  validateBaseUrl, maskKey, type LLMConfig, type ProviderId, type StoredLLMSettings,
} from '@/lib/api/providers';
import { formatError, withTimeout } from '@/lib/utils/errorHandler';
import { providerPool, modelLabel, type FallbackResult } from '@/lib/api/fallback';
import { trustedClick, trustedKey, trustedType, releaseTab, watchDetach, debuggerScreenshot, debuggerEvaluate } from '@/lib/agent/trustedInput';
import { CODE_TIMEOUT_MS } from '@/lib/agent/customCode';
import { EDITOR_MARK, setCodeInPage } from '@/lib/agent/codeEditor';
import { SITES_KEY, cleanRules, normalizeSite, type SiteRules } from '@/lib/agent/sites';
import { RUNS_KEY, upsertRun, runHeader, type RunLog } from '@/lib/agent/timeline';
import { checkStep } from '@/lib/agent/critic';
import { TaskQueue, TaskCancelled } from '@/lib/agent/taskQueue';
import { annotate, base64ToBlob, type VisualInfo } from '@/lib/agent/screenshot';
import { PREFS_KEY, DEFAULT_PREFS, type AgentPrefs } from '@/lib/agent/prefs';
import { BridgeClient, type BridgeStatus } from '@/lib/mcp/bridgeClient';
import { parseSkill, formatSkill, slugify, type Skill } from '@/lib/skills/skill';
import { loadWorkflows, saveWorkflow, deleteWorkflow, workflowName, type Workflow } from '@/lib/workflows/workflow';
import { loadShortcuts, saveShortcut, deleteShortcut, fillPrompt, blanks } from '@/lib/shortcuts/shortcut';
import { loadSchedules } from '@/lib/schedules/schedule';
import {
  saveSchedule, deleteSchedule, setEnabled, runSchedule, onScheduleAlarm, syncSchedules, type SchedulerDeps,
} from '@/lib/schedules/scheduler';
import { loadSkills, saveSkill, deleteSkill, type KeyValueStorage } from '@/lib/skills/store';
import { writeSkillFromRun } from '@/lib/skills/writer';
import { filledFields, loadProfile } from '@/lib/automation/profile';
import { createHandlers } from '@/lib/mcp/handlers';
import { cueOf } from '@/lib/dom/pageCue';
import { Attention, toolbarIconPaths, type Scheme } from '@/lib/utils/toolbarIcon';
import { DEFAULT_PORT, isValidToken, normalizeToken } from '@/mcp/src/protocol';

/** chrome.storage.local, in the shape lib/skills/store expects. */
const skillStorage: KeyValueStorage = {
  get: (key) => browser.storage.local.get(key) as Promise<Record<string, unknown>>,
  set: (items) => browser.storage.local.set(items),
};

/** tabi-mcp bridge settings (chrome.storage.local); only this worker reads the token. */
const MCP_KEY = 'tabi_mcp';
interface McpSettings { enabled: boolean; token: string; port: number }
const MCP_ALARM = 'tabi-mcp';

declare var chrome: any;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Keep the service worker alive while an agent runs: Chrome may stop an idle
 * worker after ~30s, and one reasoning-model call can take longer than that.
 * Any extension API call resets the idle timer.
 */
let keepAliveTimer: ReturnType<typeof setInterval> | undefined;
let activeRuns = 0;
function holdKeepAlive(): void {
  if (activeRuns++ === 0) keepAliveTimer = setInterval(() => chrome.runtime.getPlatformInfo(), 20_000);
}
function releaseKeepAlive(): void {
  if (--activeRuns === 0 && keepAliveTimer) clearInterval(keepAliveTimer);
}

export default defineBackground(() => {
  watchDetach();

  // ---- Toolbar icon (lib/utils/toolbarIcon.ts): ink to match the toolbar, an amber dot while a task needs you
  const attention = new Attention();
  let scheme: Scheme = 'light';
  let mcpConnected = false;
  /** The badge shows MCP while an AI app is connected, but never covers the amber dot. */
  function paintToolbar(): void {
    chrome.action.setIcon({ path: toolbarIconPaths(scheme, attention.needed) }).catch(() => {});
    chrome.action.setBadgeText({ text: mcpConnected && !attention.needed ? 'MCP' : '' });
  }
  /** A tab's run changed status: paused means it waits for the user. */
  function noteAttention(tabId: number, status: string | undefined): void {
    if (attention.update(tabId, status)) paintToolbar();
  }
  chrome.action.setBadgeBackgroundColor({ color: '#2B45D8' });
  // Pages report the colour scheme (a worker can't see it); kept for when the worker restarts
  chrome.storage.session.get('tabi_scheme').then((stored: any) => {
    if (stored?.tabi_scheme === 'dark') {
      scheme = 'dark';
      paintToolbar();
    }
  }).catch(() => {});

  // ---- The side panel (entrypoints/sidepanel) is Tabi's main surface: the toolbar icon opens it, and so
  // does its shortcut (Alt+T unless the user changed it; the manifest's _execute_action). There is no popup.
  chrome.sidePanel?.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  // Right-click: open Tabi, or run a page command in it
  browser.runtime.onInstalled.addListener(() => {
    chrome.contextMenus?.removeAll(() => {
      chrome.contextMenus.create({ id: 'tabi-open', title: 'Open Tabi', contexts: ['page', 'frame', 'link', 'image'] });
      chrome.contextMenus.create({ id: 'tabi-summarize', title: 'Summarize this page with Tabi', contexts: ['page', 'frame'] });
      chrome.contextMenus.create({ id: 'tabi-explain', title: 'Explain “%s” with Tabi', contexts: ['selection'] });
    });
  });
  // Alt+J (the manifest's ask-selection command): ask about the selection on the page, or the page itself
  chrome.commands?.onCommand.addListener((command: string, tab?: { id?: number }) => {
    if (command !== 'ask-selection' || tab?.id === undefined) return;
    chrome.tabs.sendMessage(tab.id, { action: 'SELECTION_SHORTCUT' }).catch(() => {});
  });

  chrome.contextMenus?.onClicked.addListener((info: { menuItemId: string; selectionText?: string }, tab?: { id?: number; windowId: number }) => {
    if (tab?.id === undefined) return;
    // open() only works in the click's user gesture, so before anything is awaited
    chrome.sidePanel?.open({ windowId: tab.windowId }).catch(() => {});
    const command = info.menuItemId === 'tabi-summarize' ? 'summarize' : info.menuItemId === 'tabi-explain' ? 'explain' : null;
    if (!command) return;
    // A panel that is just opening reads it from storage; one already open hears it
    const pending = { tabId: tab.id, command, text: info.selectionText ?? '', at: Date.now() };
    chrome.storage.session.set({ tabi_panel_command: pending }).catch(() => {});
    chrome.runtime.sendMessage({ action: 'PANEL_COMMAND', payload: pending }).catch(() => {});
  });

  // ---- Run timelines (lib/agent/timeline.ts), for the History page
  async function loadRunLogs(): Promise<RunLog[]> {
    const stored: any = await browser.storage.local.get(RUNS_KEY);
    return Array.isArray(stored[RUNS_KEY]) ? stored[RUNS_KEY] : [];
  }
  /** One write at a time: parallel tasks save into the same list. */
  let runLogWrites: Promise<void> = Promise.resolve();
  function saveRunLog(log: RunLog): void {
    runLogWrites = runLogWrites
      .then(async () => { await browser.storage.local.set({ [RUNS_KEY]: upsertRun(await loadRunLogs(), log) }); })
      .catch((err) => console.error('[Tabi] Saving the run timeline:', err));
  }
  function editRunLogs(change: (runs: RunLog[]) => RunLog[]): Promise<void> {
    runLogWrites = runLogWrites.then(async () => { await browser.storage.local.set({ [RUNS_KEY]: change(await loadRunLogs()) }); });
    return runLogWrites;
  }
  /** The History page, at one run if given. */
  async function openHistory(runId?: string): Promise<void> {
    const tab = await chrome.tabs.create({ url: browser.runtime.getURL(`/history.html${runId ? `#${runId}` : ''}` as any), active: true });
    chrome.windows.update(tab.windowId, { focused: true });
  }

  /** The user's block and allow lists (lib/agent/sites.ts). */
  async function loadSiteRules(): Promise<SiteRules> {
    const stored: any = await browser.storage.local.get(SITES_KEY);
    return cleanRules(stored[SITES_KEY]);
  }

  /** Agent preferences. Trusted input is on unless the user turns it off. */
  async function loadPrefs(): Promise<AgentPrefs> {
    const stored: any = await browser.storage.local.get(PREFS_KEY);
    return { ...DEFAULT_PREFS, ...(stored[PREFS_KEY] ?? {}) };
  }

  // ---- Agent runner: the loop lives here, not in the page (lib/agent/runner.ts)
  const runnerDeps: RunnerDeps = {
    plan: async (goal, snapshot, history, currentPlan, role, image) => {
      const { nativeTools, customCode } = await loadPrefs();
      // Any provider in the chain can answer: the prompt carries the whole task state.
      // Executor calls try the fast model first, then the usual chain.
      let usage: TokenUsage | undefined;
      const onUsage = (u: TokenUsage) => { usage = { prompt: (usage?.prompt ?? 0) + u.prompt, completion: (usage?.completion ?? 0) + u.completion }; };
      const { value, config, skipped } = await ask(
        (c) => planAgentStep(goal, snapshot, history, currentPlan, c, { image, tools: nativeTools, customCode, onUsage }),
        role === 'executor',
      );
      return { text: value, model: modelLabel(config), unavailable: skipped, imageDropped: !!image && !acceptsImages(config), usage };
    },
    // run_code (opt-in): in an isolated world through the debugger; the runner checked the code first
    runCode: (tabId, expression) => debuggerEvaluate(tabId, expression, CODE_TIMEOUT_MS),
    screenshot: async (tabId, visual) => {
      // Through the debugger when trusted input is on: that works even if the
      // user is looking at another tab. Otherwise only while the tab is visible.
      let captured: Blob;
      if ((await loadPrefs()).trustedInput) {
        captured = base64ToBlob(await debuggerScreenshot(tabId));
      } else {
        const tab = await chrome.tabs.get(tabId);
        if (!tab.active) return null;
        const dataUrl: string = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 80 });
        captured = await (await fetch(dataUrl)).blob();
      }
      return annotate(captured, visual as VisualInfo);
    },
    // frameId 0: only the top frame's content script handles agent messages
    send: (tabId, message, timeoutMs) => {
      const { action, payload } = message as { action?: string; payload?: RunView };
      if (action === 'AGENT_UPDATE') {
        pushView(tabId, payload!);
        return Promise.resolve({ ok: true });
      }
      return withTimeout(chrome.tabs.sendMessage(tabId, message, { frameId: 0 }), timeoutMs, 'Page');
    },
    getTab: async (tabId) => {
      const tab = await chrome.tabs.get(tabId);
      return { status: tab.status, url: tab.url, title: tab.title };
    },
    navigate: async (tabId, url) => { await chrome.tabs.update(tabId, { url }); },
    critic: async (goal, step, sites) => {
      // The fast model if there is one: a yes/no on a few lines, no page
      const { value } = await ask((c) => checkStep(goal, step, sites, c), true);
      return value;
    },
    siteRules: () => loadSiteRules(),
    saveRun: (log) => saveRunLog(log),
    onAsk: async (tabId, view) => {
      // The side panel asks; if the user can't see that tab (a background or
      // scheduled task), a notification tells them. Clicking it opens the tab.
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      const focused = tab?.active && (await chrome.windows.get(tab.windowId).catch(() => null))?.focused;
      if (!tab || focused) return;
      chrome.notifications.create(`tabi-task:${tabId}`, {
        type: 'basic', iconUrl: browser.runtime.getURL('/icons/icon128.png'), requireInteraction: true,
        title: `✋ Tabi needs your OK: ${view.goal.slice(0, 50)}`,
        message: `It wants to ${view.asking?.action}: ${view.asking?.risk === 'off-task' ? "a safety check doesn't think that's part of the task"
          : view.asking?.risk === 'unlisted' ? `${view.asking.reason}` : "that can't be undone"}.\nClick to open the tab and answer.`,
      });
    },
    onRunEnded: (tabId) => releaseTab(tabId), // drop the debugger (and its banner)
    sleep: wait,
  };

  /**
   * Show a tab's run in the side panel (open in any window; it ignores other
   * tabs' runs unless it lists them), and on the page itself: the cue.
   */
  function pushView(tabId: number, view: RunView): void {
    noteAttention(tabId, view.status);
    chrome.runtime.sendMessage({ action: 'AGENT_UPDATE', tabId, payload: view }).catch(() => {}); // no panel open
    chrome.tabs.sendMessage(tabId, { action: 'TABI_CUE', state: cueOf(view) }, { frameId: 0 }).catch(() => {}); // mid-navigation: it asks when it loads
  }

  // ---- Parallel tasks: at most N runs use the model at once (lib/agent/taskQueue.ts)
  /** What each waiting tab shows, by tab. */
  const queuedViews = new Map<number, RunView>();
  /** The goal each tab is waiting to run. */
  const pendingGoals = new Map<number, string>();
  /** Tabs started with "Run in background": a notification says when they finish. */
  const backgroundTabs = new Set<number>();

  const taskQueue = new TaskQueue(
    async () => (await loadPrefs()).maxParallel,
    async (tabId, position) => {
      if (position === 0) {
        queuedViews.delete(tabId);
        return;
      }
      const limit = (await loadPrefs()).maxParallel;
      const view: RunView = {
        goal: pendingGoals.get(tabId) ?? '',
        status: 'queued',
        message: `⏳ **Waiting to start** (${position === 1 ? 'next' : `#${position}`} in line)\n\n`
          + `${taskQueue.active} task${taskQueue.active === 1 ? ' is' : 's are'} running, and Tabi runs at most ${limit} at a time `
          + '(Settings › Agent) so free-tier rate limits hold. This one starts when a slot frees up.',
        loading: true,
        step: 0,
        plan: [],
        steps: [],
        updatedAt: Date.now(),
      };
      queuedViews.set(tabId, view);
      pushView(tabId, view);
    },
  );

  /**
   * Run the agent in a tab; resolves with how it ended, or null if it was
   * stopped before it got a slot. Runs that call the model wait their turn;
   * a workflow replay doesn't call one, so it starts at once.
   */
  async function executeRun(tabId: number, goal: string, options: RunOptions): Promise<RunView | null> {
    const run = async () => {
      holdKeepAlive();
      try {
        return await startRun(runnerDeps, tabId, goal, { ...options, profile: options.profile ?? await loadProfile() });
      } finally {
        releaseKeepAlive();
      }
    };
    let view: RunView | null;
    if (options.workflow) {
      view = await run();
    } else {
      pendingGoals.set(tabId, goal);
      try {
        view = await taskQueue.run(tabId, run);
      } catch (err) {
        if (!(err instanceof TaskCancelled)) throw err;
        view = null;
      } finally {
        pendingGoals.delete(tabId);
      }
    }
    if (backgroundTabs.has(tabId)) {
      backgroundTabs.delete(tabId);
      const icon = view?.status === 'done' ? '✅' : view?.status === 'paused' ? '⏸️' : '⚠️';
      const line = view ? view.message.split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('#')) ?? view.status : 'Stopped before it started';
      chrome.notifications.clear(`tabi-task:${tabId}`); // a question it asked is over
      // Clicking it opens the run's timeline (or, if it never started, its tab)
      chrome.notifications.create(view?.runId ? `tabi-run:${view.runId}` : `tabi-task:${tabId}`, {
        type: 'basic', iconUrl: browser.runtime.getURL('/icons/icon128.png'),
        title: `${icon} Tabi: ${goal.slice(0, 60)}`, message: `${line.slice(0, 200)}\nClick to see what it did.`,
      });
    }
    return view;
  }

  /** "Tabi" tab group per window, for background tasks. */
  const taskGroups = new Map<number, number>();
  async function groupTab(tabId: number, windowId: number): Promise<void> {
    const existing = taskGroups.get(windowId);
    try {
      const groupId = await chrome.tabs.group({ tabIds: [tabId], ...(existing !== undefined ? { groupId: existing } : { createProperties: { windowId } }) });
      taskGroups.set(windowId, groupId);
      if (existing === undefined) await chrome.tabGroups.update(groupId, { title: 'Tabi', color: 'blue', collapsed: false });
    } catch {
      // The group was closed: start a new one
      if (existing === undefined) return;
      taskGroups.delete(windowId);
      await groupTab(tabId, windowId).catch(() => {});
    }
  }

  chrome.notifications.onClicked.addListener(async (id: string) => {
    if (id.startsWith('tabi-run:')) {
      chrome.notifications.clear(id);
      await openHistory(id.slice('tabi-run:'.length));
      return;
    }
    if (!id.startsWith('tabi-task:')) return;
    const tabId = Number(id.slice('tabi-task:'.length));
    chrome.notifications.clear(id);
    const tab = await chrome.tabs.update(tabId, { active: true }).catch(() => null);
    if (tab) chrome.windows.update(tab.windowId, { focused: true });
  });
  chrome.tabs.onRemoved.addListener((tabId: number) => {
    taskQueue.cancel(tabId);
    queuedViews.delete(tabId);
    backgroundTabs.delete(tabId);
  });

  /** The saved skills, and the one the user chose (payload.skill, from /skill-name) if any; an unknown one is an error. */
  async function skillsFor(chosen: unknown): Promise<{ skills: Skill[]; useSkills?: string[] }> {
    const skills = await loadSkills(skillStorage);
    if (chosen === undefined || chosen === null || chosen === '') return { skills };
    const name = slugify(String(chosen));
    if (!skills.some((s) => s.name === name)) throw new Error(`There is no skill named "${chosen}"`);
    return { skills, useSkills: [name] };
  }

  /** An autofill task (the side panel's /autofill) has the profile's answers from the start, so it needs some. */
  async function autofillOptions(autofill: unknown): Promise<Pick<RunOptions, 'autofill' | 'profile'>> {
    if (autofill !== true) return {};
    const profile = await loadProfile();
    if (filledFields(profile).length === 0) throw new Error('Your autofill profile is empty. Add your details in Settings › Autofill profile, then try again.');
    return { autofill: true, profile };
  }

  function runAgent(tabId: number, goal: string, options: RunOptions): void {
    executeRun(tabId, goal, options).catch((err) => console.error('[Tabi] Agent run failed:', err));
  }

  // The runner needs to know when a page starts loading (clicks and form submits navigate)
  chrome.tabs.onUpdated.addListener((tabId: number, changeInfo: { status?: string }) => {
    if (changeInfo.status !== 'loading') return;
    if (isRunning(tabId)) notifyTabLoading(tabId);
    tabLoads.set(tabId, (tabLoads.get(tabId) ?? 0) + 1);
  });
  chrome.tabs.onRemoved.addListener((tabId: number) => tabLoads.delete(tabId));

  // ---- tabi-mcp bridge: an AI app on this computer (Claude Code, Claude
  // Desktop, Codex, ...) drives the browser through Tabi (lib/mcp/)
  /** Page loads per tab, so actions from the bridge can tell when a page changed. */
  const tabLoads = new Map<number, number>();
  let mcpStatus: { status: BridgeStatus; detail?: string } = { status: 'off' };

  const bridge = new BridgeClient({
    WebSocket,
    handle: createHandlers({
      ...runnerDeps,
      listTabs: async () => (await chrome.tabs.query({})).map((t: any) => ({ id: t.id, title: t.title, url: t.url, active: t.active })),
      activeTabId: async () => (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]?.id,
      createTab: async (url) => (await chrome.tabs.create({ url, active: true })).id,
      focusTab: async (tabId) => {
        const tab = await chrome.tabs.update(tabId, { active: true });
        await chrome.windows.update(tab.windowId, { focused: true });
      },
      loads: (tabId) => tabLoads.get(tabId) ?? 0,
      screenshot: (tabId, visual) => runnerDeps.screenshot!(tabId, visual),
      runTask: async (tabId, goal) => {
        const prefs = await loadPrefs();
        const settings = await loadSettings();
        const problem = configProblem(resolveConfig(settings));
        if (problem) throw new Error(`Tabi's own agent isn't set up: ${problem}`);
        const view = await executeRun(tabId, goal, {
          checkpoint: 0, split: hasExecutor(settings), screenshots: prefs.screenshots, skills: await loadSkills(skillStorage),
          customCode: prefs.customCode, confirm: prefs.confirmRisky, critic: prefs.critic, source: 'mcp',
        });
        return view?.message ?? 'Stopped before it started';
      },
      isBusy: (tabId) => isRunning(tabId),
      releaseInput: (tabId) => { if (!isRunning(tabId)) releaseTab(tabId); },
    }),
    onStatus: (status, detail) => {
      mcpStatus = { status, detail };
      // A visible sign that an AI app can control the browser
      mcpConnected = status === 'connected';
      paintToolbar();
    },
  });

  async function loadMcp(): Promise<McpSettings> {
    const stored: any = await browser.storage.local.get(MCP_KEY);
    return { enabled: false, token: '', port: DEFAULT_PORT, ...(stored[MCP_KEY] ?? {}) };
  }

  /** Connect or disconnect to match the settings; an alarm reconnects after the worker sleeps. */
  async function applyMcp(): Promise<void> {
    const mcp = await loadMcp();
    if (mcp.enabled && isValidToken(mcp.token)) {
      bridge.start(mcp.port, normalizeToken(mcp.token));
      chrome.alarms.create(MCP_ALARM, { periodInMinutes: 1 });
    } else {
      bridge.stop();
      chrome.alarms.clear(MCP_ALARM);
    }
  }
  chrome.alarms.onAlarm.addListener((alarm: { name: string }) => {
    if (alarm.name === MCP_ALARM) bridge.ensureConnected();
    else onScheduleAlarm(schedulerDeps, alarm.name).catch((err) => console.error('[Tabi] Schedule:', err));
  });
  applyMcp().catch((err) => console.error('[Tabi] MCP bridge:', err));
  // ---- Schedules: run a workflow or shortcut automatically (lib/schedules/)
  /** The first line of a result, as plain text for a notification. */
  const resultLine = (message: string) =>
    (message.split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('#') && !l.startsWith('---')) ?? '')
      .replace(/^([-*+]|\d+[.)])\s+/, '').replace(/\*\*|__|`/g, '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');

  const schedulerDeps: SchedulerDeps = {
    storage: skillStorage,
    now: () => Date.now(),
    setAlarm: (name, when) => chrome.alarms.create(name, { when }),
    clearAlarm: (name) => { chrome.alarms.clear(name); },
    notify: (title, message, runId) => {
      const options = { type: 'basic', iconUrl: browser.runtime.getURL('/icons/icon128.png'), title, message: runId ? `${message}\nClick to see what it did.` : message };
      if (runId) chrome.notifications.create(`tabi-run:${runId}`, options);
      else chrome.notifications.create(options);
    },
    run: async (schedule) => {
      // What to run: a workflow replays (no model); a shortcut's prompt goes to the agent
      let goal: string;
      let workflow: Workflow | undefined;
      let startUrl: string | undefined;
      if (schedule.kind === 'workflow') {
        workflow = (await loadWorkflows(skillStorage)).find((w) => w.name === schedule.name);
        if (!workflow) throw new Error(`The workflow /${schedule.name} no longer exists`);
        goal = workflow.goal;
        startUrl = workflow.startUrl;
      } else {
        const shortcut = (await loadShortcuts(skillStorage)).find((s) => s.name === schedule.name);
        if (!shortcut) throw new Error(`The shortcut /${schedule.name} no longer exists`);
        const filled = fillPrompt(shortcut.prompt, schedule.args ?? '');
        if (!filled.complete) throw new Error(`/${schedule.name} has blanks the schedule doesn't fill: ${blanks(filled.text).join(', ')}`);
        goal = filled.text;
        startUrl = schedule.url;
        await requireConfig(); // a shortcut needs the model
      }
      // In a background tab, so it never gets in the user's way
      const tab = await chrome.tabs.create({ url: startUrl ?? 'about:blank', active: false });
      const prefs = await loadPrefs();
      // Waits its turn like any task that calls the model (a workflow doesn't)
      const view = await executeRun(tab.id, goal, {
        checkpoint: prefs.stepCheckpoint, split: hasExecutor(await loadSettings()), screenshots: prefs.screenshots,
        skills: await loadSkills(skillStorage), customCode: prefs.customCode, confirm: prefs.confirmRisky, critic: prefs.critic, workflow, source: 'schedule',
      });
      if (!view) return { status: 'stopped', summary: 'Stopped before it started' };
      // Close it if it worked; keep it open to look at if it didn't
      if (view.status === 'done') chrome.tabs.remove(tab.id).catch(() => {});
      return { status: view.status, summary: resultLine(view.message), runId: view.runId };
    },
  };
  syncSchedules(schedulerDeps).catch((err) => console.error('[Tabi] Schedules:', err));

  // Settings can change from elsewhere too (another Settings tab, tests)
  browser.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[MCP_KEY]) applyMcp().catch((err) => console.error('[Tabi] MCP bridge:', err));
  });
  chrome.tabs.onRemoved.addListener((tabId: number) => {
    forgetRun(tabId);
    noteAttention(tabId, undefined);
  });

  browser.runtime.onInstalled.addListener(async (details: { reason: string }) => {
    // Chrome only puts content scripts into pages loaded after an install or
    // update: tabs already open have none, or the old version's, cut off from
    // this one. Add the new ones, so the cue, the toolbar on selected text and
    // the agent work there without reloading each page.
    if (details.reason !== 'install' && details.reason !== 'update') return;
    const tabs: { id?: number; url?: string; discarded?: boolean }[] = await chrome.tabs.query({}).catch(() => []);
    for (const tab of tabs) {
      if (tab.id === undefined || tab.discarded) continue;
      const tabId = tab.id;
      // A page that loaded since has this version's script already, which answers; an old one can't
      const live = await chrome.tabs.sendMessage(tabId, { action: 'AGENT_PING' }).then((r: any) => !!r?.ok).catch(() => false);
      if (live) continue;
      // Without the tabs permission URLs may be hidden: try every tab; chrome:// and store pages refuse
      chrome.scripting.executeScript({ target: { tabId }, files: ['content-scripts/content.js'] }).catch(() => {});
      chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ['content-scripts/frame.js'] }).catch(() => {});
    }
  });

  // Provider settings (BYOK: keys are never hardcoded, and only this worker reads them)
  async function loadSettings(): Promise<StoredLLMSettings> {
    return readSettings(await browser.storage.local.get(SETTINGS_KEY));
  }

  /** Config for the active provider, or throws a message saying what's missing. */
  async function requireConfig(): Promise<LLMConfig> {
    const config = resolveConfig(await loadSettings());
    const problem = configProblem(config);
    if (problem) throw new Error(problem);
    return config;
  }

  /**
   * Call the active provider, or a backup when it's rate-limited or failing
   * (lib/api/fallback.ts). Throws if the active provider isn't set up.
   */
  async function ask<T>(call: (config: LLMConfig) => Promise<T>, fast = false): Promise<FallbackResult<T>> {
    const settings = await loadSettings();
    const chain = resolveChain(settings);
    const problem = configProblem(chain[0]);
    if (problem) throw new Error(problem);
    const executor = fast ? resolveExecutor(settings) : null;
    return providerPool.run(executor ? [executor, ...chain] : chain, call);
  }

  /** A fast executor model is set up and differs from the main model. */
  function hasExecutor(settings: StoredLLMSettings): boolean {
    const executor = resolveExecutor(settings);
    const main = resolveConfig(settings);
    return !!executor && (executor.provider !== main.provider || executor.model !== main.model);
  }

  /** example.com for a workflow's start page. */
  function hostOf(url: string | undefined): string | undefined {
    try { return url ? new URL(url).host.replace(/^www./, '') : undefined; } catch { return undefined; }
  }

  function isProvider(id: unknown): id is ProviderId {
    return typeof id === 'string' && (PROVIDER_IDS as string[]).includes(id);
  }

  // ---- The toolbar on selected text (lib/dom/selectionToolbar.ts): one answer
  // per connection, streamed as it's written, from the fast model when there is
  // one. Closing the window disconnects, which stops the request.
  const SELECTION_ACTIONS: readonly SelectionAction[] = ['ask', 'explain', 'translate', 'summarize', ...WRITING_ACTIONS];
  browser.runtime.onConnect.addListener((port) => {
    if (port.name !== 'tabi-selection' || !port.sender?.tab) return;
    const abort = new AbortController();
    port.onDisconnect.addListener(() => abort.abort());
    const post = (message: unknown) => { try { port.postMessage(message); } catch { /* closed */ } };
    port.onMessage.addListener(async (message: any) => {
      if (message?.type !== 'start') return;
      const r = message.request ?? {};
      try {
        if (!SELECTION_ACTIONS.includes(r.action)) throw new Error('Unknown request');
        const turns = Array.isArray(r.turns)
          ? r.turns.filter((t: any) => (t?.role === 'user' || t?.role === 'assistant') && typeof t.content === 'string')
          : [];
        const request: SelectionRequest = {
          action: r.action, text: String(r.text ?? ''), around: String(r.around ?? ''), title: String(r.title ?? ''), url: String(r.url ?? ''),
          instruction: r.instruction ? String(r.instruction) : undefined, language: r.language ? String(r.language) : undefined,
          tone: r.tone ? String(r.tone) : undefined, turns,
        };
        if (!request.text && request.action !== 'ask') throw new Error('Select some text first');
        if ((request.action === 'ask' || request.action === 'edit') && !request.instruction?.trim()) throw new Error('Type what you want first');
        const { value } = await ask((c) => callLLM(selectionMessages(request), c, {
          maxTokens: 1500, onText: (soFar) => post({ type: 'text', text: soFar }), signal: abort.signal,
        }), true);
        post({ type: 'done', text: value });
      } catch (err) {
        if (!abort.signal.aborted) post({ type: 'error', message: (err as Error)?.message || 'Tabi couldn’t answer that.' });
      }
    });
  });

  browser.runtime.onMessage.addListener((message: any, _sender, sendResponse) => {
    const { action, payload } = message;
    // A content script is known by its tab, and can't name another. Tabi's own pages (the side panel,
    // Settings) name the tab they mean; their own tab, if they're open in one, never counts.
    const fromExtension = !!_sender.url?.startsWith(browser.runtime.getURL('/' as any));
    const senderTab: number | undefined = fromExtension
      ? (Number.isInteger(payload?.tabId) ? payload.tabId : undefined)
      : _sender.tab?.id;

    // "Review" on the page's cue: the side panel, where the question is. Before
    // any await, while the click still counts as the user's gesture.
    if (action === 'OPEN_PANEL') {
      // "Continue in panel" from the toolbar on selected text: the panel shows that conversation
      const answers = (Array.isArray(payload?.answers) ? payload.answers : [])
        .filter((a: any) => typeof a?.question === 'string' && typeof a?.answer === 'string')
        .slice(-20)
        .map((a: any) => ({ question: a.question.slice(0, 2000), answer: a.answer.slice(0, 20_000) }));
      if (_sender.tab?.id !== undefined && answers.length) {
        const pending = { tabId: _sender.tab.id, answers, at: Date.now() };
        chrome.storage.session.set({ tabi_panel_answer: pending }).catch(() => {});
        chrome.runtime.sendMessage({ action: 'PANEL_ANSWER', payload: pending }).catch(() => {});
      }
      // Some Chrome versions throw at once, rather than reject, when the gesture didn't carry over
      try {
        if (_sender.tab) chrome.sidePanel?.open({ windowId: _sender.tab.windowId }).catch(() => {});
      } catch { /* the toolbar icon still opens it */ }
      sendResponse({ success: true });
      return;
    }

    (async () => {
      try {
        switch (action) {
          case 'GET_LLM_SETTINGS': {
            // Settings only ever sees masked keys
            const settings = await loadSettings();
            const maskedKeys = Object.fromEntries(PROVIDER_IDS.map(id => [id, maskKey(settings.keys[id] ?? '')]));
            // Providers with a key and model saved, which can serve as backups
            const ready = PROVIDER_IDS.filter(id => configProblem(resolveConfig(settings, id)) === null);
            sendResponse({
              success: true,
              data: {
                provider: settings.provider, models: settings.models, customBaseUrl: settings.customBaseUrl ?? '', maskedKeys,
                fallbacks: settings.fallbacks ?? [], ready, executor: settings.executor ?? null,
              },
            });
            break;
          }

          case 'SAVE_LLM_SETTINGS': {
            // asBackup: save this provider's key and model and add it to the
            // backups, without making it the active provider
            const { provider, model, apiKey, customBaseUrl, asBackup } = payload ?? {};
            if (!isProvider(provider)) throw new Error('Unknown provider');
            if (provider === 'custom') {
              const urlError = validateBaseUrl(customBaseUrl ?? '');
              if (urlError) throw new Error(urlError);
            }
            const settings = await loadSettings();
            if (typeof model === 'string') settings.models[provider] = model.trim();
            // An empty key field means "keep the saved key"
            if (typeof apiKey === 'string' && apiKey.trim()) settings.keys[provider] = apiKey.trim();
            if (provider === 'custom') settings.customBaseUrl = customBaseUrl.trim();
            if (asBackup && provider !== settings.provider) {
              const problem = configProblem(resolveConfig(settings, provider));
              if (problem) throw new Error(problem);
              settings.fallbacks = [...(settings.fallbacks ?? []).filter(id => id !== provider), provider];
            } else {
              settings.provider = provider;
              settings.fallbacks = (settings.fallbacks ?? []).filter(id => id !== provider);
            }
            await browser.storage.local.set({ [SETTINGS_KEY]: settings });
            sendResponse({
              success: true,
              data: { maskedKey: maskKey(settings.keys[provider] ?? ''), provider: settings.provider, fallbacks: settings.fallbacks },
            });
            break;
          }

          case 'SET_MAIN_PROVIDER': {
            // From the panel's model menu: one of the providers already set up
            const { provider } = payload ?? {};
            if (!isProvider(provider)) throw new Error('Unknown provider');
            const settings = await loadSettings();
            const problem = configProblem(resolveConfig(settings, provider));
            if (problem) throw new Error(problem);
            const next = makeMain(settings, provider);
            await browser.storage.local.set({ [SETTINGS_KEY]: next });
            sendResponse({ success: true, data: { provider: next.provider, fallbacks: next.fallbacks } });
            break;
          }

          case 'SAVE_EXECUTOR': {
            // Fast model for routine agent steps ({provider, model}), or null to turn it off
            const settings = await loadSettings();
            const { provider, model } = payload?.executor ?? {};
            if (!payload?.executor) {
              delete settings.executor;
            } else {
              if (!isProvider(provider)) throw new Error('Unknown provider');
              if (typeof model !== 'string' || !model.trim()) throw new Error('Choose a model for routine steps');
              settings.executor = { provider, model: model.trim() };
              const problem = configProblem({ ...resolveConfig(settings, provider), model: model.trim() });
              if (problem) throw new Error(problem);
            }
            await browser.storage.local.set({ [SETTINGS_KEY]: settings });
            sendResponse({ success: true, data: { executor: settings.executor ?? null } });
            break;
          }

          case 'SAVE_FALLBACKS': {
            // Backup providers, in order; each uses its own saved key and model
            const list: unknown[] = Array.isArray(payload?.fallbacks) ? payload.fallbacks : [];
            const settings = await loadSettings();
            settings.fallbacks = [...new Set(list.filter(isProvider))].filter(id => id !== settings.provider);
            await browser.storage.local.set({ [SETTINGS_KEY]: settings });
            sendResponse({ success: true, data: { fallbacks: settings.fallbacks } });
            break;
          }

          case 'LIST_MODELS': {
            // Uses a key typed into Settings (not saved yet) or the saved one
            const { provider, apiKey, customBaseUrl } = payload ?? {};
            if (!isProvider(provider)) throw new Error('Unknown provider');
            const settings = await loadSettings();
            if (typeof apiKey === 'string' && apiKey.trim()) settings.keys[provider] = apiKey.trim();
            if (provider === 'custom') settings.customBaseUrl = customBaseUrl ?? '';
            const config = resolveConfig(settings, provider);
            const urlError = config.baseUrl ? validateBaseUrl(config.baseUrl) : 'Enter the server URL first';
            if (urlError) throw new Error(urlError);
            if (PROVIDERS[provider].needsKey && !config.apiKey) throw new Error(`Enter your ${config.label} API key first`);
            sendResponse({ success: true, data: { models: await listModels(config) } });
            break;
          }

          case 'SUMMARIZE': {
            const { value: summary } = await ask((c) => summarizePage(payload.text, c));
            sendResponse({ success: true, data: { result: summary } });
            break;
          }

          case 'EXPLAIN': {
            const { value: explanation } = await ask((c) => explainText(payload.text, c));
            sendResponse({ success: true, data: { result: explanation } });
            break;
          }

          case 'CHAT': {
            const { value: reply } = await ask((c) => chatWithPage(payload.message, payload.pageContext || '', c));
            sendResponse({ success: true, data: { result: reply } });
            break;
          }

          case 'START_AGENT': {
            // The side panel asks; the background runs the whole task, surviving page loads
            const tabId = senderTab;
            if (tabId === undefined) throw new Error('No tab');
            const goal = String(payload?.goal ?? '').trim();
            if (!goal) throw new Error('No goal');
            await requireConfig(); // fail fast on missing key/model, before the run starts
            const prefs = await loadPrefs();
            runAgent(tabId, goal, {
              checkpoint: prefs.stepCheckpoint, split: hasExecutor(await loadSettings()), screenshots: prefs.screenshots,
              ...await skillsFor(payload?.skill), ...await autofillOptions(payload?.autofill),
              customCode: prefs.customCode, confirm: prefs.confirmRisky, critic: prefs.critic, source: 'panel',
            });
            sendResponse({ success: true });
            break;
          }

          case 'START_BACKGROUND_TASK': {
            // "Run in background": a new tab beside this one, in the Tabi group, from this page
            // (or payload.url). payload.workflow replays one; otherwise payload.goal goes to the agent.
            const from = senderTab !== undefined ? await chrome.tabs.get(senderTab).catch(() => null) : null;
            const url = String(payload?.url ?? from?.url ?? '');
            if (!/^https?:\/\//.test(url)) throw new Error('Background tasks start from a web page (http or https)');
            let workflow: Workflow | undefined;
            let goal = String(payload?.goal ?? '').trim();
            if (payload?.workflow) {
              workflow = (await loadWorkflows(skillStorage)).find((w) => w.name === slugify(String(payload.workflow)));
              if (!workflow) throw new Error(`There is no workflow named "${payload.workflow}"`);
              goal = workflow.goal;
            } else {
              if (!goal) throw new Error('No task to run');
              await requireConfig();
            }
            const skills = await skillsFor(workflow ? undefined : payload?.skill);
            const autofill = workflow ? {} : await autofillOptions(payload?.autofill);
            const tab = await chrome.tabs.create({
              url: workflow?.startUrl ?? url, active: false,
              ...(from ? { windowId: from.windowId, index: from.index + 1 } : {}),
            });
            await groupTab(tab.id, tab.windowId);
            backgroundTabs.add(tab.id);
            const prefs = await loadPrefs();
            runAgent(tab.id, goal, {
              checkpoint: prefs.stepCheckpoint, split: hasExecutor(await loadSettings()), screenshots: prefs.screenshots,
              ...skills, ...autofill, customCode: prefs.customCode, confirm: prefs.confirmRisky, critic: prefs.critic, workflow, source: 'background',
            });
            sendResponse({ success: true, data: { tabId: tab.id } });
            break;
          }

          case 'LIST_TASKS': {
            // Every tab's task, waiting ones included, for the task lists
            const runs = [...listRuns(), ...[...queuedViews].map(([tabId, view]) => ({ ...view, tabId }))];
            const tasks = await Promise.all(runs.map(async (r) => {
              const tab = await chrome.tabs.get(r.tabId).catch(() => null);
              return tab ? { tabId: r.tabId, goal: r.goal, status: r.status, step: r.step, model: r.model, updatedAt: r.updatedAt, asking: r.asking, runId: r.runId, title: tab.title, background: backgroundTabs.has(r.tabId), here: r.tabId === senderTab } : null;
            }));
            const order = ['running', 'paused', 'queued', 'done', 'error', 'stopped'];
            sendResponse({
              success: true,
              data: tasks.filter(Boolean).sort((a: any, b: any) => order.indexOf(a.status) - order.indexOf(b.status) || b.updatedAt - a.updatedAt),
            });
            break;
          }

          case 'TASK_CONTROL': {
            // From a task list: open, stop or continue another tab's task
            const tabId = Number(payload?.tabId);
            if (payload?.op === 'open') {
              const tab = await chrome.tabs.update(tabId, { active: true });
              await chrome.windows.update(tab.windowId, { focused: true });
            } else if (payload?.op === 'stop') {
              if (!taskQueue.cancel(tabId)) stopRun(tabId);
            } else if (payload?.op === 'continue') {
              resumeRun(tabId);
            } else if (payload?.op === 'allow' || payload?.op === 'deny') {
              answerRun(tabId, payload.op === 'allow');
            }
            sendResponse({ success: true });
            break;
          }

          case 'STOP_AGENT': {
            const tabId = senderTab;
            if (tabId !== undefined) {
              // A task still waiting for a slot is just taken out of the line
              if (taskQueue.cancel(tabId)) {
                const stopped: RunView = { goal: '', status: 'stopped', message: "## ⏹️ Stopped\n\nIt hadn't started yet.", loading: false, step: 0, plan: [], steps: [], updatedAt: Date.now() };
                pushView(tabId, stopped);
              } else if (payload?.forget) forgetRun(tabId);
              else stopRun(tabId);
            }
            sendResponse({ success: true });
            break;
          }

          case 'RESUME_AGENT': {
            // Continue a run paused at a checkpoint or because it looked stuck
            const tabId = senderTab;
            if (tabId !== undefined) resumeRun(tabId);
            sendResponse({ success: true });
            break;
          }

          case 'ANSWER_AGENT': {
            // "Allow this?": the user allows the action, or doesn't
            const tabId = senderTab;
            if (tabId !== undefined) answerRun(tabId, !!payload?.allow);
            sendResponse({ success: true });
            break;
          }

          case 'HINT_AGENT': {
            // Typed in the side panel while the run waits for the user
            const tabId = senderTab;
            sendResponse({ success: true, data: tabId !== undefined && hintRun(tabId, String(payload?.text ?? '')) });
            break;
          }

          case 'GET_AGENT_STATE': {
            // A freshly loaded page asks what the agent is doing in its tab
            const tabId = senderTab;
            sendResponse({ success: true, data: tabId === undefined ? null : queuedViews.get(tabId) ?? getRunView(tabId) });
            break;
          }

          case 'TRUSTED_INPUT': {
            // Real mouse/keyboard input via the DevTools Protocol. On any failure
            // the content script falls back to scripted DOM events.
            const tabId = _sender.tab?.id;
            if (tabId === undefined) throw new Error('No tab');
            const prefs = await loadPrefs();
            if (!prefs.trustedInput) throw new Error('Trusted input is turned off');
            const { kind, x, y, text, key } = payload ?? {};
            if (kind === 'click') await trustedClick(tabId, Number(x), Number(y));
            else if (kind === 'type') await trustedType(tabId, String(text ?? ''));
            else if (kind === 'key') await trustedKey(tabId, String(key ?? 'Enter'));
            else throw new Error(`Unknown trusted input: ${kind}`);
            sendResponse({ success: true });
            break;
          }

          case 'CODE_EDITOR': {
            // Set or read a code editor's content through its own API, in the
            // page's main world (lib/agent/codeEditor.ts)
            const tabId = _sender.tab?.id;
            if (tabId === undefined) throw new Error('No tab');
            const text = typeof payload?.text === 'string' ? payload.text : null;
            const [result] = await chrome.scripting.executeScript({
              target: { tabId, frameIds: [_sender.frameId ?? 0] },
              world: 'MAIN',
              func: setCodeInPage,
              args: [EDITOR_MARK, text, payload?.clear === true],
            });
            sendResponse({ success: true, data: result?.result ?? { ok: false, why: 'no result' } });
            break;
          }

          case 'FRAME_SNAPSHOTS': {
            // Find which frames received the top page's tokens (see lib/agent/frames.ts),
            // then collect a snapshot from each one's content script
            const tabId = _sender.tab?.id;
            if (tabId === undefined) throw new Error('No tab');
            const tokens: string[] = Array.isArray(payload?.tokens) ? payload.tokens : [];
            const probes = await chrome.scripting.executeScript({
              target: { tabId, allFrames: true },
              func: () => (globalThis as any).__tabiFrameToken ?? null,
            });
            const frames = probes.filter((p: any) => p.frameId !== 0 && tokens.includes(p.result));
            const data = await Promise.all(frames.map(async (p: any) => {
              try {
                const res = await withTimeout(
                  chrome.tabs.sendMessage(tabId, { action: 'FRAME_SNAPSHOT' }, { frameId: p.frameId }),
                  3000,
                  'Frame snapshot',
                ) as any;
                return { token: p.result, frameId: p.frameId, snapshot: res?.success ? res.data : null };
              } catch {
                return { token: p.result, frameId: p.frameId, snapshot: null };
              }
            }));
            sendResponse({ success: true, data });
            break;
          }

          case 'FRAME_EXECUTE': {
            // Run an agent action inside a cross-origin frame's content script
            const tabId = _sender.tab?.id;
            if (tabId === undefined) throw new Error('No tab');
            const { frameId, action: frameAction, offset } = payload ?? {};
            const res = await withTimeout(
              chrome.tabs.sendMessage(tabId, { action: 'FRAME_EXECUTE', payload: { action: frameAction, offset } }, { frameId }),
              30000,
              'Frame action',
            ) as any;
            if (!res?.success) throw new Error(res?.error || 'The frame did not respond');
            sendResponse({ success: true, data: res.data });
            break;
          }

          case 'LIST_SKILLS': {
            sendResponse({ success: true, data: await loadSkills(skillStorage) });
            break;
          }

          case 'SAVE_SKILL': {
            // A pasted or edited SKILL.md
            const parsed = parseSkill(String(payload?.text ?? ''));
            if (!parsed.ok) throw new Error(parsed.error);
            sendResponse({ success: true, data: await saveSkill(skillStorage, parsed.skill) });
            break;
          }

          case 'DELETE_SKILL': {
            sendResponse({ success: true, data: await deleteSkill(skillStorage, String(payload?.name ?? '')) });
            break;
          }

          case 'LIST_SCHEDULES': {
            sendResponse({ success: true, data: await loadSchedules(skillStorage) });
            break;
          }

          case 'SAVE_SCHEDULE': {
            sendResponse({ success: true, data: await saveSchedule(schedulerDeps, payload ?? {}) });
            break;
          }

          case 'DELETE_SCHEDULE': {
            sendResponse({ success: true, data: await deleteSchedule(schedulerDeps, String(payload?.id ?? '')) });
            break;
          }

          case 'TOGGLE_SCHEDULE': {
            sendResponse({ success: true, data: await setEnabled(schedulerDeps, String(payload?.id ?? ''), !!payload?.enabled) });
            break;
          }

          case 'RUN_SCHEDULE_NOW': {
            // Runs in the background like a scheduled run; a notification says how it went
            runSchedule(schedulerDeps, String(payload?.id ?? '')).catch((err) => console.error('[Tabi] Schedule:', err));
            sendResponse({ success: true });
            break;
          }

          case 'LIST_SHORTCUTS': {
            sendResponse({ success: true, data: await loadShortcuts(skillStorage) });
            break;
          }

          case 'SAVE_SHORTCUT': {
            const shortcuts = await saveShortcut(skillStorage, { name: String(payload?.name ?? ''), prompt: String(payload?.prompt ?? '') });
            sendResponse({ success: true, data: shortcuts });
            break;
          }

          case 'DELETE_SHORTCUT': {
            sendResponse({ success: true, data: await deleteShortcut(skillStorage, String(payload?.name ?? '')) });
            break;
          }

          case 'PICKER_ITEMS': {
            // The side panel's / picker: workflows (replayed), shortcuts (saved prompts) and skills (instructions for a task)
            const [workflows, shortcuts, skills] = await Promise.all([loadWorkflows(skillStorage), loadShortcuts(skillStorage), loadSkills(skillStorage)]);
            sendResponse({
              success: true,
              data: [
                ...workflows.map((w) => ({ kind: 'workflow', name: w.name, detail: w.goal, steps: w.steps.length, site: hostOf(w.startUrl) })),
                ...shortcuts.map((s) => ({ kind: 'shortcut', name: s.name, detail: s.prompt })),
                ...skills.map((s) => ({ kind: 'skill', name: s.name, detail: s.description, ...(s.sites.length ? { site: s.sites.join(', ') } : {}) })),
              ],
            });
            break;
          }

          case 'LIST_WORKFLOWS': {
            sendResponse({ success: true, data: await loadWorkflows(skillStorage) });
            break;
          }

          case 'DELETE_WORKFLOW': {
            sendResponse({ success: true, data: await deleteWorkflow(skillStorage, String(payload?.name ?? '')) });
            break;
          }

          case 'SAVE_WORKFLOW_FROM_RUN': {
            // "Save as workflow" in the side panel; with a name, updates that workflow (after the agent healed it)
            const tabId = senderTab;
            const record = tabId === undefined ? null : getRunRecord(tabId);
            if (!record) throw new Error('There is no finished task in this tab to save');
            if (record.status !== 'done') throw new Error('Only a task that finished can be saved as a workflow');
            if (record.unrecordable) throw new Error(`This task can't be replayed: ${record.unrecordable}`);
            if (record.trace.length === 0) throw new Error('This task had no steps to replay');
            const workflow: Workflow = {
              name: slugify(String(payload?.name ?? '')) || workflowName(record.goal, record.trace),
              goal: record.goal,
              startUrl: record.startUrl,
              steps: record.trace,
              finalUrl: record.finalUrl,
              finalTitle: record.finalTitle,
              hasPassword: record.trace.some((s) => /type="password"/.test(s.target?.key ?? '') && !!s.action.text),
            };
            await saveWorkflow(skillStorage, workflow);
            sendResponse({ success: true, data: workflow });
            break;
          }

          case 'RUN_WORKFLOW': {
            // From the side panel (/name, in its tab) or Settings (Run: in a new tab where it starts).
            // Replay needs no model unless a step fails and the agent has to take over.
            const workflow = (await loadWorkflows(skillStorage)).find((w) => w.name === slugify(String(payload?.name ?? '')));
            if (!workflow) throw new Error(`There is no workflow named "${payload?.name}"`);
            const tabId = senderTab ?? (await chrome.tabs.create({ url: workflow.startUrl ?? 'about:blank', active: true })).id;
            if (tabId === undefined) throw new Error('No tab to run it in');
            const prefs = await loadPrefs();
            runAgent(tabId, workflow.goal, {
              checkpoint: prefs.stepCheckpoint, split: hasExecutor(await loadSettings()), screenshots: prefs.screenshots,
              skills: await loadSkills(skillStorage), customCode: prefs.customCode, confirm: prefs.confirmRisky, critic: prefs.critic, workflow, ...(senderTab !== undefined ? { source: 'panel' as const } : {}),
            });
            sendResponse({ success: true, data: { name: workflow.name, steps: workflow.steps.length } });
            break;
          }

          case 'SAVE_SKILL_FROM_RUN': {
            // "Save as skill" in the side panel, after a task finished
            const tabId = senderTab;
            const record = tabId === undefined ? null : getRunRecord(tabId);
            if (!record) throw new Error('There is no finished task in this tab to learn from');
            if (record.status !== 'done') throw new Error('Only a task that finished can be saved as a skill');
            const { value: skill } = await ask((c) => writeSkillFromRun(record, c));
            await saveSkill(skillStorage, skill);
            sendResponse({ success: true, data: { skill, markdown: formatSkill(skill) } });
            break;
          }

          case 'GET_MCP': {
            // Settings sees whether a token is saved, never the token
            const mcp = await loadMcp();
            sendResponse({
              success: true,
              data: { enabled: mcp.enabled, port: mcp.port, hasToken: isValidToken(mcp.token), ...mcpStatus },
            });
            break;
          }

          case 'SAVE_MCP': {
            const mcp = await loadMcp();
            const { enabled, token, port } = payload ?? {};
            if (typeof token === 'string' && token.trim()) {
              if (!isValidToken(token)) throw new Error("That isn't a Tabi pairing token: it starts with tbk_, followed by 64 letters and digits. Run \"tabi-mcp token\" to see yours.");
              mcp.token = normalizeToken(token);
            }
            if (typeof port === 'number' && Number.isInteger(port) && port > 1023 && port < 65536) mcp.port = port;
            if (typeof enabled === 'boolean') mcp.enabled = enabled;
            if (mcp.enabled && !isValidToken(mcp.token)) throw new Error('Paste the pairing token first (run "tabi-mcp token" to see it)');
            await browser.storage.local.set({ [MCP_KEY]: mcp });
            await applyMcp();
            sendResponse({ success: true, data: { enabled: mcp.enabled, port: mcp.port, hasToken: isValidToken(mcp.token), ...mcpStatus } });
            break;
          }

          case 'COLOR_SCHEME': {
            const next: Scheme = payload === 'dark' ? 'dark' : 'light';
            if (next !== scheme) {
              scheme = next;
              paintToolbar();
              chrome.storage.session.set({ tabi_scheme: scheme }).catch(() => {});
            }
            sendResponse({ success: true });
            break;
          }

          case 'GET_PREFS': {
            sendResponse({ success: true, data: await loadPrefs() });
            break;
          }

          case 'LIST_RUNS': {
            sendResponse({ success: true, data: (await loadRunLogs()).map(runHeader) });
            break;
          }

          case 'GET_RUN': {
            sendResponse({ success: true, data: (await loadRunLogs()).find((r) => r.id === payload?.id) ?? null });
            break;
          }

          case 'DELETE_RUNS': {
            // payload.id: one run; none: all of them
            await editRunLogs((runs) => (payload?.id ? runs.filter((r) => r.id !== payload.id) : []));
            sendResponse({ success: true });
            break;
          }

          case 'OPEN_SETTINGS': {
            // From the side panel: Settings at a section, in its open tab if there is one
            const section = /^[a-z]+$/.test(String(payload?.section ?? '')) ? String(payload.section) : '';
            const base = browser.runtime.getURL('/options.html' as any);
            const url = section ? `${base}#${section}` : base;
            // Tabi's own open pages (tab URLs aren't visible without the tabs permission)
            const contexts: { tabId: number; documentUrl?: string }[] = await chrome.runtime.getContexts?.({ contextTypes: ['TAB'] }).catch(() => []) ?? [];
            const open = contexts.find((c) => c.tabId >= 0 && c.documentUrl?.startsWith(base));
            const tab = open ? await chrome.tabs.update(open.tabId, { url, active: true }) : await chrome.tabs.create({ url, active: true });
            chrome.windows.update(tab.windowId, { focused: true });
            sendResponse({ success: true });
            break;
          }

          case 'OPEN_HISTORY': {
            await openHistory(payload?.runId);
            sendResponse({ success: true });
            break;
          }

          case 'GET_SITES': {
            sendResponse({ success: true, data: await loadSiteRules() });
            break;
          }

          case 'SAVE_SITES': {
            // payload: { list: 'blocked' | 'allowed', add?: string, remove?: string }
            const list = payload?.list === 'allowed' ? 'allowed' : 'blocked';
            const rules = await loadSiteRules();
            if (payload?.add !== undefined) {
              const site = normalizeSite(String(payload.add));
              if (!site) throw new Error(`"${payload.add}" isn't a site. Type one like example.com`);
              // A site lives on one list: blocking it takes it off the allow list
              rules.blocked = rules.blocked.filter((s) => s !== site);
              rules.allowed = rules.allowed.filter((s) => s !== site);
              rules[list].push(site);
            }
            if (payload?.remove !== undefined) rules[list] = rules[list].filter((s) => s !== payload.remove);
            await browser.storage.local.set({ [SITES_KEY]: rules });
            sendResponse({ success: true, data: rules });
            break;
          }

          case 'SAVE_PREFS': {
            const prefs = { ...(await loadPrefs()), ...(payload ?? {}) };
            await browser.storage.local.set({ [PREFS_KEY]: prefs });
            sendResponse({ success: true, data: prefs });
            break;
          }

          default:
            sendResponse({ success: false, error: `Unknown action: ${action}` });
        }
      } catch (error) {
        console.error('[Tabi] Background error:', error);
        sendResponse({ success: false, error: formatError(error) });
      }
    })();

    // Keeps the channel open for the reply sent above, after the awaits
    return true;
  });
});
