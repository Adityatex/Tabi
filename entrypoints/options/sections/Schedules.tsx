// Schedules: a workflow or shortcut that runs on its own (hourly, daily or
// weekly) in a background tab. A table of them, and a form to add one.
import { useEffect, useState } from 'react';
import { CalendarClock, CircleCheck, CircleX, Link, Pause, Play, Repeat, Trash2, Zap } from 'lucide-react';
import { blanks, type Shortcut } from '@/lib/shortcuts/shortcut';
import type { Workflow } from '@/lib/workflows/workflow';
import type { Frequency, Schedule } from '@/lib/schedules/schedule';
import { Card, Empty, Field, IconButton, Notice, PageHead, Segmented, Select, TextInput, send } from '../ui';

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** "Daily · 9:00", "Weekly · Mon 8:30", "Hourly" */
function when(s: Schedule): string {
  const [h, m] = s.time.split(':').map(Number);
  const time = `${h}:${String(m ?? 0).padStart(2, '0')}`;
  if (s.frequency === 'hourly') return `Hourly${m ? ` · :${String(m).padStart(2, '0')}` : ''}`;
  if (s.frequency === 'daily') return `Daily · ${time}`;
  return `Weekly · ${DAYS[s.weekday ?? 1].slice(0, 3)} ${time}`;
}

/** "Tomorrow 9:00", "11:00", "Mon 8:30" */
function nextRun(at: number | undefined): string {
  if (!at) return '–';
  const d = new Date(at);
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return time;
  if (new Date(today.getTime() + 86_400_000).toDateString() === d.toDateString()) return `Tomorrow ${time}`;
  return `${d.toLocaleDateString([], { weekday: 'short' })} ${time}`;
}

const GRID = 'grid grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.4fr)_104px] gap-3 items-center';

export default function Schedules() {
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [shortcuts, setShortcuts] = useState<Shortcut[]>([]);
  const [draft, setDraft] = useState({ target: '', url: '', args: '', frequency: 'daily' as Frequency, time: '09:00', weekday: 1 });
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const load = () => {
    send<Schedule[]>('LIST_SCHEDULES').then((res) => { if (res.success) setSchedules(res.data ?? []); });
  };
  useEffect(() => {
    load();
    send<Workflow[]>('LIST_WORKFLOWS').then((res) => { if (res.success) setWorkflows(res.data ?? []); });
    send<Shortcut[]>('LIST_SHORTCUTS').then((res) => { if (res.success) setShortcuts(res.data ?? []); });
    // A schedule that runs while this page is open: show its result
    const timer = setInterval(load, 5000);
    return () => clearInterval(timer);
  }, []);

  const picked = draft.target.startsWith('shortcut:') ? shortcuts.find((s) => `shortcut:${s.name}` === draft.target) : undefined;
  const pickedBlanks = picked ? blanks(picked.prompt) : [];
  const detail = (s: Schedule) => {
    if (s.kind === 'workflow') return `workflow · ${workflows.find((w) => w.name === s.name)?.steps.length ?? '?'} steps`;
    const sc = shortcuts.find((x) => x.name === s.name);
    const names = sc ? blanks(sc.prompt) : [];
    return s.args && names.length ? `${names.join(', ')} = ${s.args}` : 'shortcut';
  };

  const add = async () => {
    const [kind, ...rest] = draft.target.split(':');
    const res = await send<Schedule[]>('SAVE_SCHEDULE', { kind, name: rest.join(':'), url: draft.url, args: draft.args, frequency: draft.frequency, time: draft.time, weekday: draft.weekday });
    if (!res.success) return setMessage({ ok: false, text: res.error ?? 'Couldn’t save it' });
    setSchedules(res.data ?? []);
    setDraft((d) => ({ ...d, target: '', url: '', args: '' }));
    setMessage({ ok: true, text: 'Scheduled.' });
  };
  const toggle = async (s: Schedule) => {
    const res = await send<Schedule[]>('TOGGLE_SCHEDULE', { id: s.id, enabled: !s.enabled });
    if (res.success) setSchedules(res.data ?? []);
  };
  const remove = async (s: Schedule) => {
    const res = await send<Schedule[]>('DELETE_SCHEDULE', { id: s.id });
    if (res.success) setSchedules(res.data ?? []);
  };
  const runNow = async (s: Schedule) => {
    const res = await send('RUN_SCHEDULE_NOW', { id: s.id });
    setMessage(res.success ? { ok: true, text: `Running /${s.name} in a background tab. A notification will say how it went.` } : { ok: false, text: res.error ?? 'Couldn’t run it' });
  };

  return (
    <>
      <PageHead title="Schedules">Run a workflow or shortcut on its own, in a background tab. You get a notification with the result, and the tab closes if it worked.</PageHead>

      <Card bare testId="schedules">
        {schedules.length === 0 ? (
          <div className="p-5"><Empty icon={CalendarClock} title="No schedules yet">Add one below: a workflow replays with no AI calls, a shortcut uses your model each time.</Empty></div>
        ) : (
          <div className="overflow-x-auto">
            <div className="min-w-[640px]">
              <div className={`${GRID} px-5 py-[10px] border-b border-border t-label`}><span>What</span><span>When</span><span>Next run</span><span>Last result</span><span /></div>
              {schedules.map((s) => {
                const last = s.lastRun;
                const ok = last?.status === 'done';
                return (
                  <div key={s.id} className={`${GRID} px-5 py-3 border-b border-border last:border-b-0 ${s.enabled ? '' : 'text-muted'}`}>
                    <div className="min-w-0">
                      <div className="font-mono text-[12.5px] font-medium truncate">/{s.name}</div>
                      <div className="text-[12px] text-muted truncate">{detail(s)}</div>
                    </div>
                    <span>{when(s)}</span>
                    {s.enabled
                      ? <span>{nextRun(s.nextRun)}</span>
                      : <span className="flex"><span className="flex items-center gap-[5px] h-[22px] px-2 rounded-full border border-border text-[11.5px] font-semibold"><Pause size={10} aria-hidden />Paused</span></span>}
                    {last ? (
                      <span className={`flex items-center gap-[5px] min-w-0 ${ok || !s.enabled ? '' : 'text-red'}`}>
                        {ok ? <CircleCheck size={14} className="text-green flex-none" aria-label="Worked" /> : <CircleX size={14} className="flex-none" aria-label="Didn’t work" />}
                        <span className="truncate" title={last.summary}>{last.summary || last.status}</span>
                        {last.runId && <button type="button" className="text-[12px] font-medium text-accent whitespace-nowrap" onClick={() => send('OPEN_HISTORY', { runId: last.runId })}>Timeline</button>}
                      </span>
                    ) : <span className="text-muted">Not run yet</span>}
                    <span className="flex justify-end gap-[2px]">
                      <IconButton icon={Zap} label="Run now" onClick={() => runNow(s)} />
                      {s.enabled ? <IconButton icon={Pause} label="Pause" onClick={() => toggle(s)} /> : <IconButton icon={Play} label="Resume" tone="accent" onClick={() => toggle(s)} />}
                      <IconButton icon={Trash2} label="Delete" tone="danger" onClick={() => remove(s)} />
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </Card>

      <Card title="Add a schedule" bare>
        {workflows.length + shortcuts.length === 0 ? (
          <div className="p-5"><Notice kind="info">Save a workflow or shortcut first (from the side panel, after a task finishes); then it can run on a schedule.</Notice></div>
        ) : (
          <>
            <div className="px-5 py-[18px] grid grid-cols-1 sm:grid-cols-2 gap-x-5 gap-y-4">
              <Field label="What to run">
                <Select value={draft.target} onChange={(v) => setDraft((d) => ({ ...d, target: v }))} mono label="What to run">
                  <option value="">Choose…</option>
                  {workflows.map((w) => <option key={`w:${w.name}`} value={`workflow:${w.name}`}>/{w.name} · workflow, no AI calls</option>)}
                  {shortcuts.map((s) => <option key={`s:${s.name}`} value={`shortcut:${s.name}`}>/{s.name} · shortcut</option>)}
                </Select>
              </Field>
              {picked ? (
                <Field label="Page to start on">
                  <TextInput icon={Link} mono value={draft.url} onChange={(e) => setDraft((d) => ({ ...d, url: e.target.value }))} placeholder="https://example.com" />
                </Field>
              ) : <div className="hidden sm:flex items-end pb-2 text-[12px] text-muted">{draft.target ? <span className="flex items-center gap-[6px]"><Repeat size={13} aria-hidden />Starts where the workflow was recorded.</span> : null}</div>}
              {pickedBlanks.length > 0 && (
                <Field label={pickedBlanks.map((b) => `{${b}}`).join(', ')} className="sm:col-span-2" hint={pickedBlanks.length > 1 ? <span className="text-[11.5px] text-muted">Separate them with commas, in that order.</span> : undefined}>
                  <TextInput value={draft.args} onChange={(e) => setDraft((d) => ({ ...d, args: e.target.value }))} placeholder={pickedBlanks.length > 1 ? 'first, second' : 'What goes in the blank'} />
                </Field>
              )}
              <Field label="How often">
                <Segmented<Frequency> label="How often" value={draft.frequency} onChange={(v) => setDraft((d) => ({ ...d, frequency: v }))} options={[['hourly', 'Hourly'], ['daily', 'Daily'], ['weekly', 'Weekly']]} />
              </Field>
              <div className="flex gap-[10px]">
                {draft.frequency === 'weekly' && (
                  <Field label="Day" className="flex-1">
                    <Select value={draft.weekday} onChange={(v) => setDraft((d) => ({ ...d, weekday: Number(v) }))} label="Day">
                      {DAYS.map((day, i) => <option key={day} value={i}>{day}</option>)}
                    </Select>
                  </Field>
                )}
                {draft.frequency !== 'hourly'
                  ? (
                    <Field label="Time" className="flex-1">
                      <TextInput mono type="time" value={draft.time} onChange={(e) => setDraft((d) => ({ ...d, time: e.target.value }))} />
                    </Field>
                  )
                  : <p className="flex-1 text-[12px] text-muted self-end pb-2">Runs at the top of every hour while your browser is open.</p>}
              </div>
            </div>
            <div className="px-5 pb-[18px] flex items-center gap-3 flex-wrap">
              <button type="button" className="btn btn-primary" disabled={!draft.target} onClick={add}>Add schedule</button>
              <span className="text-[12px] text-muted">Schedules only run while Chrome is open. If one is missed, it runs when you’re back.</span>
            </div>
          </>
        )}
        {message && <div className="px-5 pb-4"><Notice kind={message.ok ? 'ok' : 'error'}>{message.text}</Notice></div>}
      </Card>
    </>
  );
}
