// entrypoints/history/App.tsx
// The History page: past agent runs on the left, grouped by day, and the
// chosen run's timeline on the right (lib/history/view.ts). Opened from the
// side panel, Settings, and a finished background or scheduled task's notification.
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import {
  ChevronDown, ChevronRight, CircleCheck, CircleStop, CircleX, Clock, Cpu, Download, Info, LoaderCircle, MessageSquare,
  RefreshCw, Repeat, Search, ShieldAlert, ShieldCheck, Trash2, User, X, type LucideIcon,
} from 'lucide-react';
import TabiMark, { type TabiMarkState } from '@/components/TabiMark';
import { formatRunLog, MAX_RUNS, type RunLog } from '@/lib/agent/timeline';
import { formatElapsed } from '@/lib/panel/view';
import { renderMarkdown } from '@/lib/utils/markdown';
import {
  callsLabel, compactNumber, FILTERS, foldTimeline, groupByDay, matchesRun, runMark, runSite, runStats, runTags, seenChanges,
  startedFrom, timelineNodes, type RunFilter, type RunHeader, type RunMark, type TimelineNode,
} from '@/lib/history/view';

const send = (action: string, payload?: unknown) => browser.runtime.sendMessage({ action, payload }) as Promise<any>;

const MARK: Record<RunMark, [LucideIcon, string, string]> = {
  done: [CircleCheck, 'text-green', 'Done'],
  failed: [CircleX, 'text-red', 'Failed'],
  stopped: [CircleStop, 'text-muted', 'Stopped'],
  replay: [Repeat, 'text-accent', 'Replayed'],
  running: [LoaderCircle, 'text-accent', 'Running'],
  waiting: [MessageSquare, 'text-amber', 'Waiting for you'],
  queued: [Clock, 'text-muted', 'Waiting to start'],
};

const clock = (at: number) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

export default function App() {
  const [runs, setRuns] = useState<RunHeader[] | null>(null);
  const [selected, setSelected] = useState<string>(() => decodeURIComponent(location.hash.slice(1)));
  const [run, setRun] = useState<RunLog | null>(null);
  const [filter, setFilter] = useState<RunFilter>('all');
  const [query, setQuery] = useState('');
  const [confirmAll, setConfirmAll] = useState(false);

  const loadRuns = useCallback(() => send('LIST_RUNS').then((res) => { if (res?.success) setRuns(res.data); }).catch(() => {}), []);
  const loadRun = useCallback((id: string) => {
    if (!id) return setRun(null);
    send('GET_RUN', { id }).then((res) => { if (res?.success) setRun(res.data); }).catch(() => {});
  }, []);

  useEffect(() => { loadRuns(); }, [loadRuns]);
  // Open the newest run if none was asked for
  useEffect(() => { if (!selected && runs?.length) setSelected(runs[0].id); }, [runs, selected]);
  useEffect(() => {
    loadRun(selected);
    if (selected && location.hash.slice(1) !== selected) history.replaceState(null, '', `#${selected}`);
  }, [selected, loadRun]);
  useEffect(() => {
    const onHash = () => setSelected(decodeURIComponent(location.hash.slice(1)));
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  // Runs still going: follow them
  const live = !!runs?.some((r) => !r.ended);
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => { loadRuns(); loadRun(selected); }, 3000);
    return () => clearInterval(timer);
  }, [live, selected, loadRuns, loadRun]);
  useEffect(() => { document.title = run ? `${run.goal} · Tabi history` : 'Tabi history'; }, [run]);

  const remove = async (id?: string) => {
    await send('DELETE_RUNS', id ? { id } : {});
    setConfirmAll(false);
    if (!id || id === selected) setSelected('');
    loadRuns();
  };

  const exportRun = () => {
    if (!run) return;
    const blob = new Blob([formatRunLog(run)], { type: 'text/markdown' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `tabi-run-${new Date(run.started).toISOString().slice(0, 16).replace(/[:T]/g, '-')}.md`;
    link.click();
    URL.revokeObjectURL(link.href);
  };

  const shown = (runs ?? []).filter((r) => matchesRun(r, filter, query));

  return (
    <div className="min-h-screen md:grid md:grid-cols-[minmax(300px,380px)_minmax(0,1fr)]">
      <aside className="md:border-r border-b md:border-b-0 border-border flex flex-col md:h-screen md:sticky md:top-0 max-h-[50vh] md:max-h-none">
        <div className="px-4 pt-5 pb-3 flex flex-col gap-3 border-b border-border">
          <div className="flex items-center gap-[9px]">
            <TabiMark size={20} label="" />
            <span className="font-semibold text-[15px] tracking-[-0.01em]">Tabi</span>
            <span className="text-muted">History</span>
            <span className="ml-auto text-[12px] text-muted">Last {MAX_RUNS} runs</span>
          </div>
          <label className="h-8 flex items-center gap-2 px-[10px] rounded-ctl border border-border-strong bg-raised text-muted focus-within:border-accent">
            <Search size={14} aria-hidden />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search runs"
              aria-label="Search runs"
              className="flex-1 min-w-0 bg-transparent outline-none text-text placeholder:text-muted"
            />
          </label>
          <div role="group" aria-label="Show" className="flex gap-[6px] flex-wrap">
            {FILTERS.map(([id, label]) => (
              <button
                key={id}
                type="button"
                aria-pressed={filter === id}
                onClick={() => setFilter(id)}
                className={`h-6 px-[10px] rounded-full text-[12px] ${filter === id ? 'bg-text text-bg font-semibold' : 'border border-border hover:border-border-strong'}`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <nav aria-label="Runs" className="flex-1 overflow-auto scroll-thin p-2">
          {runs !== null && shown.length === 0 && (
            <p className="px-2 py-6 text-center text-muted text-[12px]">{runs.length === 0 ? 'No runs yet.' : 'No runs match.'}</p>
          )}
          {groupByDay(shown).map(({ day, runs: list }) => (
            <div key={day}>
              <div className="text-[10.5px] font-semibold tracking-[.07em] uppercase text-muted px-2 pt-3 pb-[6px]">{day}</div>
              {list.map((r) => <RunRow key={r.id} run={r} on={r.id === selected} onPick={() => setSelected(r.id)} />)}
            </div>
          ))}
        </nav>

        {runs && runs.length > 0 && (
          <div className="border-t border-border px-4 py-[10px] flex items-center gap-2 text-[12px]">
            {confirmAll ? (
              <>
                <span className="flex-1">Delete all {runs.length} saved run{runs.length === 1 ? '' : 's'}?</span>
                <button type="button" className="btn btn-sm btn-danger" onClick={() => remove()}>Delete all</button>
                <button type="button" className="btn btn-sm btn-quiet" onClick={() => setConfirmAll(false)}>Cancel</button>
              </>
            ) : (
              <>
                <span className="flex-1 text-muted">Kept only in this browser.</span>
                <button type="button" className="btn btn-sm btn-quiet" onClick={() => setConfirmAll(true)}>Delete all…</button>
              </>
            )}
          </div>
        )}
      </aside>

      <main className="px-5 md:px-10 pt-7 pb-20 min-w-0">
        {runs === null ? null : runs.length === 0 ? (
          <div className="max-w-[520px] mt-10 flex flex-col items-center text-center gap-2">
            <TabiMark size={28} state="idle" label="" />
            <div className="font-semibold text-[15px] mt-1">No runs yet.</div>
            <p className="text-muted">
              Every task Tabi runs shows up here, step by step: from the side panel, in a background tab, on a schedule, or from an AI app.
              Kept only in this browser, with typed passwords and card numbers masked.
            </p>
          </div>
        ) : !run ? (
          <p className="text-muted">Pick a run.</p>
        ) : (
          <RunDetail run={run} onExport={exportRun} onDelete={() => remove(run.id)} />
        )}
      </main>
    </div>
  );
}

function RunRow({ run, on, onPick }: { run: RunHeader; on: boolean; onPick: () => void }) {
  const mark = runMark(run);
  const [Icon, tone, label] = MARK[mark];
  return (
    <button
      type="button"
      onClick={onPick}
      aria-current={on ? 'true' : undefined}
      data-run-id={run.id}
      className={`w-full text-left grid grid-cols-[18px_minmax(0,1fr)] gap-[10px] p-[10px] rounded-ctl ${on ? 'bg-surface shadow-[inset_0_0_0_1px_var(--border-strong)]' : 'hover:bg-surface'}`}
    >
      <Icon size={15} className={`mt-px ${tone} ${mark === 'running' ? 'motion-safe:animate-spin' : ''}`} aria-label={label} />
      <span className="min-w-0">
        <span className="block font-medium truncate">{run.goal}</span>
        <span className="flex gap-[6px] flex-wrap text-[11.5px] text-muted mt-[2px]">
          <span>{clock(run.started)}</span>·
          <span className="font-mono">{run.ended ? formatElapsed(run.ended - run.started) : label.toLowerCase()}</span>·
          <span>{callsLabel(run.calls)}</span>
          {runTags(run).map((tag) => <span key={tag}>· {tag}</span>)}
        </span>
      </span>
    </button>
  );
}

const PILL: Record<RunMark, string> = {
  done: 'bg-green-bg text-green', failed: 'bg-red-bg text-red', stopped: 'bg-surface border border-border text-muted', replay: 'bg-green-bg text-green',
  running: 'bg-accent-soft text-accent', waiting: 'bg-amber-bg text-amber', queued: 'bg-surface border border-border text-muted',
};

function RunDetail({ run, onExport, onDelete }: { run: RunLog; onExport: () => void; onDelete: () => void }) {
  const mark = runMark(run);
  const [Icon, , label] = MARK[mark];
  const { steps, failed } = runStats(run);
  const day = new Date(run.started);
  const date = day.toDateString() === new Date().toDateString() ? `Today ${clock(run.started)}` : day.toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  const meta = [date, runSite(run), startedFrom(run.source), run.workflow ? `workflow /${run.workflow}` : ''].filter(Boolean);
  const took = (run.ended ?? Date.now()) - run.started;

  return (
    <article className="max-w-[860px]" data-run-status={run.ended ? run.status : 'running'}>
      <div className="flex items-start gap-4 flex-wrap">
        <div className="flex-1 min-w-[260px]">
          <div className="flex items-center gap-2 flex-wrap text-[12px] text-muted">
            <span className={`flex items-center gap-[5px] h-[22px] px-2 rounded-full text-[11.5px] font-semibold ${PILL[mark]}`}>
              <Icon size={12} aria-hidden className={mark === 'running' ? 'motion-safe:animate-spin' : ''} />{mark === 'replay' ? 'Done' : label}
            </span>
            {meta.join(' · ')}
          </div>
          <h1 className="text-[22px] font-semibold tracking-[-0.02em] leading-[1.3] mt-[10px] [text-wrap:pretty] [overflow-wrap:anywhere]">{run.goal}</h1>
        </div>
        <div className="flex gap-[6px] flex-none">
          <button type="button" className="btn btn-secondary" onClick={onExport}><Download size={14} aria-hidden />Export Markdown</button>
          <button type="button" className="btn btn-secondary !px-0 w-8 text-red" title="Delete this run" aria-label="Delete this run" onClick={onDelete}>
            <Trash2 size={14} aria-hidden />
          </button>
        </div>
      </div>

      <dl className="grid grid-cols-2 sm:grid-cols-5 mt-5 bg-surface border border-border rounded-card overflow-hidden">
        <Stat value={formatElapsed(took)} label={run.ended ? 'time' : 'so far'} />
        <Stat value={String(steps)} label={`step${steps === 1 ? '' : 's'}${failed ? ` · ${failed} failed` : ''}`} />
        <Stat value={String(run.calls)} label={`AI call${run.calls === 1 ? '' : 's'}`} />
        <Stat value={run.tokens ? compactNumber(run.tokens) : '–'} label="tokens" />
        <Stat value={String(run.checks)} label={`safety check${run.checks === 1 ? '' : 's'}`} />
      </dl>

      <Timeline run={run} />
    </article>
  );
}

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <div className="px-4 py-3 border-border border-b sm:border-b-0 sm:border-r last:border-r-0 flex flex-col-reverse">
      <dt className="text-[12px] text-muted">{label}</dt>
      <dd className="font-mono text-[18px] font-medium">{value}</dd>
    </div>
  );
}

// ---- The timeline

type Tone = 'plain' | 'accent' | 'red' | 'green' | 'amber';
const DOT: Record<Tone, string> = {
  plain: 'bg-surface border border-border-strong',
  accent: 'bg-accent-soft text-accent',
  red: 'bg-red-bg text-red',
  green: 'bg-green-bg text-green',
  amber: 'bg-amber-bg text-amber',
};

function Timeline({ run }: { run: RunLog }) {
  const nodes = foldTimeline(timelineNodes(run.entries));
  const at = (t: number) => formatElapsed(t - run.started);
  const ended = nodes.some((n) => n.kind === 'end');
  return (
    <div className="relative mt-7">
    <div aria-hidden className="absolute left-[11px] top-[6px] bottom-[6px] w-[2px] bg-border" />
    <ol aria-label="Timeline" className="relative pl-9">
      <Item dot={<User size={12} className="text-muted" />} tone="plain">
        <Line title="You asked" time={at(run.started)}>
          {run.workflow && <span className="flex items-center gap-1 text-[11.5px] text-accent font-semibold"><Repeat size={11} aria-hidden />Replay /{run.workflow}</span>}
        </Line>
      </Item>
      {nodes.map((node, i) => <NodeItem key={i} node={node} run={run} at={at} />)}
      {!ended && (
        <Item dot={<TabiMark size={13} state={run.status === 'paused' ? 'waiting' : 'acting'} label="" />} tone={run.status === 'paused' ? 'amber' : 'accent'} last>
          <Line title={run.status === 'paused' ? 'Waiting for you in its tab' : 'Still running'} time={at(Date.now())} />
        </Item>
      )}
    </ol>
    </div>
  );
}

function Item({ dot, tone, last, children, kind }: { dot: ReactNode; tone: Tone; last?: boolean; children: ReactNode; kind?: string }) {
  return (
    <li className={`relative ${last ? '' : 'pb-[22px]'}`} data-kind={kind}>
      <div aria-hidden className={`absolute -left-9 top-0 w-6 h-6 rounded-full box-border grid place-items-center ${DOT[tone]}`}>{dot}</div>
      {children}
    </li>
  );
}

/** A row's first line: what happened, extra words, and when (time since the start). */
function Line({ title, strong, children, time }: { title: ReactNode; strong?: boolean; children?: ReactNode; time: string }) {
  return (
    <div className="flex items-baseline gap-2 flex-wrap">
      <span className={`${strong ? 'font-semibold' : 'font-medium'} [overflow-wrap:anywhere]`}>{title}</span>
      {children}
      <span className="ml-auto font-mono text-[11px] text-muted">{time}</span>
    </div>
  );
}

const Muted = ({ children, tone = 'text-muted' }: { children: ReactNode; tone?: string }) => <span className={`text-[12px] ${tone} [overflow-wrap:anywhere]`}>{children}</span>;
const Mono = ({ children }: { children: ReactNode }) => <div className="font-mono text-[11.5px] text-muted mt-[3px] [overflow-wrap:anywhere]">{children}</div>;
const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const seconds = (ms: number) => ms < 60_000 ? `${Math.max(1, Math.round(ms / 1000))} second${Math.round(ms / 1000) === 1 ? '' : 's'}` : `${Math.round(ms / 60_000)} min`;

function NodeItem({ node, run, at }: { node: TimelineNode; run: RunLog; at: (t: number) => string }) {
  const [open, setOpen] = useState(false);
  switch (node.kind) {
    case 'fold':
      return (
        <Item dot={open ? <ChevronDown size={12} className="text-muted" /> : <ChevronRight size={12} className="text-muted" />} tone="plain" kind="fold">
          <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="w-full text-left flex items-baseline gap-2 flex-wrap group">
            <span className="font-medium group-hover:underline">Steps {node.from}–{node.to}</span>
            <Muted>{node.worked} worked · {callsLabel(node.calls)}</Muted>
            <span className="ml-auto font-mono text-[11px] text-muted">{at(node.start)}–{at(node.end)}</span>
          </button>
          {open && (
            <ol className="mt-2 flex flex-col gap-[10px] pl-3 border-l border-border">
              {node.nodes.map((child, i) => (
                <li key={i} className="flex gap-2" data-kind={child.kind}>
                  <span aria-hidden className="mt-[2px]">{child.kind === 'step' ? <CircleCheck size={13} className="text-green" /> : child.kind === 'model' ? <Cpu size={13} className="text-accent" /> : <Info size={13} className="text-muted" />}</span>
                  <div className="flex-1 min-w-0"><Body node={child} run={run} at={at} /></div>
                </li>
              ))}
            </ol>
          )}
        </Item>
      );
    case 'model':
      return <Item dot={<Cpu size={12} />} tone="accent" kind="model"><Body node={node} run={run} at={at} /></Item>;
    case 'step': {
      const { status } = node.step;
      return (
        <Item dot={status === 'fail' ? <X size={12} /> : status === 'skip' ? <CircleStop size={12} className="text-muted" /> : <CircleCheck size={12} className="text-green" />} tone={status === 'fail' ? 'red' : 'plain'} kind="step">
          <Body node={node} run={run} at={at} />
        </Item>
      );
    }
    case 'handoff':
      return <Item dot={<RefreshCw size={12} className="text-muted" />} tone="plain" kind="handoff"><Body node={node} run={run} at={at} /></Item>;
    case 'said':
      return <Item dot={<User size={12} className="text-muted" />} tone="plain" kind="said"><Body node={node} run={run} at={at} /></Item>;
    case 'note':
      return <Item dot={<Info size={12} className="text-muted" />} tone="plain" kind="note"><Body node={node} run={run} at={at} /></Item>;
    case 'check':
      return (
        <Item dot={node.ok ? <ShieldCheck size={12} className="text-green" /> : <ShieldAlert size={12} />} tone={node.ok ? 'plain' : 'red'} kind="check">
          <Body node={node} run={run} at={at} />
        </Item>
      );
    case 'ask':
    case 'pause':
      return (
        <Item dot={<TabiMark size={13} state="stopped" color="var(--amber)" label="" />} tone="amber" kind={node.kind}>
          <div className="px-[14px] py-3 border-[1.5px] border-amber-line bg-amber-bg rounded-card">
            <Line title={<span className="text-[11px] font-bold tracking-[.05em] uppercase text-amber">{node.kind === 'ask' ? 'Asked you' : 'Paused'}</span>} time={at(node.entry.at)} />
            <div className="font-semibold mt-1 [overflow-wrap:anywhere]">{node.question.replace(/\*\*/g, '')}</div>
            {node.kind === 'ask' && node.why && <div className="text-[12.5px] text-muted mt-[2px]">{node.why}</div>}
            {node.answer && (
              <div className="flex items-center gap-[6px] mt-2 text-[12.5px]">
                {node.kind === 'ask' && node.allowed === true ? <CircleCheck size={13} className="text-green" aria-hidden />
                  : node.kind === 'ask' && node.allowed === false ? <X size={13} className="text-red" aria-hidden /> : null}
                <span><b className="font-semibold">{capital(node.answer)}</b>{node.entry.ms !== undefined && !/^no answer/.test(node.answer) ? ` after ${seconds(node.entry.ms)}` : ''}</span>
              </div>
            )}
          </div>
        </Item>
      );
    case 'end': {
      const tone = node.status === 'done' ? 'green' : node.status === 'failed' ? 'red' : 'plain';
      const state: TabiMarkState = node.status === 'done' ? 'done' : node.status === 'failed' ? 'failed' : 'stopped';
      const summary = run.summary ?? node.entry.detail;
      return (
        <Item dot={<TabiMark size={13} state={state} label="" />} tone={tone} last kind="end">
          <div className={`px-[14px] py-3 rounded-card border ${node.status === 'failed' ? 'border-red bg-red-bg' : 'border-border bg-surface'}`}>
            <Line title={node.status === 'done' ? 'Done' : node.status === 'failed' ? 'Failed' : 'Stopped'} strong time={at(node.entry.at)} />
            {summary && summary !== run.status && <div className="answer mt-1 leading-[1.55] [overflow-wrap:anywhere]" dangerouslySetInnerHTML={{ __html: renderMarkdown(summary) }} />}
            {run.workflow && <div className="text-[12px] text-muted mt-[6px]">Replayed the workflow <span className="font-mono">/{run.workflow}</span></div>}
          </div>
        </Item>
      );
    }
  }
}

/** What a row says; used in the timeline and inside an opened fold. */
function Body({ node, run, at }: { node: TimelineNode; run: RunLog; at: (t: number) => string }) {
  switch (node.kind) {
    case 'model': {
      const e = node.entry;
      const title = node.first ? 'Read the page and made a plan' : e.text.startsWith('Fast model') ? 'Fast model chose the next step' : 'Chose the next steps';
      const meta = [e.model, e.ms !== undefined ? `${(e.ms / 1000).toFixed(1)}s` : '', e.tokens ? `${compactNumber(e.tokens)} tokens` : ''].filter(Boolean).join(' · ');
      const seen = seenChanges(e.detail);
      const plan = node.first ? (run.plan ?? []) : [];
      return (
        <>
          <Line title={title} strong time={at(e.at)}>{meta && <span className="font-mono text-[11.5px] text-muted [overflow-wrap:anywhere]">{meta}</span>}</Line>
          {plan.length > 0 && (
            <ol aria-label="Plan" className="mt-2 px-3 py-[10px] bg-surface border border-border rounded-ctl grid sm:grid-cols-2 gap-x-4 gap-y-1 text-[12.5px] text-muted">
              {plan.map((item, i) => {
                const done = /^\[[xX✓]\]/.test(item.trim());
                return (
                  <li key={i} className="flex gap-[6px]">
                    {done ? <CircleCheck size={13} className="text-green flex-none mt-[2px]" aria-label="Done" /> : <span className="font-mono w-[13px] text-center flex-none">{i + 1}</span>}
                    <span className={done ? 'text-text' : ''}>{item.replace(/^\s*\[[ xX✓]?\]\s*/, '')}</span>
                  </li>
                );
              })}
            </ol>
          )}
          {seen.lines.length > 0 && (
            <details className="mt-2 border border-border rounded-ctl bg-surface overflow-hidden group">
              <summary className="flex items-center gap-[6px] px-3 py-[7px] text-[12px] font-medium cursor-pointer list-none [&::-webkit-details-marker]:hidden">
                <ChevronDown size={13} className="text-muted -rotate-90 group-open:rotate-0 transition-transform" aria-hidden />
                What it saw change{seen.page ? ` on “${seen.page}”` : ''}
              </summary>
              <div className="px-3 py-2 border-t border-border font-mono text-[11.5px] leading-[1.7] [overflow-wrap:anywhere]">
                {seen.lines.map((l, i) => (
                  <div key={i} className={l.sign === '−' ? 'text-muted' : ''}>
                    {l.sign && <span className={l.sign === '+' ? 'text-green' : 'text-red'}>{l.sign} </span>}{l.text}
                  </div>
                ))}
              </div>
            </details>
          )}
        </>
      );
    }
    case 'step': {
      const { n, status, action, result, element } = node.step;
      return (
        <>
          <Line title={`Step ${n} · ${action}`} time={at(node.entry.at)}>
            {result && result !== 'Done' && <Muted tone={status === 'fail' ? 'text-red' : 'text-muted'}>{status === 'fail' ? `Didn’t work: ${result.replace(/^Didn['’]t work:\s*/i, '')}` : result}</Muted>}
          </Line>
          {element && <Mono>{element}</Mono>}
        </>
      );
    }
    case 'handoff':
      return <Line title="Backup took over" time={at(node.entry.at)}><Muted>{node.text}</Muted></Line>;
    case 'said':
      return <Line title="You said" time={at(node.entry.at)}><Muted>“{node.text}”</Muted></Line>;
    case 'note':
      return <Line title={<span className="font-normal text-muted text-[12px]">{node.text}</span>} time={at(node.entry.at)} />;
    case 'check':
      return node.ok ? (
        <Line title="Safety check passed" time={at(node.entry.at)}><Muted>Fits the task: {node.step}</Muted></Line>
      ) : (
        <>
          <Line title="Safety check: doesn’t fit the task" time={at(node.entry.at)}><Muted tone="text-red">“{node.step}”</Muted></Line>
          {node.reason && <div className="text-[12.5px] text-muted mt-[2px]">{capital(node.reason)}</div>}
        </>
      );
    default:
      return null;
  }
}
