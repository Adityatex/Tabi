// Runs schedules (lib/schedules/schedule.ts) in the background service worker:
// one Chrome alarm per schedule, set for its next run. Chrome can drop alarms
// on restart, so they're re-set from storage whenever the worker starts, and a
// run missed while the browser was closed happens once on the next start.
// Chrome specifics are injected so this can be tested.

import type { KeyValueStorage } from '@/lib/skills/store';
import {
  loadSchedules, storeSchedules, nextRunAt, scheduleProblem, MAX_SCHEDULES, type Schedule,
} from '@/lib/schedules/schedule';

export interface SchedulerDeps {
  storage: KeyValueStorage;
  now(): number;
  setAlarm(name: string, when: number): void;
  clearAlarm(name: string): void;
  /** Run a schedule's workflow or shortcut in a background tab; resolves when it ends. */
  run(schedule: Schedule): Promise<{ status: string; summary: string; runId?: string }>;
  /** Tell the user how a run went; `runId` = its timeline, for clicking through to it. */
  notify(title: string, message: string, runId?: string): void;
}

const ALARM_PREFIX = 'tabi-schedule:';
/** A run more than this late counts as missed (the browser was closed or asleep). */
const MISSED_AFTER_MS = 60_000;

export const alarmName = (id: string) => `${ALARM_PREFIX}${id}`;
const scheduleIdOf = (alarm: string) => (alarm.startsWith(ALARM_PREFIX) ? alarm.slice(ALARM_PREFIX.length) : null);

/** Schedules being run now, so an alarm and "Run now" can't start the same one twice. */
const running = new Set<string>();

function arm(deps: SchedulerDeps, schedule: Schedule): void {
  if (schedule.enabled && schedule.nextRun) deps.setAlarm(alarmName(schedule.id), schedule.nextRun);
  else deps.clearAlarm(alarmName(schedule.id));
}

async function update(deps: SchedulerDeps, id: string, change: (s: Schedule) => Schedule): Promise<Schedule | null> {
  const all = await loadSchedules(deps.storage);
  const i = all.findIndex((s) => s.id === id);
  if (i < 0) return null;
  all[i] = change(all[i]);
  await storeSchedules(deps.storage, all);
  return all[i];
}

/** Add or change a schedule; returns them all. */
export async function saveSchedule(deps: SchedulerDeps, input: Partial<Schedule>): Promise<Schedule[]> {
  const problem = scheduleProblem(input);
  if (problem) throw new Error(problem);
  const all = await loadSchedules(deps.storage);
  const existing = input.id ? all.find((s) => s.id === input.id) : undefined;
  if (!existing && all.length >= MAX_SCHEDULES) throw new Error(`You have ${MAX_SCHEDULES} schedules already; delete some first`);
  const schedule: Schedule = {
    id: existing?.id ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`,
    kind: input.kind!,
    name: input.name!,
    ...(input.kind === 'shortcut' ? { args: input.args ?? '', url: input.url } : {}),
    frequency: input.frequency!,
    time: input.time!,
    ...(input.frequency === 'weekly' ? { weekday: input.weekday } : {}),
    enabled: input.enabled ?? existing?.enabled ?? true,
    nextRun: nextRunAt(input as Schedule, deps.now()),
    ...(existing?.lastRun ? { lastRun: existing.lastRun } : {}),
  };
  const next = existing ? all.map((s) => (s.id === schedule.id ? schedule : s)) : [...all, schedule];
  await storeSchedules(deps.storage, next);
  arm(deps, schedule);
  return next;
}

export async function deleteSchedule(deps: SchedulerDeps, id: string): Promise<Schedule[]> {
  const next = (await loadSchedules(deps.storage)).filter((s) => s.id !== id);
  await storeSchedules(deps.storage, next);
  deps.clearAlarm(alarmName(id));
  return next;
}

export async function setEnabled(deps: SchedulerDeps, id: string, enabled: boolean): Promise<Schedule[]> {
  const schedule = await update(deps, id, (s) => ({ ...s, enabled, nextRun: nextRunAt(s, deps.now()) }));
  if (schedule) arm(deps, schedule);
  return loadSchedules(deps.storage);
}

/**
 * Run a schedule now (its alarm went off, or "Run now"), record how it went
 * and tell the user. The next run is set before this one starts, so a crash
 * mid-run never stops the schedule.
 */
export async function runSchedule(deps: SchedulerDeps, id: string): Promise<void> {
  if (running.has(id)) return;
  const schedule = await update(deps, id, (s) => ({ ...s, nextRun: nextRunAt(s, deps.now()) }));
  if (!schedule) return;
  arm(deps, schedule);
  running.add(id);
  const started = deps.now();
  let result: { status: string; summary: string; runId?: string };
  try {
    result = await deps.run(schedule);
  } catch (err) {
    result = { status: 'error', summary: String((err as Error)?.message ?? err) };
  } finally {
    running.delete(id);
  }
  await update(deps, id, (s) => ({ ...s, lastRun: { at: started, ...result, summary: result.summary.slice(0, 300) } }));
  const icon = result.status === 'done' ? '✅' : result.status === 'paused' ? '⏸️' : '⚠️';
  deps.notify(`${icon} Tabi: /${schedule.name}`, result.summary.slice(0, 250) || result.status, result.runId);
}

/** An alarm went off: run its schedule if it's still on. */
export async function onScheduleAlarm(deps: SchedulerDeps, alarm: string): Promise<void> {
  const id = scheduleIdOf(alarm);
  if (!id) return;
  const schedule = (await loadSchedules(deps.storage)).find((s) => s.id === id);
  if (schedule?.enabled) await runSchedule(deps, id);
}

/**
 * When the worker starts: set every enabled schedule's alarm again (Chrome may
 * have dropped them), and run once any that were missed while it was closed.
 */
export async function syncSchedules(deps: SchedulerDeps): Promise<void> {
  const now = deps.now();
  const missed: string[] = [];
  for (const schedule of await loadSchedules(deps.storage)) {
    if (!schedule.enabled) {
      deps.clearAlarm(alarmName(schedule.id));
      continue;
    }
    if (schedule.nextRun && schedule.nextRun < now - MISSED_AFTER_MS) missed.push(schedule.id);
    else arm(deps, schedule);
  }
  for (const id of missed) await runSchedule(deps, id);
}
