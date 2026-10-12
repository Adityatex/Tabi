// Nothing running in this tab: ideas for the page, saved workflows to run,
// and recent tasks.
import { ArrowRight, CircleCheck, CircleStop, CircleX, FileText, FormInput, Play, Repeat, TextSelect, type LucideIcon } from 'lucide-react';
import type { PickerItem } from '@/lib/shortcuts/shortcut';
import { siteOf, when } from '@/lib/panel/view';

export interface RecentRun {
  id: string;
  goal: string;
  status: string;
  started: number;
}

interface Props {
  url?: string;
  workflows: PickerItem[];
  recent: RecentRun[];
  onCommand: (name: 'summarize' | 'explain' | 'autofill') => void;
  onRunWorkflow: (name: string) => void;
  onOpenRun: (id?: string) => void;
}

const IDEAS: [('summarize' | 'explain' | 'autofill'), string, LucideIcon][] = [
  ['summarize', 'Summarize this page', FileText],
  ['explain', 'Explain the text you’ve selected', TextSelect],
  ['autofill', 'Fill in this form from your profile', FormInput],
];

export default function Idle({ url, workflows, recent, onCommand, onRunWorkflow, onOpenRun }: Props) {
  const site = siteOf(url);
  // This site's workflows first
  const sorted = [...workflows].sort((a, b) => Number(b.site === site) - Number(a.site === site)).slice(0, 4);
  return (
    <div className="flex-1 min-h-0 overflow-y-auto scroll-thin pt-[18px] px-[10px] pb-[10px] flex flex-col gap-5" data-testid="idle">
      <div className="px-1">
        <h1 className="text-[18px] font-semibold tracking-[-0.02em]">{site ? 'What should Tabi do here?' : 'Open a web page to start'}</h1>
        <p className="text-muted mt-[3px]">{site ? 'Ask about this page, or tell Tabi what to do on it.' : 'Tabi reads and works on websites. You can still run a saved workflow.'}</p>
      </div>
      {site && (
        <div className="flex flex-col gap-[6px]">
          {IDEAS.map(([command, label, Icon]) => (
            <button
              key={command}
              type="button"
              onClick={() => onCommand(command)}
              className="flex items-center gap-[10px] px-3 py-[10px] bg-surface border border-border rounded-ctl text-left hover:border-border-strong"
            >
              <Icon size={15} className="text-accent flex-none" aria-hidden />
              <span className="flex-1">{label}</span>
              <ArrowRight size={14} className="text-muted" aria-hidden />
            </button>
          ))}
        </div>
      )}
      {sorted.length > 0 && (
        <section>
          <h2 className="t-label px-1 pb-2">Saved workflows</h2>
          <div className="flex flex-col gap-[6px]">
            {sorted.map((w) => (
              <div key={w.name} className="flex items-center gap-[10px] px-[10px] py-2 border border-border rounded-ctl bg-surface">
                <Repeat size={14} className="text-muted flex-none" aria-hidden />
                <div className="flex-1 min-w-0">
                  <div className="font-mono text-[12.5px] font-medium truncate">/{w.name}</div>
                  <div className="text-[11.5px] text-muted truncate">
                    {w.steps ?? '?'} steps · {w.site && w.site === site ? 'this site' : w.site ?? 'any site'}{w.site === site ? ' · no AI calls' : ''}
                  </div>
                </div>
                <button type="button" className="btn btn-sm btn-secondary" onClick={() => onRunWorkflow(w.name)} aria-label={`Run /${w.name}`}>
                  <Play size={11} aria-hidden />Run
                </button>
              </div>
            ))}
          </div>
        </section>
      )}
      {recent.length > 0 && (
        <section>
          <div className="flex justify-between items-baseline px-1 pb-2">
            <h2 className="t-label">Recent</h2>
            <button type="button" className="text-[12px] font-medium text-accent" onClick={() => onOpenRun()}>All history</button>
          </div>
          <ul className="flex flex-col">
            {recent.map((r) => {
              const Icon = r.status === 'done' ? CircleCheck : r.status === 'error' ? CircleX : CircleStop;
              const tone = r.status === 'done' ? 'text-green' : r.status === 'error' ? 'text-red' : 'text-muted';
              return (
                <li key={r.id}>
                  <button type="button" onClick={() => onOpenRun(r.id)} className="w-full flex items-center gap-[10px] px-[6px] py-2 border-t border-border text-left">
                    <Icon size={14} className={`${tone} flex-none`} aria-label={r.status} />
                    <span className="flex-1 min-w-0 truncate">{r.goal}</span>
                    <span className="text-[11.5px] text-muted flex-none">{when(r.started)}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </div>
  );
}
