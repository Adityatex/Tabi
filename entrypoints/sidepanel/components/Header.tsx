// The fixed top of the panel: the mark (it moves with the current tab's task),
// the model in use, History and Settings, then the tab the panel is working on.
import { ChevronDown, History, RefreshCw, Settings } from 'lucide-react';
import TabiMark, { type TabiMarkState } from '@/components/TabiMark';
import { pathOf, siteOf } from '@/lib/panel/view';

interface Props {
  mark: TabiMarkState;
  /** "Groq · qwen3.8-27b", or a hint when nothing is set up. */
  model: string;
  /** A backup provider took over from the main one. */
  backup: boolean;
  url?: string;
  onModel: () => void;
  onHistory: () => void;
  onSettings: () => void;
}

export default function Header({ mark, model, backup, url, onModel, onHistory, onSettings }: Props) {
  const site = siteOf(url);
  return (
    <header className="flex-none">
      <div className="flex items-center gap-2 pt-[10px] pr-2 pb-2 pl-[14px] min-w-0">
        <TabiMark state={mark} size={20} label={`Tabi: ${mark}`} />
        <div className="font-semibold text-[14.5px] tracking-[-0.01em]">Tabi</div>
        <div className="flex-1" />
        <button
          type="button"
          onClick={onModel}
          title="The AI model Tabi uses. Change it in Settings."
          className="flex items-center gap-[5px] h-[26px] pl-[9px] pr-[6px] border border-border rounded-full bg-surface font-mono text-[11px] whitespace-nowrap min-w-0"
        >
          <span className="overflow-hidden text-ellipsis" data-testid="model">{model}</span>
          {backup && (
            <span
              title="Your main provider hit a rate limit or failed, so a backup took over"
              className="flex items-center gap-[3px] font-sans text-[10.5px] font-semibold text-accent bg-accent-soft rounded-full px-[6px] py-px"
            >
              <RefreshCw size={10} strokeWidth={2} aria-hidden />backup
            </span>
          )}
          <ChevronDown size={12} className="text-muted flex-none" aria-hidden />
        </button>
        <div className="flex">
          <button type="button" className="icon-btn" title="History" aria-label="History" onClick={onHistory}><History size={16} strokeWidth={1.75} /></button>
          <button type="button" className="icon-btn" title="Settings" aria-label="Settings" onClick={onSettings}><Settings size={16} strokeWidth={1.75} /></button>
        </div>
      </div>
      {site && (
        <div className="flex items-center gap-2 mx-[10px] px-[9px] py-[6px] rounded-ctl bg-surface border border-border min-w-0" data-testid="site">
          <span aria-hidden className="w-4 h-4 flex-none rounded-[4px] bg-text text-bg grid place-items-center text-[10px] font-bold">{site[0].toUpperCase()}</span>
          <span className="font-medium text-[12.5px] flex-none">{site}</span>
          <span className="font-mono text-[11px] text-muted whitespace-nowrap overflow-hidden text-ellipsis min-w-0 flex-1">{pathOf(url)}</span>
        </div>
      )}
    </header>
  );
}
