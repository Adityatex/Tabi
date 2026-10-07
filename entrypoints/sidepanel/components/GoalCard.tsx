// entrypoints/sidepanel/components/GoalCard.tsx
// The task at the top of a run: the goal, its status, time and steps, Stop
// (always in reach while it's active), and the plan, folded to a bar or open.
import { useEffect, useState } from 'react';
import { BookOpen, Check, ChevronDown, ChevronUp, CircleCheck, Hourglass, Lock, Repeat, Square, X } from 'lucide-react';
import TabiMark from '@/components/TabiMark';
import type { RunView } from '@/lib/agent/runner';
import { formatElapsed, planItems, statusPill, type PillTone } from '@/lib/panel/view';

const PILL: Record<PillTone, string> = {
  running: 'bg-accent-soft text-accent pl-[6px]',
  replay: 'border border-accent text-accent',
  waiting: 'bg-amber-bg text-amber',
  done: 'bg-green-bg text-green',
  failed: 'bg-red-bg text-red',
  neutral: 'bg-bg border border-border text-muted',
};

/** A running clock for the meta line. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

/** "Saved 14 days ago" */
function savedAgo(at: number | undefined): string {
  if (!at) return 'Saved workflow';
  const days = Math.floor((Date.now() - at) / 86_400_000);
  return days < 1 ? 'Saved today' : days === 1 ? 'Saved yesterday' : `Saved ${days} days ago`;
}

interface Props {
  run: RunView;
  /** "#2 in line" while it waits for a slot. */
  queuePosition?: number;
  /** Confirmations are on, so irreversible plan items say they ask first. */
  confirmOn: boolean;
  onStop: () => void;
}

export default function GoalCard({ run, queuePosition, confirmOn, onStop }: Props) {
  const active = run.status === 'running' || run.status === 'paused' || run.status === 'queued';
  const now = useNow(active);
  const pill = statusPill(run);
  const label = run.status === 'queued' && queuePosition ? `#${queuePosition} in line` : pill.label;
  const items = planItems(run.plan, run.status === 'done');
  const doneCount = items.filter((p) => p.state === 'done').length;
  const current = items.find((p) => p.state === 'current');
  // Open while it runs; folded when something else needs the room
  const [open, setOpen] = useState(run.status === 'running');
  useEffect(() => { setOpen(run.status === 'running'); }, [run.status]);

  const steps = run.steps.filter((s) => s.status !== 'run' && s.status !== 'wait').length + (run.hiddenSteps?.count ?? 0);
  const ended = run.updatedAt;
  const elapsed = run.started ? formatElapsed((active ? now : ended) - run.started) : '';
  const meta = run.status === 'queued' ? '' : run.replaySteps ? `step ${Math.min(steps + 1, run.replaySteps.total)} of ${run.replaySteps.total}` : [elapsed, `${steps} step${steps === 1 ? '' : 's'}`].filter(Boolean).join(' · ');
  const segColor = { waiting: 'var(--amber)', failed: 'var(--red)', neutral: 'var(--muted)', done: 'var(--green)' }[pill.tone as string] ?? 'var(--accent)';

  return (
    <section className="mt-[10px] mx-[10px] bg-surface border border-border rounded-ctl overflow-hidden flex-none" aria-label="Task" data-run-status={run.status}>
      <div className="px-3 pt-[11px] pb-[10px]">
        {run.workflowName && <div className="font-mono text-[11px] text-muted mb-1">/{run.workflowName}</div>}
        {run.chosenSkills && (
          <div className="flex items-center gap-[5px] text-[11px] text-muted mb-1" data-testid="chosen-skills">
            <BookOpen size={11} aria-hidden />with <span className="font-mono">{run.chosenSkills.map((s) => `/${s}`).join(', ')}</span>
          </div>
        )}
        <h2 className="text-[14px] font-semibold leading-[1.35] [text-wrap:pretty] [overflow-wrap:anywhere]">{run.goal}</h2>
        <div className="flex items-center gap-2 mt-[9px] flex-wrap">
          <span className={`flex items-center gap-[6px] h-[22px] px-2 rounded-full text-[11.5px] font-semibold ${PILL[pill.tone]}`} data-testid="status">
            {pill.tone === 'running' && <TabiMark state="acting" size={12} label="" />}
            {pill.tone === 'replay' && <Repeat size={11} aria-hidden />}
            {pill.tone === 'waiting' && <span aria-hidden className="w-[7px] h-[7px] rounded-full bg-amber" />}
            {pill.tone === 'done' && <Check size={12} aria-hidden />}
            {pill.tone === 'failed' && <X size={12} aria-hidden />}
            {pill.tone === 'neutral' && (run.status === 'queued' ? <Hourglass size={11} aria-hidden /> : <Square size={10} aria-hidden />)}
            {label}
          </span>
          {meta && <span className="font-mono text-[11px] text-muted">{meta}</span>}
          <div className="flex-1" />
          {active && (
            <button type="button" className="btn btn-sm btn-secondary" onClick={onStop}>
              <Square size={11} aria-hidden />Stop
            </button>
          )}
        </div>
      </div>
      {run.replaySteps && (
        // A replay: its own steps are the plan
        <div className="w-full flex items-center gap-2 border-t border-border px-3 py-[10px] text-[12px] min-w-0">
          <span className="font-semibold">Replay</span>
          <span className="flex gap-[3px] flex-none" aria-hidden>
            {Array.from({ length: Math.min(run.replaySteps.total, 16) }, (_, i) => {
              const at = Math.floor((i * run.replaySteps!.total) / Math.min(run.replaySteps!.total, 16));
              return <span key={i} className="w-3 h-1 rounded-[2px]" style={{ background: at < steps ? 'var(--green)' : at === steps ? 'var(--accent)' : 'var(--border-strong)' }} />;
            })}
          </span>
          <span className="text-muted whitespace-nowrap overflow-hidden text-ellipsis min-w-0">{savedAgo(run.replaySteps.savedAt)}</span>
        </div>
      )}
      {!run.replaySteps && items.length > 0 && (open ? (
        <div className="border-t border-border px-3 pt-[9px] pb-[11px]">
          <button type="button" onClick={() => setOpen(false)} className="w-full flex items-center gap-[6px] text-[11.5px] text-muted mb-[7px]" aria-expanded>
            <span className="font-semibold text-text">Plan</span><span>{Math.min(doneCount + 1, items.length)} of {items.length}</span>
            <span className="flex-1" /><ChevronUp size={13} aria-hidden />
          </button>
          <ol className="flex flex-col gap-[6px] text-[12.5px]">
            {items.map((item, i) => (
              <li key={i} className={`flex items-center gap-2 ${item.state === 'done' ? 'text-muted' : item.state === 'current' ? 'font-semibold text-accent' : ''}`}>
                {item.state === 'done' && <CircleCheck size={14} className="text-green flex-none" aria-label="Done" />}
                {item.state === 'current' && <span className="w-[14px] grid place-items-center flex-none"><TabiMark state={run.status === 'paused' ? 'waiting' : 'thinking'} size={13} label="" /></span>}
                {item.state === 'todo' && <span aria-hidden className="w-3 h-3 mx-px rounded-full border-[1.5px] border-border-strong flex-none" />}
                <span className="min-w-0 [overflow-wrap:anywhere]">{item.text}</span>
                {item.irreversible && confirmOn && item.state !== 'done' && (
                  <span className="flex items-center gap-[3px] ml-auto text-[11px] text-muted whitespace-nowrap font-normal"><Lock size={11} aria-hidden />Asks you first</span>
                )}
              </li>
            ))}
          </ol>
        </div>
      ) : (
        <button type="button" onClick={() => setOpen(true)} className="w-full flex items-center gap-2 border-t border-border px-3 py-[10px] text-[12px] min-w-0 text-left" aria-expanded={false}>
          <span className="font-semibold">Plan</span>
          <span className="flex gap-[3px] flex-none" aria-hidden>
            {items.map((item, i) => (
              <span key={i} className="w-3 h-1 rounded-[2px]" style={{ background: item.state === 'done' ? 'var(--green)' : item.state === 'current' ? segColor : 'var(--border-strong)' }} />
            ))}
          </span>
          <span className="text-muted whitespace-nowrap overflow-hidden text-ellipsis min-w-0">
            {Math.min(doneCount + 1, items.length)} of {items.length}{current ? ` · ${current.text}` : ''}
          </span>
          <span className="flex-1" /><ChevronDown size={13} className="text-muted flex-none" aria-hidden />
        </button>
      ))}
    </section>
  );
}
