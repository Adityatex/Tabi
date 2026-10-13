// The fixed top of the panel: the mark (it moves with the current tab's task),
// the model menu, History and Settings, then the page the panel is working on.
import { useEffect, useRef, useState } from 'react';
import { ArrowUpRight, Check, ChevronsUpDown, History, Plus, RefreshCw, Settings } from 'lucide-react';
import TabiMark, { type TabiMarkState } from '@/components/TabiMark';
import { siteOf } from '@/lib/panel/view';
import type { ModelChoice } from '../hooks';

interface Props {
  mark: TabiMarkState;
  /** The main provider and its model ("DeepSeek", "deepseek-flash"); both '' when nothing is set up. */
  provider: string;
  model: string;
  /** Shown instead of the model, e.g. while a workflow replays with no AI. */
  status?: string;
  /** A backup provider took over from the main one. */
  backup: boolean;
  choices: ModelChoice[];
  url?: string;
  title?: string;
  favicon?: string;
  onPickModel: (choice: ModelChoice) => void;
  onManageModels: () => void;
  onHistory: () => void;
  onSettings: () => void;
}

/** "qwen/qwen3.8-27b" → "qwen3.8-27b" */
const shortModel = (id: string) => id.replace(/^[^/]+\//, '');

export default function Header({ mark, provider, model, status, backup, choices, url, title, favicon, onPickModel, onManageModels, onHistory, onSettings }: Props) {
  const site = siteOf(url);
  const [open, setOpen] = useState(false);
  const [iconFailed, setIconFailed] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => setIconFailed(false), [favicon]);

  // Closes on a click elsewhere, and on Escape (focus goes back to the button)
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      root.current?.querySelector<HTMLButtonElement>('[aria-haspopup]')?.focus();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  const onMenuKey = (e: React.KeyboardEvent) => {
    const list = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]')];
    const at = list.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      list[(at + (e.key === 'ArrowDown' ? 1 : list.length - 1)) % list.length]?.focus();
    }
  };
  const pick = (choice: ModelChoice) => {
    setOpen(false);
    if (choice.rank !== 0) onPickModel(choice);
  };
  const manage = () => {
    setOpen(false);
    onManageModels();
  };

  return (
    <header className="flex-none">
      <div className="relative flex items-center gap-[6px] pt-[10px] pr-2 pb-2 pl-[14px] min-w-0">
        <TabiMark state={mark} size={20} label={`Tabi: ${mark}`} />
        <div className="font-semibold text-[14.5px] tracking-[-0.01em]">Tabi</div>
        <div className="flex-1" />
        {/* The menu hangs from the header's right edge, so it fits a narrow panel */}
        <div ref={root} className="min-w-0">
          <button
            type="button"
            onClick={() => (provider ? setOpen((o) => !o) : onManageModels())}
            aria-haspopup={provider ? 'menu' : undefined}
            aria-expanded={provider ? open : undefined}
            aria-label={provider ? `Model: ${provider}, ${model}. Switch model` : 'Set up a model'}
            title={provider ? 'Switch the model Tabi uses' : 'Set up a model in Settings'}
            className={`flex items-center gap-[6px] h-7 pl-[9px] pr-[6px] rounded-ctl min-w-0 max-w-full hover:bg-surface ${open ? 'bg-surface shadow-[inset_0_0_0_1px_var(--border-strong)]' : ''}`}
          >
            {status ? (
              <span className="text-[12px] text-muted whitespace-nowrap" data-testid="model">{status}</span>
            ) : provider ? (
              <>
                <span className="text-[12px] text-muted whitespace-nowrap">{provider}</span>
                <span className="font-mono text-[11.5px] font-medium whitespace-nowrap overflow-hidden text-ellipsis min-w-0" data-testid="model">{shortModel(model)}</span>
              </>
            ) : (
              <span className="text-[12px] text-muted whitespace-nowrap" data-testid="model">No model yet</span>
            )}
            {backup && (
              <span
                title="Your main provider hit a rate limit or failed, so a backup took over"
                className="flex items-center gap-[3px] text-[10.5px] font-semibold text-accent bg-accent-soft rounded-full px-[6px] py-px"
              >
                <RefreshCw size={10} strokeWidth={2} aria-hidden />backup
              </span>
            )}
            {provider && <ChevronsUpDown size={13} className="text-muted flex-none" aria-hidden />}
          </button>
          {open && (
            <div
              role="menu"
              aria-label="Model"
              onKeyDown={onMenuKey}
              className="absolute right-2 top-[calc(100%-4px)] w-[280px] max-w-[calc(100vw-20px)] bg-raised border border-border rounded-card shadow-pop p-1 z-30"
            >
              <div className="t-label px-2 pt-2 pb-1">Model for your tasks</div>
              {choices.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={c.rank === 0}
                  autoFocus={c.rank === 0}
                  onClick={() => pick(c)}
                  className={`w-full flex items-center gap-[9px] px-2 py-[7px] rounded-ctl text-left ${c.rank === 0 ? 'bg-accent-soft' : 'hover:bg-surface'}`}
                >
                  <span className="w-[13px] flex-none">{c.rank === 0 && <Check size={13} strokeWidth={2.25} className="text-accent" aria-hidden />}</span>
                  <span className="flex-1 min-w-0">
                    <span className="block font-medium">{c.name}</span>
                    <span className="block font-mono text-[11px] text-muted truncate">{c.model}</span>
                  </span>
                  <span className={`text-[11px] flex-none ${c.rank === 0 ? 'font-semibold text-accent' : 'text-muted'}`}>{c.rank === 0 ? 'Main' : `Backup ${c.rank}`}</span>
                </button>
              ))}
              <p className="text-[11.5px] text-muted px-2 pt-[6px] pb-2 leading-[1.45]">
                {choices.length > 1 ? 'Pick one to make it the main model. If the main one hits a rate limit, the next takes over.' : 'Add a backup provider, and Tabi switches to it when this one hits a rate limit.'}
              </p>
              <div className="h-px bg-border mx-1 mb-1" />
              <button
                type="button"
                role="menuitem"
                onClick={manage}
                className="w-full flex items-center gap-[9px] p-2 rounded-ctl text-left hover:bg-surface"
              >
                <Plus size={13} className="text-muted flex-none" aria-hidden />
                <span className="flex-1">Add a provider or change models</span>
                <ArrowUpRight size={13} className="text-muted flex-none" aria-hidden />
              </button>
            </div>
          )}
        </div>
        <span className="w-px h-4 bg-border flex-none" aria-hidden />
        <div className="flex flex-none">
          <button type="button" className="icon-btn" title="History" aria-label="History" onClick={onHistory}><History size={16} strokeWidth={1.75} /></button>
          <button type="button" className="icon-btn" title="Settings" aria-label="Settings" onClick={onSettings}><Settings size={16} strokeWidth={1.75} /></button>
        </div>
      </div>
      {site && (
        <div className="flex items-center gap-[9px] mx-[10px] px-[10px] py-[7px] rounded-card bg-surface border border-border min-w-0" data-testid="site">
          {favicon && !iconFailed
            ? <img src={favicon} alt="" className="w-[18px] h-[18px] flex-none rounded-[4px]" onError={() => setIconFailed(true)} />
            : <span aria-hidden className="w-[18px] h-[18px] flex-none rounded-[4px] bg-text text-bg grid place-items-center text-[10.5px] font-bold">{site[0].toUpperCase()}</span>}
          <div className="flex-1 min-w-0">
            <div className="font-medium text-[12.5px] truncate">{title?.trim() || site}</div>
            <div className="font-mono text-[10.5px] text-muted truncate">{site}</div>
          </div>
        </div>
      )}
    </header>
  );
}
