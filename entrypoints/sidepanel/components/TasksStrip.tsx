// Tasks in other tabs, above the composer: one line folded ("2 tasks in other
// tabs · 1 needs you"), a row each when open. A task waiting for an answer
// shows its question here, so it can be answered without switching tabs.
import { useState } from 'react';
import { ArrowUpRight, ChevronDown, ChevronUp, Layers } from 'lucide-react';
import TabiMark, { type TabiMarkState } from '@/components/TabiMark';
import { quote } from '@/lib/agent/stepView';
import { when } from '@/lib/panel/view';

export interface TaskRow {
  tabId: number;
  goal: string;
  status: string;
  step: number;
  updatedAt: number;
  asking?: { action: string; risk: string; reason?: string };
  title?: string;
  background?: boolean;
  here?: boolean;
}

interface Props {
  tasks: TaskRow[];
  /** Tab ids in order, for "tab 4". */
  tabIndex: (tabId: number) => number | undefined;
  onControl: (tabId: number, op: 'open' | 'allow' | 'deny' | 'continue' | 'stop') => void;
}

const MARK: Record<string, TabiMarkState> = { running: 'acting', paused: 'waiting', queued: 'idle', done: 'done', error: 'failed', stopped: 'stopped' };

export default function TasksStrip({ tasks, tabIndex, onControl }: Props) {
  const [open, setOpen] = useState(false);
  if (tasks.length === 0) return null;
  const needYou = tasks.filter((t) => t.status === 'paused').length;
  // Needs you first, then running, then the rest
  const order = ['paused', 'running', 'queued', 'done', 'error', 'stopped'];
  const sorted = [...tasks].sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status) || b.updatedAt - a.updatedAt);
  const label = `${tasks.length} task${tasks.length === 1 ? '' : 's'} ${open ? 'elsewhere' : 'in other tabs'}`;

  return (
    <div className={`flex-none mx-[10px] mb-2 mt-1 border border-border rounded-card bg-surface text-[12.5px] overflow-hidden ${open ? 'shadow-[0_-6px_20px_rgba(0,0,0,.05)]' : ''}`} data-testid="tasks-elsewhere">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className={`w-full flex items-center gap-2 px-[10px] ${open ? 'py-[9px] border-b border-border' : 'py-[7px]'} min-w-0 text-left`}>
        <Layers size={13} className="text-muted flex-none" aria-hidden />
        <span className={`whitespace-nowrap ${open ? 'font-semibold flex-1' : ''}`}>{label}</span>
        {!open && needYou > 0 && (
          <span className="flex items-center gap-[5px] text-amber font-semibold whitespace-nowrap">
            <span aria-hidden className="w-[7px] h-[7px] rounded-full bg-amber" />{needYou} need{needYou === 1 ? 's' : ''} you
          </span>
        )}
        {!open && <span className="flex-1" />}
        {open ? <ChevronDown size={13} className="text-muted" aria-hidden /> : <ChevronUp size={13} className="text-muted" aria-hidden />}
      </button>
      {open && sorted.map((t, i) => {
        const index = tabIndex(t.tabId);
        const where = t.background ? 'background' : index !== undefined ? `tab ${index + 1}` : '';
        const last = i === sorted.length - 1;
        if (t.status === 'paused') {
          return (
            <div key={t.tabId} className={`p-[10px] bg-amber-bg ${last ? '' : 'border-b border-border'}`}>
              <div className="flex items-center gap-[7px]">
                <TabiMark state="waiting" size={13} label="" />
                <span className="font-semibold flex-1 min-w-0 truncate">{t.goal}</span>
                <span className="font-mono text-[11px] text-muted">{where}</span>
              </div>
              <div className="mt-[5px] mb-2 ml-5 leading-[1.45]">
                {t.asking
                  ? `Allow Tabi to ${t.asking.action.replace(/"([^"]*)"/g, (_, x: string) => quote(x))}?${t.asking.risk === 'off-task' ? ' A safety check doubts it fits the task.' : ''}`
                  : 'Paused. Keep going?'}
              </div>
              <div className="flex gap-[6px] ml-5">
                {t.asking ? (
                  <>
                    <button type="button" className="btn btn-sm h-[26px] bg-amber-solid text-amber-on font-semibold" onClick={() => onControl(t.tabId, 'allow')}>Allow</button>
                    <button type="button" className="btn btn-sm btn-secondary h-[26px]" onClick={() => onControl(t.tabId, 'deny')}>Don't allow</button>
                  </>
                ) : (
                  <button type="button" className="btn btn-sm h-[26px] bg-amber-solid text-amber-on font-semibold" onClick={() => onControl(t.tabId, 'continue')}>Keep going</button>
                )}
                <div className="flex-1" />
                <button type="button" className="btn btn-sm btn-quiet h-[26px] px-1" onClick={() => onControl(t.tabId, 'open')}>Open<ArrowUpRight size={12} aria-hidden /></button>
              </div>
            </div>
          );
        }
        const meta = t.status === 'running' ? [where, `step ${t.step}`].filter(Boolean).join(' · ')
          : t.status === 'queued' ? 'waiting for a slot'
          : `${t.status === 'done' ? 'done' : t.status === 'error' ? 'failed' : 'stopped'} · ${when(t.updatedAt)}`;
        return (
          <button key={t.tabId} type="button" onClick={() => onControl(t.tabId, 'open')} className={`w-full flex items-center gap-[7px] px-[10px] py-[9px] text-left ${last ? '' : 'border-b border-border'}`}>
            <TabiMark state={MARK[t.status] ?? 'idle'} size={13} label="" />
            <span className="flex-1 min-w-0 truncate">{t.goal}</span>
            <span className={t.status === 'done' ? 'text-[11px] text-green font-semibold' : t.status === 'error' ? 'text-[11px] text-red font-semibold' : 'font-mono text-[11px] text-muted'}>{meta}</span>
          </button>
        );
      })}
    </div>
  );
}
