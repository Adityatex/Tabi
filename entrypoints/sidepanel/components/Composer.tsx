// The one input box: ask about the page or tell Tabi what to do. Auto picks
// Answer or Do it from the words, and the chip switches it. Background runs
// the task in a new tab. Typing / opens shortcuts, workflows, skills and commands.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AppWindow, ArrowUp, BookOpen, Check, ChevronDown, FileText, FormInput, MessageCircle, Repeat, TextSelect, Zap, type LucideIcon } from 'lucide-react';
import { blanks, matchItems, type PickerItem } from '@/lib/shortcuts/shortcut';
import { useOpenShortcut } from '@/components/useOpenShortcut';

export type Mode = 'auto' | 'answer' | 'do';

/** The panel's own commands, offered in the / picker. */
export const COMMANDS: PickerItem[] = [
  { kind: 'command', name: 'summarize', detail: 'this page' },
  { kind: 'command', name: 'explain', detail: 'select text first' },
  { kind: 'command', name: 'autofill', detail: 'from your profile' },
];
const COMMAND_LABEL: Record<string, [string, LucideIcon]> = {
  summarize: ['Summarize', FileText], explain: ['Explain selection', TextSelect], autofill: ['Autofill', FormInput],
};
const GROUPS: { kind: PickerItem['kind']; label: string }[] = [
  { kind: 'shortcut', label: 'Shortcuts' }, { kind: 'workflow', label: 'Workflows' }, { kind: 'skill', label: 'Skills' },
  { kind: 'command', label: 'Commands' },
];

interface Props {
  value: string;
  onChange: (value: string) => void;
  mode: Mode;
  onMode: (mode: Mode) => void;
  background: boolean;
  onBackground: (on: boolean) => void;
  /** Send what's typed (Enter). */
  onSubmit: () => void;
  /** Run a picker item at once (Enter on it, or a click). */
  onPick: (item: PickerItem) => void;
  /** Workflows and shortcuts; reloaded when / is typed. */
  pickerItems: PickerItem[];
  onRefreshPicker: () => void;
  placeholder: string;
  disabled?: boolean;
}

export default function Composer(props: Props) {
  const { value, onChange, mode, onMode, background, onBackground, onSubmit, onPick, pickerItems, onRefreshPicker, placeholder, disabled } = props;
  const box = useRef<HTMLTextAreaElement>(null);
  const [menu, setMenu] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const openKey = useOpenShortcut();

  // The picker shows while a /name is being typed ("/pri"), not once words follow it
  const typingName = /^\/\S*$/.test(value);
  const matched = typingName ? matchItems(value.slice(1), [...pickerItems, ...COMMANDS], 12) : [];
  const ordered = GROUPS.flatMap((g) => matched.filter((m) => m.kind === g.kind));
  const open = ordered.length > 0 && !dismissed;

  useEffect(() => { setHighlight(0); }, [value]);
  useEffect(() => {
    if (value === '/') {
      setDismissed(false);
      onRefreshPicker();
    }
  }, [value]); // eslint-disable-line react-hooks/exhaustive-deps
  // Grows with its text, up to a few lines. Empty, it keeps its CSS height:
  // Chrome counts the placeholder in scrollHeight, and while the panel is
  // still opening it's narrow enough to wrap the placeholder many times.
  const fit = () => {
    const el = box.current;
    if (!el) return;
    el.style.height = 'auto';
    if (el.value) el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
  };
  useLayoutEffect(fit, [value]);
  // The panel changes width as it opens and when it's resized: wrap the text again
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    let width = el.clientWidth;
    const watch = new ResizeObserver(() => {
      if (el.clientWidth === width) return;
      width = el.clientWidth;
      fit();
    });
    watch.observe(el);
    return () => watch.disconnect();
  }, []);
  // The shortcut (or the toolbar icon) opens the panel; focus lands in the box
  useEffect(() => { box.current?.focus(); }, []);

  const complete = (item: PickerItem) => {
    onChange(`/${item.name} `);
    box.current?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (open) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        setHighlight((h) => (h + (e.key === 'ArrowDown' ? 1 : ordered.length - 1)) % ordered.length);
        return;
      }
      if (e.key === 'Tab') {
        e.preventDefault();
        // A command runs; a workflow, shortcut or skill gets its name in the box, to add words after it
        const item = ordered[highlight];
        if (item.kind === 'command') onPick(item);
        else complete(item);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setDismissed(true);
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        onPick(ordered[highlight]);
        return;
      }
    }
    if (e.key === 'Escape' && menu) setMenu(false);
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (value.trim() && !disabled) onSubmit();
    }
  };

  const modeLabel = mode === 'answer' ? 'Answer' : mode === 'do' ? 'Do it' : 'Auto';
  const ModeIcon = mode === 'answer' ? MessageCircle : Zap;
  const canSend = !!value.trim() && !disabled;

  return (
    <footer className="flex-none relative pt-2 px-[10px] pb-[9px] border-t border-border bg-bg">
      {open && (
        <div
          role="listbox"
          aria-label="Shortcuts, workflows, skills and commands"
          className="absolute left-[10px] right-[10px] bottom-full mb-2 bg-raised border border-border rounded-card shadow-[0_12px_36px_rgba(0,0,0,.16)] p-[6px] text-[12.5px] max-h-[60vh] overflow-y-auto scroll-thin z-10"
        >
          {GROUPS.map((group, gi) => {
            const items = ordered.filter((m) => m.kind === group.kind);
            if (!items.length) return null;
            const firstGroup = GROUPS.findIndex((g) => ordered.some((m) => m.kind === g.kind)) === gi;
            return (
              <div key={group.kind}>
                <div className={`text-[10.5px] font-semibold tracking-[.06em] uppercase text-muted px-2 pb-1 ${firstGroup ? 'pt-[6px]' : 'pt-2 border-t border-border mt-1'}`}>{group.label}</div>
                {items.map((item) => {
                  const i = ordered.indexOf(item);
                  const on = i === highlight;
                  const [label, CommandIcon] = COMMAND_LABEL[item.name] ?? [item.name, Zap];
                  const Icon = item.kind === 'workflow' ? Repeat : item.kind === 'skill' ? BookOpen : item.kind === 'command' ? CommandIcon : Zap;
                  const fill = item.kind === 'shortcut' ? blanks(item.detail) : [];
                  return (
                    <div
                      key={`${item.kind}:${item.name}`}
                      role="option"
                      aria-selected={on}
                      onMouseDown={(e) => { e.preventDefault(); onPick(item); }}
                      onMouseEnter={() => setHighlight(i)}
                      className={`p-2 rounded-ctl cursor-pointer ${on ? 'bg-accent-soft' : ''}`}
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <Icon size={13} className={on ? 'text-accent flex-none' : 'text-muted flex-none'} aria-hidden />
                        {item.kind === 'command'
                          ? <span className="font-medium">{label}</span>
                          : <span className={`font-mono font-medium truncate max-w-[60%] ${on ? 'text-accent' : ''}`}>/{item.name}</span>}
                        {fill.length > 0 && <span className="font-mono text-muted whitespace-nowrap overflow-hidden text-ellipsis">{fill.map((b) => `{${b}}`).join(' ')}</span>}
                        {item.kind !== 'shortcut' && (item.kind !== 'skill' || item.site) && (
                          <span className="text-[11.5px] text-muted whitespace-nowrap overflow-hidden text-ellipsis min-w-0">
                            {item.kind === 'workflow' ? `${item.steps ?? '?'} steps${item.site ? ` · ${item.site}` : ''} · no AI calls` : item.kind === 'skill' ? item.site : item.detail}
                          </span>
                        )}
                        <span className="flex-1" />
                        {on && item.kind !== 'command' && <span className="font-mono text-[10.5px] text-muted border border-border-strong rounded-[3px] px-1 flex-none">Tab</span>}
                      </div>
                      {(item.kind === 'shortcut' || item.kind === 'skill') && <div className="text-[11.5px] text-muted mt-[3px] ml-[21px] [overflow-wrap:anywhere]">{item.detail}</div>}
                    </div>
                  );
                })}
              </div>
            );
          })}
          <div className="flex gap-3 px-2 pt-2 pb-1 border-t border-border mt-1 text-[11px] text-muted"><span>↑↓ to move</span><span>Tab to pick</span><span>Esc to close</span></div>
        </div>
      )}
      <div className="border border-border rounded-card bg-raised pt-[9px] pr-[9px] pb-[7px] pl-[11px] focus-within:border-border-strong">
        <textarea
          ref={box}
          rows={1}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          aria-label="Ask about this page or tell Tabi what to do"
          aria-autocomplete="list"
          aria-expanded={open}
          className="block w-full bg-transparent resize-none outline-none text-[13px] leading-[1.4] min-h-[34px] placeholder:text-muted focus-visible:shadow-none"
        />
        <div className="flex items-center gap-[6px]">
          <div className="relative">
            <button
              type="button"
              onClick={() => setMenu((m) => !m)}
              aria-haspopup="menu"
              aria-expanded={menu}
              title="Auto: Tabi decides whether to answer or do it"
              className={mode === 'auto' ? 'chip pl-2 pr-[6px]' : 'chip chip-on pl-2 pr-[6px]'}
            >
              {mode !== 'auto' && <ModeIcon size={12} aria-hidden />}{modeLabel}<ChevronDown size={11} aria-hidden />
            </button>
            {menu && (
              <div role="menu" className="absolute left-0 bottom-full mb-1 w-[220px] bg-raised border border-border rounded-card shadow-pop p-1 z-20" onKeyDown={(e) => e.key === 'Escape' && setMenu(false)}>
                {([['auto', 'Auto', 'Tabi decides from your words'], ['answer', 'Answer', 'Reads this page only, never clicks'], ['do', 'Do it', 'Acts on the page for you']] as [Mode, string, string][]).map(([m, label, hint]) => (
                  <button
                    key={m}
                    type="button"
                    role="menuitemradio"
                    aria-checked={mode === m}
                    autoFocus={mode === m}
                    onClick={() => { onMode(m); setMenu(false); box.current?.focus(); }}
                    className="w-full flex items-start gap-2 p-2 rounded-ctl text-left hover:bg-surface"
                  >
                    <span className="w-3 pt-[2px] flex-none">{mode === m && <Check size={12} className="text-accent" aria-hidden />}</span>
                    <span><span className="block font-medium text-[12.5px]">{label}</span><span className="block text-[11.5px] text-muted">{hint}</span></span>
                  </button>
                ))}
              </div>
            )}
          </div>
          <button
            type="button"
            aria-pressed={background}
            onClick={() => onBackground(!background)}
            title="Run it in a new background tab, so you can keep using this one"
            className={background ? 'chip chip-on' : 'chip'}
          >
            <AppWindow size={12} aria-hidden />Background
          </button>
          <div className="flex-1" />
          <span className="font-mono text-[11px] text-muted border border-border rounded-[4px] px-[5px] leading-[18px]" title="Type / for shortcuts, workflows, skills and commands">/</span>
          <button
            type="button"
            onClick={onSubmit}
            disabled={!canSend}
            aria-label="Send"
            className={`w-7 h-7 rounded-ctl grid place-items-center ${canSend ? 'bg-accent text-accent-text' : 'bg-border text-muted'}`}
          >
            <ArrowUp size={15} aria-hidden />
          </button>
        </div>
      </div>
      <div className="flex justify-between gap-2 text-[11px] text-muted mt-[6px] px-[2px]">
        <span className="whitespace-nowrap overflow-hidden text-ellipsis">Enter to send · Shift+Enter for a new line</span>
        {openKey && <span className="font-mono flex-none" title="Opens Tabi from any page. Change it in Settings, Appearance & keyboard">{openKey}</span>}
      </div>
    </footer>
  );
}
