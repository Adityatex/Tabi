// The side panel's connections: which tab it shows, the runs the background
// pushes, the task list, and the bits of settings it displays.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { RunView } from '@/lib/agent/runner';
import { PROVIDERS, type ProviderId } from '@/lib/api/providers';
import type { TaskRow } from './components/TasksStrip';

/** Ask the background worker; resolves with its reply ({ success, data, error }). */
export function send<T = any>(action: string, payload?: unknown): Promise<{ success: boolean; data?: T; error?: string }> {
  return (browser.runtime.sendMessage({ action, payload }) as Promise<any>)
    .then((res) => res ?? { success: false, error: 'No reply from Tabi' })
    .catch((err: Error) => ({ success: false, error: err?.message ?? String(err) }));
}

/** Ask the page's content script (its text, the selection, an autofill). */
export async function askPage<T = any>(tabId: number, action: string, extra: Record<string, unknown> = {}): Promise<T> {
  try {
    return await browser.tabs.sendMessage(tabId, { action, ...extra }, { frameId: 0 }) as T;
  } catch {
    throw new Error('Tabi can’t read this page. If it was open before Tabi was installed or updated, reload it and try again.');
  }
}

export interface TabInfo {
  id: number;
  url?: string;
  title?: string;
}

/**
 * The tab the panel works on: the active tab of its window, followed as the
 * user switches tabs. `?tab=<id>` pins one (used when the panel is opened as
 * a page, e.g. by the end-to-end tests).
 */
export function useCurrentTab(): TabInfo | null {
  const [tab, setTab] = useState<TabInfo | null>(null);
  useEffect(() => {
    const pinned = Number(new URLSearchParams(location.search).get('tab')) || undefined;
    let windowId: number | undefined;
    let current: number | undefined = pinned;
    const show = (t: { id?: number; url?: string; title?: string } | undefined) => {
      if (!t?.id) return;
      current = t.id;
      setTab({ id: t.id, url: t.url, title: t.title });
    };
    if (pinned) browser.tabs.get(pinned).then(show).catch(() => {});
    else {
      browser.windows.getCurrent().then((w) => {
        windowId = w.id;
        return browser.tabs.query({ active: true, windowId });
      }).then(([t]) => show(t)).catch(() => {});
    }
    const onActivated = (info: { tabId: number; windowId: number }) => {
      if (pinned || info.windowId !== windowId) return;
      browser.tabs.get(info.tabId).then(show).catch(() => {});
    };
    const onUpdated = (tabId: number, change: { url?: string; title?: string; status?: string }, t: { id?: number; url?: string; title?: string }) => {
      if (tabId === current && (change.url || change.title || change.status)) show(t);
    };
    browser.tabs.onActivated.addListener(onActivated);
    browser.tabs.onUpdated.addListener(onUpdated);
    return () => {
      browser.tabs.onActivated.removeListener(onActivated);
      browser.tabs.onUpdated.removeListener(onUpdated);
    };
  }, []);
  return tab;
}

/** A finished run is shown again when the panel opens only if it ended this recently. */
const RECENT_MS = 2 * 60_000;

/** Every tab's latest run, as the background pushes them, plus the current tab's when the panel looks. */
export function useRuns(tabId: number | undefined, onUpdate: (tabId: number, view: RunView) => void) {
  const [runs, setRuns] = useState<Map<number, RunView>>(new Map());
  const callback = useRef(onUpdate);
  callback.current = onUpdate;

  useEffect(() => {
    const listener = (message: any) => {
      if (message?.action !== 'AGENT_UPDATE' || typeof message.tabId !== 'number') return;
      const view = message.payload as RunView;
      setRuns((prev) => new Map(prev).set(message.tabId, view));
      callback.current(message.tabId, view);
    };
    browser.runtime.onMessage.addListener(listener);
    return () => browser.runtime.onMessage.removeListener(listener);
  }, []);

  // A tab the panel hasn't heard about yet: ask what's running there
  useEffect(() => {
    if (tabId === undefined) return;
    send<RunView | null>('GET_AGENT_STATE', { tabId }).then((res) => {
      const view = res.data;
      if (!view) return;
      const live = view.status === 'running' || view.status === 'paused' || view.status === 'queued';
      if (!live && Date.now() - view.updatedAt > RECENT_MS) return;
      setRuns((prev) => (prev.has(tabId) ? prev : new Map(prev).set(tabId, view)));
      callback.current(tabId, view);
    });
  }, [tabId]);

  const forget = useCallback((id: number) => setRuns((prev) => {
    const next = new Map(prev);
    next.delete(id);
    return next;
  }), []);

  return { runs, forget };
}

/** Finished tasks stay in the list this long. */
const KEEP_FINISHED_MS = 10 * 60_000;

/** Tasks in other tabs, refreshed every few seconds while the panel is open, and their tabs' positions. */
export function useTasks(tabId: number | undefined, nudge: number) {
  const [tasks, setTasks] = useState<TaskRow[]>([]);
  const [indexes, setIndexes] = useState<Map<number, number>>(new Map());
  useEffect(() => {
    let stopped = false;
    const load = async () => {
      const res = await send<TaskRow[]>('LIST_TASKS', { tabId });
      if (stopped || !res.success) return;
      const now = Date.now();
      setTasks((res.data ?? []).filter((t) => t.tabId !== tabId
        && (['running', 'paused', 'queued'].includes(t.status) || now - t.updatedAt < KEEP_FINISHED_MS)));
      const all = await browser.tabs.query({}).catch(() => []);
      if (!stopped) setIndexes(new Map(all.filter((t) => t.id !== undefined).map((t) => [t.id!, t.index])));
    };
    load();
    const timer = setInterval(load, 3000);
    return () => { stopped = true; clearInterval(timer); };
  }, [tabId, nudge]);
  return { tasks, tabIndex: (id: number) => indexes.get(id) };
}

export interface ModelInfo {
  /** "Groq · qwen3.8-27b", or '' when nothing is set up. */
  label: string;
  /** "Groq" */
  provider: string;
  /** The main and fast models' full labels, to tell a backup taking over from them. */
  main: string;
  fast?: string;
  ready: boolean;
}

/** The provider and model shown in the header, and whether irreversible actions ask first. */
export function useSettings() {
  const [model, setModel] = useState<ModelInfo>({ label: '', provider: '', main: '', ready: true });
  const [confirmOn, setConfirmOn] = useState(true);
  useEffect(() => {
    const load = async () => {
      const [settings, prefs] = await Promise.all([send('GET_LLM_SETTINGS'), send('GET_PREFS')]);
      if (settings.success) {
        const { provider, models, ready, executor } = settings.data;
        const name: string = PROVIDERS[provider as ProviderId]?.label ?? provider;
        const id: string = models?.[provider] ?? '';
        setModel({
          label: id ? `${name} · ${id.replace(/^[^/]+\//, '')}` : '',
          provider: name,
          main: `${name} · ${id}`,
          fast: executor ? `${PROVIDERS[executor.provider as ProviderId]?.label} · ${executor.model}` : undefined,
          ready: (ready as string[]).includes(provider),
        });
      }
      if (prefs.success) setConfirmOn(prefs.data?.confirmRisky !== false);
    };
    load();
    const onChanged = (_changes: unknown, area: string) => { if (area === 'local') load(); };
    browser.storage.onChanged.addListener(onChanged);
    return () => browser.storage.onChanged.removeListener(onChanged);
  }, []);
  return { model, confirmOn };
}
