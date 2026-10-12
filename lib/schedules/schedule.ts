// Schedules: run a workflow or shortcut automatically, hourly, daily or
// weekly, in local time. Times and storage here (no Chrome APIs); the
// background's scheduler (lib/schedules/scheduler.ts) sets the alarms and runs them.

import type { KeyValueStorage } from '@/lib/skills/store';

export type Frequency = 'hourly' | 'daily' | 'weekly';

export interface ScheduleResult {
  at: number;
  /** done, paused, stopped or error (as the run ended), or "missed" if it couldn't start. */
  status: string;
  summary: string;
  /** Its timeline on the History page. */
  runId?: string;
}

export interface Schedule {
  id: string;
  kind: 'workflow' | 'shortcut';
  /** The workflow's or shortcut's /name. */
  name: string;
  /** Shortcuts: words for its blanks, and the page to start on. */
  args?: string;
  url?: string;
  frequency: Frequency;
  /** "HH:MM", local time. Hourly uses only the minutes. */
  time: string;
  /** Weekly: 0 = Sunday ... 6 = Saturday. */
  weekday?: number;
  enabled: boolean;
  /** When it should run next (ms since epoch). */
  nextRun?: number;
  lastRun?: ScheduleResult;
}

const SCHEDULES_KEY = 'tabi_schedules';
export const MAX_SCHEDULES = 50;

function parseTime(time: string): { h: number; m: number } {
  const m = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  const h = m ? Math.min(23, Number(m[1])) : 9;
  const min = m ? Math.min(59, Number(m[2])) : 0;
  return { h, m: min };
}

/** The first time after `from` the schedule should run, in local time. */
export function nextRunAt(schedule: Pick<Schedule, 'frequency' | 'time' | 'weekday'>, from: number): number {
  const { h, m } = parseTime(schedule.time);
  const next = new Date(from);
  next.setSeconds(0, 0);
  if (schedule.frequency === 'hourly') {
    next.setMinutes(m);
    if (next.getTime() <= from) next.setHours(next.getHours() + 1);
    return next.getTime();
  }
  next.setHours(h, m);
  if (schedule.frequency === 'daily') {
    if (next.getTime() <= from) next.setDate(next.getDate() + 1);
    return next.getTime();
  }
  // Weekly: move forward to the weekday, then a week on if that's not after `from`
  const weekday = schedule.weekday ?? 1;
  next.setDate(next.getDate() + ((weekday - next.getDay() + 7) % 7));
  if (next.getTime() <= from) next.setDate(next.getDate() + 7);
  return next.getTime();
}

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** "Every day at 09:00", "Every hour at :15", "Every Monday at 08:30". */
export function describeFrequency(schedule: Pick<Schedule, 'frequency' | 'time' | 'weekday'>): string {
  const { h, m } = parseTime(schedule.time);
  const hhmm = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  if (schedule.frequency === 'hourly') return `Every hour at :${String(m).padStart(2, '0')}`;
  if (schedule.frequency === 'daily') return `Every day at ${hhmm}`;
  return `Every ${DAYS[schedule.weekday ?? 1]} at ${hhmm}`;
}

/** Why a schedule can't be saved, or null. */
export function scheduleProblem(s: Partial<Schedule>): string | null {
  if (s.kind !== 'workflow' && s.kind !== 'shortcut') return 'Pick a workflow or shortcut to run';
  if (!s.name) return 'Pick a workflow or shortcut to run';
  if (!['hourly', 'daily', 'weekly'].includes(String(s.frequency))) return 'Pick how often to run it';
  if (!/^\d{1,2}:\d{2}$/.test(String(s.time ?? ''))) return 'Enter a time like 09:00';
  if (s.frequency === 'weekly' && !(Number.isInteger(s.weekday) && s.weekday! >= 0 && s.weekday! <= 6)) return 'Pick a day of the week';
  if (s.kind === 'shortcut') {
    try {
      const url = new URL(String(s.url ?? ''));
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'The start page must be an http(s) address';
    } catch {
      return 'A shortcut needs a page to start on, e.g. https://example.com';
    }
  }
  return null;
}

export async function loadSchedules(storage: KeyValueStorage): Promise<Schedule[]> {
  const stored = (await storage.get(SCHEDULES_KEY))[SCHEDULES_KEY];
  return Array.isArray(stored) ? (stored as Schedule[]) : [];
}

export async function storeSchedules(storage: KeyValueStorage, schedules: Schedule[]): Promise<void> {
  await storage.set({ [SCHEDULES_KEY]: schedules });
}
