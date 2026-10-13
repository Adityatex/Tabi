import { describe, it, expect, vi } from 'vitest';
import { nextRunAt, describeFrequency, scheduleProblem, loadSchedules, type Schedule } from '@/lib/schedules/schedule';
import {
  saveSchedule, deleteSchedule, setEnabled, runSchedule, onScheduleAlarm, syncSchedules, retargetSchedules, alarmName, type SchedulerDeps,
} from '@/lib/schedules/scheduler';
import type { KeyValueStorage } from '@/lib/skills/store';

// Local times, as the scheduler uses them: Thursday 1 October 2026, 10:30
const at = (d: number, h: number, m: number) => new Date(2026, 9, d, h, m).getTime();
const NOW = at(1, 10, 30);

describe('next run times (local time)', () => {
  it('hourly: at the given minute of the next hour it has not passed', () => {
    expect(nextRunAt({ frequency: 'hourly', time: '00:45' }, NOW)).toBe(at(1, 10, 45));
    expect(nextRunAt({ frequency: 'hourly', time: '00:15' }, NOW)).toBe(at(1, 11, 15));
  });

  it('daily: today if the time is still ahead, else tomorrow', () => {
    expect(nextRunAt({ frequency: 'daily', time: '18:00' }, NOW)).toBe(at(1, 18, 0));
    expect(nextRunAt({ frequency: 'daily', time: '09:00' }, NOW)).toBe(at(2, 9, 0));
    expect(nextRunAt({ frequency: 'daily', time: '10:30' }, NOW)).toBe(at(2, 10, 30)); // exactly now counts as passed
  });

  it('weekly: the next such weekday at that time', () => {
    expect(nextRunAt({ frequency: 'weekly', time: '09:00', weekday: 5 }, NOW)).toBe(at(2, 9, 0)); // Friday
    expect(nextRunAt({ frequency: 'weekly', time: '18:00', weekday: 4 }, NOW)).toBe(at(1, 18, 0)); // later today
    expect(nextRunAt({ frequency: 'weekly', time: '09:00', weekday: 4 }, NOW)).toBe(at(8, 9, 0)); // passed: next week
  });

  it('describes itself', () => {
    expect(describeFrequency({ frequency: 'hourly', time: '00:05' })).toBe('Every hour at :05');
    expect(describeFrequency({ frequency: 'daily', time: '9:00' })).toBe('Every day at 09:00');
    expect(describeFrequency({ frequency: 'weekly', time: '08:30', weekday: 1 })).toBe('Every Monday at 08:30');
  });

  it('says what a schedule is missing', () => {
    expect(scheduleProblem({ kind: 'workflow', name: 'w', frequency: 'daily', time: '9am' })).toContain('time like 09:00');
    expect(scheduleProblem({ kind: 'shortcut', name: 's', frequency: 'daily', time: '09:00' })).toContain('page to start on');
    expect(scheduleProblem({ kind: 'shortcut', name: 's', frequency: 'daily', time: '09:00', url: 'file:///x' })).toContain('http(s)');
    expect(scheduleProblem({ kind: 'workflow', name: 'w', frequency: 'weekly', time: '09:00' })).toContain('day of the week');
    expect(scheduleProblem({ kind: 'workflow', name: 'w', frequency: 'daily', time: '09:00' })).toBeNull();
  });
});

function fake(run: SchedulerDeps['run'] = async () => ({ status: 'done', summary: 'Downloaded the report' })) {
  const data: Record<string, unknown> = {};
  const storage: KeyValueStorage = { get: async (k) => ({ [k]: data[k] }), set: async (items) => { Object.assign(data, items); } };
  let now = NOW;
  const alarms = new Map<string, number>();
  const notes: [string, string][] = [];
  const deps: SchedulerDeps = {
    storage,
    now: () => now,
    setAlarm: (name, when) => { alarms.set(name, when); },
    clearAlarm: (name) => { alarms.delete(name); },
    run: vi.fn(run),
    notify: (title, message) => { notes.push([title, message]); },
  };
  return { deps, alarms, notes, storage, advance: (ms: number) => { now += ms; } };
}

const daily: Partial<Schedule> = { kind: 'workflow', name: 'weekly-report', frequency: 'daily', time: '18:00' };

describe('the scheduler', () => {
  it('saves a schedule and sets its alarm for the next run', async () => {
    const { deps, alarms } = fake();
    const [s] = await saveSchedule(deps, daily);
    expect(s).toMatchObject({ name: 'weekly-report', enabled: true, nextRun: at(1, 18, 0) });
    expect(alarms.get(alarmName(s.id))).toBe(at(1, 18, 0));
  });

  it('runs on its alarm, sets the next run first, records the result and notifies', async () => {
    const { deps, alarms, notes, storage, advance } = fake();
    const [s] = await saveSchedule(deps, daily);
    advance(at(1, 18, 0) - NOW); // 18:00
    await onScheduleAlarm(deps, alarmName(s.id));
    expect(deps.run).toHaveBeenCalledTimes(1);
    const [after] = await loadSchedules(storage);
    expect(after.nextRun).toBe(at(2, 18, 0));
    expect(alarms.get(alarmName(s.id))).toBe(at(2, 18, 0));
    expect(after.lastRun).toEqual({ at: at(1, 18, 0), status: 'done', summary: 'Downloaded the report' });
    expect(notes).toEqual([['✅ Tabi: /weekly-report', 'Downloaded the report']]);
  });

  it('records a run that failed, and still runs next time', async () => {
    const { deps, notes, storage } = fake(async () => { throw new Error('The workflow /weekly-report no longer exists'); });
    const [s] = await saveSchedule(deps, daily);
    await runSchedule(deps, s.id);
    const [after] = await loadSchedules(storage);
    expect(after.lastRun).toMatchObject({ status: 'error', summary: 'The workflow /weekly-report no longer exists' });
    expect(after.nextRun).toBeGreaterThan(NOW);
    expect(notes[0][0]).toBe('⚠️ Tabi: /weekly-report');
  });

  it("doesn't start a schedule that is already running", async () => {
    let finish!: () => void;
    const { deps } = fake(() => new Promise((resolve) => { finish = () => resolve({ status: 'done', summary: 'ok' }); }));
    const [s] = await saveSchedule(deps, daily);
    const first = runSchedule(deps, s.id);
    await new Promise((r) => setTimeout(r, 0));
    await runSchedule(deps, s.id); // "Run now" while the alarm's run is going
    finish();
    await first;
    expect(deps.run).toHaveBeenCalledTimes(1);
  });

  it('ignores the alarm of a schedule that was turned off, and clears it', async () => {
    const { deps, alarms } = fake();
    const [s] = await saveSchedule(deps, daily);
    await setEnabled(deps, s.id, false);
    expect(alarms.has(alarmName(s.id))).toBe(false);
    await onScheduleAlarm(deps, alarmName(s.id));
    expect(deps.run).not.toHaveBeenCalled();
    await deleteSchedule(deps, s.id);
    expect(await loadSchedules(deps.storage)).toEqual([]);
  });

  it('on start, re-sets alarms Chrome may have dropped and runs once what was missed', async () => {
    const { deps, alarms, advance } = fake();
    const [missed] = await saveSchedule(deps, daily); // due 18:00 today
    const [, upcoming] = await saveSchedule(deps, { ...daily, name: 'other', frequency: 'weekly', weekday: 5, time: '09:00' }); // Friday
    alarms.clear(); // the browser restarted and lost them
    advance(at(1, 20, 0) - NOW); // 20:00: Chrome was closed at 18:00
    await syncSchedules(deps);
    expect(deps.run).toHaveBeenCalledTimes(1);
    expect((deps.run as any).mock.calls[0][0].id).toBe(missed.id);
    expect(alarms.get(alarmName(missed.id))).toBe(at(2, 18, 0));
    expect(alarms.get(alarmName(upcoming.id))).toBe(at(2, 9, 0));
    await syncSchedules(deps); // the worker starts again: nothing runs twice
    expect(deps.run).toHaveBeenCalledTimes(1);
  });
});

describe('schedules follow what they run', () => {
  it('go when their workflow is deleted, alarms and all, leaving the others', async () => {
    const { deps, alarms, storage } = fake();
    await saveSchedule(deps, daily);
    await saveSchedule(deps, { ...daily, time: '09:00' });
    const [, , other] = await saveSchedule(deps, { ...daily, name: 'other' });
    expect(await retargetSchedules(deps, 'workflow', 'weekly-report', null)).toBe(2);
    expect((await loadSchedules(storage)).map((s) => s.name)).toEqual(['other']);
    expect([...alarms.keys()]).toEqual([alarmName(other.id)]);
  });

  it('take a shortcut’s new name, and ignore a workflow with the same name', async () => {
    const { deps, storage } = fake();
    await saveSchedule(deps, { kind: 'shortcut', name: 'price-check', args: 'shoes', url: 'https://shop.test/', frequency: 'daily', time: '09:00' });
    await saveSchedule(deps, { ...daily, name: 'price-check' });
    expect(await retargetSchedules(deps, 'shortcut', 'price-check', 'shoe-price')).toBe(1);
    expect((await loadSchedules(storage)).map((s) => `${s.kind}:${s.name}`)).toEqual(['shortcut:shoe-price', 'workflow:price-check']);
    expect(await retargetSchedules(deps, 'shortcut', 'nothing-here', null)).toBe(0);
  });
});
