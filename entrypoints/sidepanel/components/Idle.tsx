// Nothing running in this tab. On a web page: a line on what to do, this
// site's saved workflows, and recent tasks; everything else is one / away in
// the box. Elsewhere (a new tab, a browser page): a welcome and the keys to know.
import { CircleCheck, CircleStop, CircleX, Play, Repeat } from 'lucide-react';
import type { PickerItem } from '@/lib/shortcuts/shortcut';
import { siteOf, when } from '@/lib/panel/view';
import { useOpenShortcut, ASK_COMMAND } from '@/components/useOpenShortcut';

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
  /** Opens the / menu in the box. */
  onSlash: () => void;
  onRunWorkflow: (name: string) => void;
  onOpenRun: (id?: string) => void;
}

/** The big footprint for the welcome: the mark's two capsules, as in TabiMark. */
function Footprint() {
  return (
    <div aria-hidden className="relative w-11 h-11">
      <div className="absolute inset-0 rotate-[15deg]">
        <div className="absolute left-[4.84px] top-[10.56px] w-[11.88px] h-[14.96px] rounded-full bg-accent" />
        <div className="absolute left-[19.36px] top-[3.52px] w-[18.92px] h-[36.96px] rounded-full bg-accent" />
      </div>
    </div>
  );
}

function SlashKey({ onSlash }: { onSlash: () => void }) {
  return (
    <button
      type="button"
      onClick={onSlash}
      title="Open the / menu"
      aria-label="Open the / menu"
      className="font-mono text-[10.5px] text-muted border border-border-strong rounded-[4px] px-[5px] leading-[17px] hover:text-text hover:border-muted"
    >
      /
    </button>
  );
}

export default function Idle({ url, workflows, recent, onSlash, onRunWorkflow, onOpenRun }: Props) {
  const site = siteOf(url);
  const openKey = useOpenShortcut();
  const askKey = useOpenShortcut(ASK_COMMAND);
  const here = site ? workflows.filter((w) => w.site === site).slice(0, 3) : [];
  const keys: [string, string][] = [
    ...(openKey ? [[openKey, 'Open Tabi from any page'] as [string, string]] : []),
    ...(askKey ? [[askKey, 'Ask about the text you’ve selected'] as [string, string]] : []),
  ];

  return (
    <div className="flex-1 min-h-0 overflow-y-auto scroll-thin px-[10px] pb-[10px] flex flex-col gap-[22px]" data-testid="idle">
      {site ? (
        <div className="px-1 pt-[22px]">
          <h1 className="text-[18px] font-semibold tracking-[-0.02em]">What should Tabi do here?</h1>
          <p className="text-muted mt-1 leading-[1.5]">
            Ask about this page, or tell Tabi what to do on it. Type <SlashKey onSlash={onSlash} /> for Autofill, Summarize and your saved routines.
          </p>
        </div>
      ) : (
        <>
          <div className="flex flex-col items-center text-center gap-[14px] pt-9 px-1">
            <Footprint />
            <div>
              <h1 className="text-[22px] font-semibold tracking-[-0.025em]">Hi, I’m Tabi.</h1>
              <p className="text-muted mt-[6px] text-[13.5px] leading-[1.5] max-w-[300px]">
                Open a web page and I’ll read it, answer your questions about it, or do tasks on it for you.
              </p>
            </div>
          </div>
          <section aria-label="Keys to know" className="border border-border rounded-card bg-surface px-3 py-1">
            {keys.map(([key, label]) => (
              <div key={label} className="flex items-center gap-[10px] py-2 text-[12.5px] border-b border-border">
                <span className="w-12 flex-none flex justify-center"><span className="font-mono text-[10.5px] text-muted border border-border-strong rounded-[4px] px-[5px] leading-[17px]">{key}</span></span>
                <span>{label}</span>
              </div>
            ))}
            <div className="flex items-center gap-[10px] py-2 text-[12.5px]">
              <span className="w-12 flex-none flex justify-center"><SlashKey onSlash={onSlash} /></span>
              <span>Your saved workflows, shortcuts and skills</span>
            </div>
          </section>
        </>
      )}
      {here.length > 0 && (
        <section>
          <h2 className="t-label px-1 pb-2">Saved for this site</h2>
          <div className="flex flex-col gap-[6px]">
            {here.map((w) => (
              <div key={w.name} className="flex items-center gap-[10px] px-[10px] py-[9px] border border-border rounded-card bg-surface">
                <Repeat size={14} className="text-muted flex-none" aria-hidden />
                <div className="flex-1 min-w-0">
                  <div className="font-mono text-[12.5px] font-medium truncate">/{w.name}</div>
                  <div className="text-[11.5px] text-muted truncate">Workflow · {w.steps ?? '?'} steps · no AI calls</div>
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
