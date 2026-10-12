// How a run ended: done (with an offer to keep it), stopped, failed (with the
// fix for that kind of failure), or refused because the site is blocked.
import {
  ArrowRight, Ban, BookOpen, CircleCheck, Gauge, KeyRound, MessageCircle, Play, Plus, Repeat, RotateCw, Settings,
  TriangleAlert, WandSparkles, WifiOff, X, Zap,
} from 'lucide-react';
import TabiMark from '@/components/TabiMark';
import type { RunView } from '@/lib/agent/runner';
import { copyCodeOnClick, renderMarkdown } from '@/lib/utils/markdown';
import { failureKind, formatElapsed, planItems, siteOf } from '@/lib/panel/view';

const card = 'bg-surface border border-border rounded-card p-[14px]';

function stepCount(run: RunView): number {
  return run.steps.filter((s) => s.status !== 'run' && s.status !== 'wait').length + (run.hiddenSteps?.count ?? 0);
}

/** What to keep from a finished run, and what came of saving it. */
export interface SaveState {
  busy?: string;
  /** "Workflow saved: /log-in · 3 steps", or why it couldn't be. */
  result?: { ok: boolean; text: string };
}

interface DoneProps {
  run: RunView;
  save: SaveState;
  /** The offer was closed for this run. */
  offerClosed: boolean;
  onSave: (kind: 'workflow' | 'skill' | 'shortcut') => void;
  onCloseOffer: () => void;
  onTimeline: () => void;
}

export function DoneCard({ run, save, offerClosed, onSave, onCloseOffer, onTimeline }: DoneProps) {
  const steps = stepCount(run);
  const items = planItems(run.plan, true);
  const healed = run.replay === 'healed';
  // A workflow that replayed cleanly is already saved: nothing to offer
  const offer = !offerClosed && run.replay !== 'replayed';
  const stats: [string, string][] = [
    [run.started ? formatElapsed(run.updatedAt - run.started) : '–', 'time'],
    [String(steps), steps === 1 ? 'step' : 'steps'],
    [String(run.calls ?? 0), run.calls === 1 ? 'AI call' : 'AI calls'],
  ];
  return (
    <>
      <div className={card}>
        <div className="flex items-center gap-2 font-semibold text-[14px]"><TabiMark state="done" size={16} label="" />Done</div>
        <div
          className="answer mt-2 text-[13.5px] leading-[1.55] [text-wrap:pretty] [overflow-wrap:anywhere]"
          data-testid="summary"
          onClick={(e) => copyCodeOnClick(e.target)}
          dangerouslySetInnerHTML={{ __html: renderMarkdown(run.outcome || 'Finished.', { copyCode: true }) }}
        />
        <div className="grid grid-cols-3 gap-[6px] mt-3 pt-3 border-t border-border">
          {stats.map(([value, label]) => (
            <div key={label}><div className="font-mono text-[13px] font-medium">{value}</div><div className="text-[11px] text-muted">{label}</div></div>
          ))}
        </div>
        {run.runId && (
          <button type="button" onClick={onTimeline} className="inline-flex items-center gap-[5px] mt-3 text-[12.5px] font-medium text-accent">
            See the full timeline<ArrowRight size={12} aria-hidden />
          </button>
        )}
      </div>
      {items.length > 0 && (
        <ul className="flex flex-col gap-[6px] text-[12.5px] px-1">
          {items.map((item, i) => (
            <li key={i} className="flex items-center gap-2 text-muted"><CircleCheck size={14} className="text-green flex-none" aria-hidden /><span className="[overflow-wrap:anywhere]">{item.text}</span></li>
          ))}
        </ul>
      )}
      <div className="flex-1" />
      {offer && (healed ? (
        <div className="border border-border rounded-card p-3 bg-bg">
          <div className="flex items-center gap-2"><WandSparkles size={14} className="text-accent" aria-hidden /><span className="font-semibold text-[13px] flex-1">Update /{run.workflowName} with this fix?</span></div>
          <div className="text-[12px] text-muted mt-1">Next time it replays with no AI calls again.</div>
          <SaveResult save={save} />
          <div className="flex gap-[6px] mt-[10px]">
            <button type="button" className="btn btn-sm btn-primary h-7" disabled={!!save.busy} onClick={() => onSave('workflow')}>Update workflow</button>
            <button type="button" className="btn btn-sm btn-quiet h-7" onClick={onCloseOffer}>Not now</button>
          </div>
        </div>
      ) : (
        <div className="border border-border rounded-card p-3 bg-bg">
          <div className="flex items-center gap-2">
            <span className="font-semibold text-[13px] flex-1">Do this again later?</span>
            <button type="button" className="icon-btn w-6 h-6" aria-label="No thanks" title="No thanks" onClick={onCloseOffer}><X size={14} /></button>
          </div>
          <div className="flex flex-wrap gap-[6px] mt-[10px]">
            {!run.unrecordable && (
              <button type="button" className="btn btn-sm btn-secondary h-7" disabled={!!save.busy} onClick={() => onSave('workflow')}><Repeat size={12} aria-hidden />Save as workflow</button>
            )}
            <button type="button" className="btn btn-sm btn-secondary h-7" disabled={!!save.busy} onClick={() => onSave('skill')}><BookOpen size={12} aria-hidden />Save as skill</button>
            <button type="button" className="btn btn-sm btn-secondary h-7" disabled={!!save.busy} onClick={() => onSave('shortcut')}><Zap size={12} aria-hidden />Save as shortcut</button>
          </div>
          <SaveResult save={save} />
          <div className="text-[11.5px] text-muted mt-2 leading-[1.45]">
            {run.unrecordable ? `It can’t be a workflow: ${run.unrecordable}. ` : 'A workflow replays these exact steps with no AI calls. '}
            A skill teaches Tabi how you like this done. A shortcut saves the request, with blanks.
          </div>
        </div>
      ))}
    </>
  );
}

function SaveResult({ save }: { save: SaveState }) {
  if (save.busy) return <div className="text-[12px] text-accent mt-2" role="status">{save.busy}…</div>;
  if (!save.result) return null;
  return (
    <div role="status" className={`text-[12px] mt-2 flex items-start gap-[5px] ${save.result.ok ? 'text-green' : 'text-red'}`}>
      {save.result.ok ? <CircleCheck size={13} className="flex-none mt-px" aria-hidden /> : <TriangleAlert size={13} className="flex-none mt-px" aria-hidden />}
      <span className="[overflow-wrap:anywhere]" data-testid="save-result">{save.result.text}</span>
    </div>
  );
}

interface StoppedProps {
  run: RunView;
  onResume: () => void;
  onStartOver: () => void;
}

export function StoppedCard({ run, onResume, onStartOver }: StoppedProps) {
  const steps = stepCount(run);
  return (
    <div className={card}>
      <div className="flex items-center gap-2 font-semibold text-[14px]"><TabiMark state="stopped" size={16} label="" />Stopped.</div>
      <div className="mt-[6px] text-muted leading-[1.5]">
        {run.outcome ?? (steps ? `You stopped it after ${steps} step${steps === 1 ? '' : 's'}. Nothing else will happen on the page.` : 'You stopped it before it did anything.')}
      </div>
      <div className="flex gap-[6px] mt-3">
        <button type="button" className="btn btn-primary h-[30px]" onClick={onResume}><Play size={12} aria-hidden />Resume</button>
        <button type="button" className="btn btn-secondary h-[30px]" onClick={onStartOver}>Start over</button>
      </div>
    </div>
  );
}

interface FailedProps {
  run: RunView;
  /** "Groq", for "Groq rejected your API key". */
  provider: string;
  onSettings: () => void;
  onRetry: () => void;
  onTimeline: () => void;
}

export function FailedCard({ run, provider, onSettings, onRetry, onTimeline }: FailedProps) {
  const error = run.outcome ?? 'Something went wrong.';
  const kind = failureKind(error);
  const steps = stepCount(run);
  const copy = {
    bad_key: { icon: KeyRound, title: `${provider || 'Your provider'} rejected your API key`, body: 'The key may have been revoked or copied incompletely. Nothing on the page was changed.' },
    rate_limit: { icon: Gauge, title: `${provider || 'Your provider'} hit its rate limit`, body: `The task stopped at step ${steps + 1}. Add a backup provider and Tabi switches over on its own next time.` },
    model: { icon: Settings, title: 'That model isn’t available', body: 'Your key can’t use the chosen model. Pick another in Settings.' },
    setup: { icon: Settings, title: 'Tabi isn’t set up yet', body: 'Choose a provider, paste your key and pick a model in Settings.' },
    page_load: { icon: WifiOff, title: 'The page didn’t load', body: 'Check the tab, then retry.' },
    other: { icon: TriangleAlert, title: 'The task failed', body: 'Retry, or open the timeline to see what happened.' },
  }[kind];
  const Icon = copy.icon;
  const fix = kind === 'bad_key' || kind === 'model' || kind === 'setup';
  return (
    <div className="bg-red-bg border border-red rounded-card p-[14px]" role="alert">
      <div className="flex items-center gap-2 font-semibold text-[14px] text-red"><Icon size={15} aria-hidden />{copy.title}</div>
      <div className="mt-[6px] leading-[1.5]">{copy.body}</div>
      <div className="font-mono text-[11px] text-muted mt-2 [overflow-wrap:anywhere]" data-testid="error">{error.slice(0, 240)}</div>
      <div className="flex gap-[6px] mt-3 flex-wrap">
        {fix || kind === 'rate_limit'
          ? <button type="button" className="btn btn-primary h-[30px]" onClick={onSettings}>{kind === 'rate_limit' ? <Plus size={12} aria-hidden /> : <Settings size={12} aria-hidden />}{kind === 'rate_limit' ? 'Add a backup' : 'Fix in Settings'}</button>
          : <button type="button" className="btn btn-primary h-[30px]" onClick={onRetry}><RotateCw size={12} aria-hidden />Retry</button>}
        {(fix || kind === 'rate_limit') && <button type="button" className="btn btn-secondary h-[30px]" onClick={onRetry}>Retry</button>}
        {!fix && run.runId && <button type="button" className="btn btn-quiet h-[30px]" onClick={onTimeline}>Open timeline</button>}
      </div>
    </div>
  );
}

interface BlockedProps {
  url?: string;
  onAsk: () => void;
  onSettings: () => void;
}

export function BlockedCard({ url, onAsk, onSettings }: BlockedProps) {
  const site = siteOf(url) || 'this site';
  return (
    <div className={`${card} flex gap-3`}>
      <div className="w-8 h-8 rounded-ctl bg-red-bg text-red grid place-items-center flex-none"><Ban size={16} aria-hidden /></div>
      <div className="min-w-0">
        <div className="font-semibold text-[14px]">Tabi doesn’t act on {site}</div>
        <div className="mt-1 text-muted leading-[1.5]">It’s on your block list, so Tabi won’t click or type here. You can still ask questions about the page.</div>
        <div className="flex gap-[6px] mt-3 flex-wrap">
          <button type="button" className="btn btn-secondary h-[30px]" onClick={onAsk}><MessageCircle size={12} aria-hidden />Ask instead</button>
          <button type="button" className="btn btn-quiet h-[30px]" onClick={onSettings}>Manage block list</button>
        </div>
      </div>
    </div>
  );
}
