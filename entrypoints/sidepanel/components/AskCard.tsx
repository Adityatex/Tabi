// Anything that needs the user, pinned above the composer and never in the
// stream: an action that can't be undone, a step the safety check doubts, a
// site off the allow list, or a pause (a regular check-in, or it looks stuck).
// Amber, the only place amber is used. The safety check flips the default:
// "Don't allow" is its primary button.
import { useEffect, useRef } from 'react';
import { Check, EyeOff, Globe, Hand, Pause, Play, ShieldAlert, Square, X } from 'lucide-react';
import type { RunView } from '@/lib/agent/runner';
import { quote } from '@/lib/agent/stepView';
import { planItems } from '@/lib/panel/view';

interface Props {
  run: RunView;
  onAnswer: (allow: boolean) => void;
  onContinue: () => void;
  onStop: () => void;
  onReview: () => void;
}

/** click "Place order" → click “Place order” */
const curly = (text: string) => text.replace(/"([^"]*)"/g, (_, t: string) => quote(t, 80));

function StopButton({ onStop }: { onStop: () => void }) {
  return (
    <button type="button" className="btn btn-quiet h-8 px-2 text-[12.5px]" onClick={onStop}>
      <Square size={12} aria-hidden />Stop
    </button>
  );
}

export default function AskCard({ run, onAnswer, onContinue, onStop, onReview }: Props) {
  const asking = run.asking;
  const first = useRef<HTMLButtonElement>(null);
  // The card takes the keyboard when it appears (Review on the page pill focuses it too)
  useEffect(() => { first.current?.focus({ preventScroll: true }); }, [asking?.action, run.pausedFor?.kind]);

  if (asking?.risk === 'off-task') {
    return (
      <div role="alertdialog" aria-label="Safety check" data-asking={asking.action} data-risk={asking.risk} className="relative overflow-hidden border-[1.5px] border-amber-line bg-amber-bg rounded-card shadow-[0_6px_20px_rgba(0,0,0,.14)]">
        <div aria-hidden className="absolute left-0 top-0 bottom-0 w-[6px]" style={{ background: 'repeating-linear-gradient(135deg,var(--amber-solid) 0 6px,var(--text) 6px 12px)' }} />
        <div className="flex items-center gap-[7px] py-2 pr-3 pl-[18px] bg-text text-bg text-[11.5px] font-bold tracking-[.04em] uppercase">
          <ShieldAlert size={14} className="text-amber-solid" aria-hidden />Safety check<div className="flex-1" />
          <span className="font-semibold tracking-normal normal-case opacity-80">Paused</span>
        </div>
        <div className="py-3 pr-3 pl-[18px]">
          <div className="text-[15px] font-semibold leading-[1.35] [text-wrap:pretty]">This step doesn’t look like part of your task.</div>
          <div className="mt-1 text-[13px] leading-[1.45] [text-wrap:pretty]">
            A safety check, which can’t see the page, doesn’t think {curly(asking.action)} fits{asking.reason ? `: ${asking.reason.replace(/\.$/, '')}.` : '.'}
          </div>
          <div className="mt-[10px] flex gap-2 px-[10px] py-2 rounded-ctl bg-raised border border-border text-[12px] leading-[1.45]">
            <EyeOff size={14} className="text-amber flex-none mt-px" aria-hidden />
            <span>Pages sometimes hide instructions meant to mislead AI agents. If you didn’t ask for this, don’t allow it.</span>
          </div>
          <div className="flex items-center gap-[6px] mt-3 flex-wrap">
            <button ref={first} type="button" className="btn h-8 px-[14px] bg-text text-bg font-semibold shadow-[0_0_0_2px_var(--amber-bg),0_0_0_4px_var(--text)]" onClick={() => onAnswer(false)}>
              <X size={14} aria-hidden />Don't allow
            </button>
            <button type="button" className="btn btn-secondary h-8" onClick={() => onAnswer(true)}>Allow anyway</button>
            <div className="flex-1" />
            <StopButton onStop={onStop} />
          </div>
        </div>
      </div>
    );
  }

  if (asking?.risk === 'unlisted') {
    const site = /^(\S+) isn't on your list/.exec(asking.reason ?? '')?.[1] ?? asking.action.replace(/^work on /, '');
    return (
      <div role="alertdialog" aria-label="New site" data-asking={asking.action} data-risk={asking.risk} className="border-[1.5px] border-amber-line bg-amber-bg rounded-card p-3 shadow-[0_6px_20px_rgba(0,0,0,.1)]">
        <div className="flex items-center gap-[6px] text-[11.5px] font-bold tracking-[.04em] uppercase text-amber"><Globe size={14} aria-hidden />New site · needs your OK</div>
        <div className="mt-2 text-[15px] font-semibold leading-[1.35] [text-wrap:pretty]">{site} isn’t on your list of allowed sites.</div>
        <div className="mt-1 text-[13px] leading-[1.45]">
          {/^work on /.test(asking.action) ? 'Let Tabi use it for this task?' : `Tabi wants to ${curly(asking.action)}. Let it use ${site} for this task?`}
        </div>
        <div className="flex items-center gap-[6px] mt-3 flex-wrap">
          <button ref={first} type="button" className="btn h-8 px-[14px] bg-amber-solid text-amber-on font-semibold" onClick={() => onAnswer(true)}>Allow for this task</button>
          <button type="button" className="btn btn-secondary h-8" onClick={() => onAnswer(false)}>Don't allow</button>
          <div className="flex-1" />
          <StopButton onStop={onStop} />
        </div>
        <div className="mt-2 text-[11.5px] text-muted">It won’t be added to your list. Change that in Settings › Safety.</div>
      </div>
    );
  }

  if (asking) {
    return (
      <div role="alertdialog" aria-label="Needs your OK" data-asking={asking.action} data-risk={asking.risk} className="border-[1.5px] border-amber-line bg-amber-bg rounded-card overflow-hidden shadow-ask">
        <div className="flex items-center gap-[7px] px-3 py-[7px] bg-amber-solid text-amber-on text-[11.5px] font-bold tracking-[.04em] uppercase">
          <Hand size={14} aria-hidden />Needs your OK<div className="flex-1" />
          <span className="font-semibold tracking-normal normal-case">Paused</span>
        </div>
        <div className="p-3">
          <div className="text-[15px] font-semibold leading-[1.35] [text-wrap:pretty]">Allow Tabi to {curly(asking.action)}?</div>
          <div className="mt-1 text-[13px] leading-[1.45] [text-wrap:pretty]">It looks like {asking.risk}, which can’t be undone.</div>
          <div className="flex items-center gap-[6px] mt-3 flex-wrap">
            <button ref={first} type="button" className="btn btn-amber h-8 px-[14px]" onClick={() => onAnswer(true)}><Check size={14} aria-hidden />Allow</button>
            <button type="button" className="btn btn-secondary h-8" onClick={() => onAnswer(false)}><X size={14} aria-hidden />Don't allow</button>
            <div className="flex-1" />
            <StopButton onStop={onStop} />
          </div>
          <div className="mt-2 text-[11.5px] text-muted">Don’t allow, and it finishes the task without this step.</div>
        </div>
      </div>
    );
  }

  // A pause: a regular check-in, or it looks stuck
  const stuck = run.pausedFor?.kind === 'stuck';
  const items = planItems(run.plan);
  const done = items.filter((p) => p.state === 'done').length;
  const steps = run.steps.length + (run.hiddenSteps?.count ?? 0);
  const progress = [items.length ? `${done} of ${items.length} plan items done` : '', run.calls ? `${run.calls} AI call${run.calls === 1 ? '' : 's'} so far` : ''].filter(Boolean).join('. ');
  return (
    <div role="alertdialog" aria-label="Paused" data-paused={run.pausedFor?.kind ?? 'checkpoint'} className="border-[1.5px] border-amber-line bg-amber-bg rounded-card p-3">
      <div className="flex items-center gap-[6px] text-[11.5px] font-bold tracking-[.04em] uppercase text-amber"><Pause size={14} aria-hidden />{stuck ? 'Looks stuck' : 'Check-in'}</div>
      <div className="mt-2 text-[15px] font-semibold leading-[1.35] [text-wrap:pretty]">
        {stuck ? 'It chose the same thing 3 times and the page didn’t change.' : `${steps} steps without finishing. Keep going?`}
      </div>
      <div className="mt-1 text-[13px] leading-[1.45] [text-wrap:pretty]">
        {stuck
          ? 'You may need to sign in, or the page may need something done first. Give Tabi a hint below, or let it try another way.'
          : `${progress ? `${progress}. ` : ''}You can also give Tabi a hint below.`}
      </div>
      <div className="flex items-center gap-[6px] mt-3 flex-wrap">
        <button ref={first} type="button" className="btn h-8 px-[14px] bg-amber-solid text-amber-on font-semibold" onClick={onContinue}>
          <Play size={13} aria-hidden />{stuck ? 'Try another way' : 'Keep going'}
        </button>
        <button type="button" className="btn btn-secondary h-8" onClick={onReview}>Review steps</button>
        <div className="flex-1" />
        <StopButton onStop={onStop} />
      </div>
    </div>
  );
}
