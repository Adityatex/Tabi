// The step stream: one row per action in plain words, newest last and
// anchored to the bottom. Earlier steps fold into one dashed row; a row
// opens to show the element and the model that chose it.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  ArrowRight, BookOpen, Check, ChevronDown, ChevronRight, CircleCheck, Clock, Code, Database, Eye, Keyboard, ListChecks, MousePointerClick,
  Repeat, Search, SkipForward, StickyNote, ArrowDownUp, X, type LucideIcon,
} from 'lucide-react';
import TabiMark from '@/components/TabiMark';
import type { StepIcon, StepView, HiddenSteps } from '@/lib/agent/stepView';
import { foldLongRun, LONG_RUN, type FoldRow } from '@/lib/panel/view';

const ICONS: Record<StepIcon, LucideIcon> = {
  click: MousePointerClick, type: Keyboard, select: ListChecks, navigate: ArrowRight, scroll: ArrowDownUp, key: Keyboard,
  read: Eye, find: Search, wait: Clock, note: StickyNote, extract: Database, code: Code, skill: BookOpen, replay: Repeat,
};

const pad = (n: number) => String(n).padStart(2, '0');

export function StepRow({ step }: { step: StepView }) {
  const [open, setOpen] = useState(false);
  const Icon = ICONS[step.icon] ?? MousePointerClick;
  const canOpen = !!(step.element || step.model) && (step.status === 'ok' || step.status === 'fail');

  let tile: ReactNode;
  if (step.status === 'run') tile = <div className="w-6 h-6 rounded-[6px] bg-accent-soft grid place-items-center"><TabiMark state="acting" size={14} label="" /></div>;
  else if (step.status === 'wait') tile = <div className="w-6 h-6 rounded-[6px] bg-amber-bg grid place-items-center"><TabiMark state="waiting" size={14} label="" /></div>;
  else if (step.status === 'fail') tile = <div className="w-6 h-6 rounded-[6px] bg-red-bg grid place-items-center text-red"><Icon size={13} strokeWidth={1.75} aria-hidden /></div>;
  else tile = <div className="w-6 h-6 rounded-[6px] bg-surface border border-border grid place-items-center text-muted"><Icon size={13} strokeWidth={1.75} aria-hidden /></div>;

  const body = (
    <div className="min-w-0 text-left">
      {(step.status === 'run' || step.status === 'wait')
        ? <div className="font-semibold [overflow-wrap:anywhere]">{step.action}</div>
        : <div className={`[overflow-wrap:anywhere] ${step.status === 'skip' ? 'text-muted' : ''}`}>{step.action}</div>}
      {step.status === 'ok' && <div className="flex items-baseline gap-1 text-[12px] text-muted mt-px"><Check size={12} className="text-green flex-none self-center" aria-label="Worked" /><span className="[overflow-wrap:anywhere]">{step.result}</span></div>}
      {step.status === 'fail' && <div className="flex items-baseline gap-1 text-[12px] text-red mt-px"><X size={12} className="flex-none self-center" aria-label="Failed" /><span className="[overflow-wrap:anywhere]">{step.result}</span></div>}
      {step.status === 'skip' && <div className="flex items-baseline gap-1 text-[12px] text-muted mt-px"><SkipForward size={12} className="flex-none self-center" aria-label="Not run" /><span className="[overflow-wrap:anywhere]">{step.result}</span></div>}
      {step.status === 'run' && <div className="text-[12px] text-accent mt-px">{step.result}</div>}
      {step.status === 'wait' && <div className="text-[12px] text-amber font-medium mt-px">{step.result}</div>}
      {open && (
        <div className="mt-[6px] px-[9px] py-[7px] rounded-ctl bg-surface border border-border text-[11.5px] grid grid-cols-[auto_minmax(0,1fr)] gap-x-[10px] gap-y-[3px]">
          {step.element && <><span className="text-muted">Element</span><span className="font-mono text-[11px] whitespace-nowrap overflow-hidden text-ellipsis" title={step.element}>{step.element}</span></>}
          {step.model && <><span className="text-muted">Model</span><span className="font-mono text-[11px]">{step.model}</span></>}
        </div>
      )}
    </div>
  );

  return (
    <li
      className="grid grid-cols-[24px_minmax(0,1fr)_auto] gap-[10px] items-start px-1 py-2 border-t border-border text-[13px] leading-[1.38]"
      data-step-status={step.status}
    >
      {tile}
      {canOpen
        ? <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="min-w-0 text-left rounded-ctl">{body}</button>
        : body}
      <div className="font-mono text-[11px] text-muted pt-[3px]">{pad(step.n)}</div>
    </li>
  );
}

/** Rows shown before older ones fold away. */
const SHOWN = 6;

interface StreamProps {
  steps: StepView[];
  hidden?: HiddenSteps;
  /** A replay's steps still to come, shown faded after the current one. */
  upcoming?: string[];
  /** Shown after the steps: an ending card, or a note while it waits. */
  children?: ReactNode;
}

/** "6 earlier steps · all succeeded" / "· 1 failed" */
function foldLabel(count: number, failed: number): string {
  return `${count} earlier step${count === 1 ? '' : 's'} · ${failed ? `${failed} failed` : 'all succeeded'}`;
}

export function StepStream({ steps, hidden, upcoming, children }: StreamProps) {
  const [unfolded, setUnfolded] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  const folded = unfolded ? [] : steps.slice(0, Math.max(0, steps.length - SHOWN));
  const shown = unfolded ? steps : steps.slice(folded.length);
  const foldCount = folded.length + (hidden?.count ?? 0);
  const foldFailed = folded.filter((s) => s.status === 'fail').length + (hidden?.failed ?? 0);
  const retried = steps.filter((s) => s.status === 'fail').length;
  // Past LONG_RUN steps, finished plan items fold into one row each
  const long = steps.length + (hidden?.count ?? 0) > LONG_RUN && steps.some((s) => s.planItem);
  const last = steps[steps.length - 1];

  // Newest last: keep the latest step in view as steps arrive
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); }, [steps.length, last?.status]);

  return (
    <div className="flex-1 min-h-0 overflow-y-auto scroll-thin px-[10px] flex flex-col">
      <div className="flex-1" />
      {steps.length > 0 && (
        <>
          <div className="flex items-center justify-between text-[11.5px] text-muted pt-3 px-1 pb-[6px]">
            <span className="font-semibold text-text">Steps</span>
            {retried > 0 && <span>{retried} retried</span>}
          </div>
          {!long && foldCount > 0 && (
            <button
              type="button"
              onClick={() => setUnfolded(true)}
              disabled={folded.length === 0}
              className="flex items-center gap-2 px-2 py-[7px] border border-dashed border-border-strong rounded-ctl text-[12px] text-muted mb-[2px] text-left"
            >
              <ChevronRight size={13} aria-hidden />{foldLabel(foldCount, foldFailed)}
            </button>
          )}
          {long
            ? <LongRun rows={foldLongRun(steps, hidden)} />
            : <ol aria-label="Steps" aria-live="polite">{shown.map((s) => <StepRow key={`${s.n}-${s.status}`} step={s} />)}</ol>}
          {upcoming && upcoming.length > 0 && (
            <ol aria-label="Steps to come" className="opacity-55">
              {upcoming.map((text, i) => (
                <li key={i} className="grid grid-cols-[24px_minmax(0,1fr)_auto] gap-[10px] items-center px-1 py-2 border-t border-border text-[13px]">
                  <span aria-hidden className="w-6 h-6 rounded-[6px] border border-dashed border-border-strong" />
                  <span className="[overflow-wrap:anywhere]">{text}</span>
                  <span className="font-mono text-[11px] text-muted">{pad(steps.length + (hidden?.count ?? 0) + i + 1)}</span>
                </li>
              ))}
            </ol>
          )}
        </>
      )}
      {children}
      <div ref={end} />
    </div>
  );
}

/** A long run: finished plan items as one row each (opened with a click), then the current item's last steps. */
function LongRun({ rows }: { rows: FoldRow[] }) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const toggle = (text: string) => setOpen((prev) => {
    const next = new Set(prev);
    if (next.has(text)) next.delete(text);
    else next.add(text);
    return next;
  });
  return (
    <ol aria-label="Steps" aria-live="polite">
      {rows.map((row, i) => {
        if (row.kind === 'step') return <StepRow key={`s${row.step.n}-${row.step.status}`} step={row.step} />;
        if (row.kind === 'earlier') {
          return (
            <li key={`e${i}`} className={`flex items-center gap-2 px-2 py-[7px] my-1 border border-dashed border-border-strong rounded-ctl text-[12px] text-muted ${i > 0 && rows[i - 1].kind === 'item' ? 'ml-6' : ''}`}>
              {row.count} earlier {rows[i - 1]?.kind === 'item' && (rows[i - 1] as { current: boolean }).current ? 'in this item' : `step${row.count === 1 ? '' : 's'}`}
              {row.failed > 0 && <span className="text-red">· {row.failed} failed</span>}
            </li>
          );
        }
        const expanded = open.has(row.text) && !row.current;
        return (
          <li key={`i${i}`} className="border-t border-border">
            <button
              type="button"
              disabled={row.current}
              onClick={() => toggle(row.text)}
              aria-expanded={row.current ? undefined : expanded}
              className={`w-full flex items-center gap-2 px-1 py-2 text-left text-[12.5px] ${row.current ? 'font-semibold text-accent' : ''}`}
            >
              {row.current
                ? <span className="w-[13px]" aria-hidden />
                : expanded ? <ChevronDown size={13} className="text-muted flex-none" aria-hidden /> : <ChevronRight size={13} className="text-muted flex-none" aria-hidden />}
              {row.current
                ? <span className="w-[14px] grid place-items-center flex-none"><TabiMark state="thinking" size={13} label="" /></span>
                : <CircleCheck size={14} className="text-green flex-none" aria-label="Done" />}
              <span className="flex-1 min-w-0 [overflow-wrap:anywhere]">{row.text}</span>
              <span className="font-mono text-[11px] text-muted font-normal whitespace-nowrap">
                {row.count}{row.current ? ' so far' : ` step${row.count === 1 ? '' : 's'}`}
                {row.failed > 0 && <span className="text-red"> · {row.failed} failed</span>}
              </span>
            </button>
            {expanded && <ol className="ml-6">{row.steps.map((s) => <StepRow key={`${s.n}-${s.status}`} step={s} />)}</ol>}
          </li>
        );
      })}
    </ol>
  );
}
