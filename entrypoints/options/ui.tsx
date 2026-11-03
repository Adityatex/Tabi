// The Settings page's building blocks: section cards with a header, toggle
// rows, labelled fields, inline notices, list rows and empty states. Colours
// come from the tokens (assets/tabi.css).
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Check, ChevronsUpDown, CircleCheck, Coins, Copy, Info, TriangleAlert, X, type LucideIcon } from 'lucide-react';

/** A section's title and the sentence under it. */
export function PageHead({ title, children, right }: { title: string; children?: ReactNode; right?: ReactNode }) {
  return (
    <div className="flex items-end gap-4">
      <div className="flex-1">
        <h1 className="text-[24px] font-semibold tracking-[-0.02em]">{title}</h1>
        {children && <p className="text-muted mt-1 max-w-[620px] [text-wrap:pretty]">{children}</p>}
      </div>
      {right}
    </div>
  );
}

/** A card. With a title it gets a header row; `bare` leaves the padding to the children. */
export function Card({ title, note, right, children, bare, testId }: {
  title?: ReactNode; note?: ReactNode; right?: ReactNode; children?: ReactNode; bare?: boolean; testId?: string;
}) {
  return (
    <section className="bg-surface border border-border rounded-card" data-testid={testId}>
      {title && (
        <div className={`px-5 py-4 flex items-start gap-4 ${children ? 'border-b border-border' : ''}`}>
          <div className="flex-1 min-w-0">
            <h2 className="font-semibold text-[14px]">{title}</h2>
            {note && <div className="text-[12px] text-muted mt-[2px] max-w-[600px] [text-wrap:pretty]">{note}</div>}
          </div>
          {right}
        </div>
      )}
      {bare ? children : children && <div className="px-5 py-4">{children}</div>}
    </section>
  );
}

/** An on/off switch. */
export function Toggle({ on, onChange, label, disabled }: { on: boolean; onChange: (on: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!on)}
      className={`relative w-9 h-5 rounded-full flex-none mt-[2px] transition-colors ${on ? 'bg-accent' : 'bg-border-strong'} disabled:opacity-50`}
    >
      <span className={`absolute top-[2px] w-4 h-4 rounded-full bg-raised shadow-[0_1px_2px_rgba(0,0,0,.2)] transition-[left] ${on ? 'left-[18px]' : 'left-[2px]'}`} />
    </button>
  );
}

/** A setting with a switch: title, what it does, and anything that shows when it's on or off. */
export function ToggleRow({ title, note, on, onChange, children, tag }: {
  title: string; note?: ReactNode; on: boolean; onChange: (on: boolean) => void; children?: ReactNode; tag?: string;
}) {
  return (
    <div className="px-5 py-4 flex flex-col gap-3 border-b border-border last:border-b-0">
      <div className="flex gap-4 items-start">
        <div className="flex-1 min-w-0">
          <div className="font-semibold text-[14px] flex items-center gap-2">
            {title}
            {tag && <span className="text-[10.5px] font-semibold text-muted border border-border rounded-full px-[7px] py-px">{tag}</span>}
          </div>
          {note && <div className="text-[12px] text-muted mt-[2px] max-w-[560px] [text-wrap:pretty]">{note}</div>}
        </div>
        <Toggle on={on} onChange={onChange} label={title} />
      </div>
      {children}
    </div>
  );
}

/** A setting with a control on the right (a select, a segmented control). */
export function ControlRow({ title, note, control, children }: { title: string; note?: ReactNode; control: ReactNode; children?: ReactNode }) {
  return (
    <div className="px-5 py-4 flex flex-col gap-3 border-b border-border last:border-b-0">
      <div className={`flex gap-4 ${note ? 'items-start' : 'items-center'} flex-wrap`}>
        <div className="flex-1 min-w-[220px]">
          <div className="font-semibold text-[14px]">{title}</div>
          {note && <div className="text-[12px] text-muted mt-[2px] max-w-[560px] [text-wrap:pretty]">{note}</div>}
        </div>
        {control}
      </div>
      {children}
    </div>
  );
}

/** A label over its control. */
export function Field({ label, children, hint, className = '' }: { label: ReactNode; children: ReactNode; hint?: ReactNode; className?: string }) {
  return (
    <label className={`flex flex-col gap-[6px] min-w-0 ${className}`}>
      <span className="text-[12px] font-medium">{label}</span>
      {children}
      {hint}
    </label>
  );
}

const control = 'h-[34px] rounded-ctl border border-border-strong bg-raised px-[10px] min-w-0 w-full outline-none focus-visible:shadow-[var(--focus)] focus:border-accent';

/** One choice in a Select: what it saves, what it says, and a quiet note at its right. */
export interface Choice { value: string; label: string; hint?: string; icon?: ReactNode }

const popover = 'absolute left-0 right-0 z-30 bg-raised border border-border rounded-card shadow-pop p-1 max-h-[288px] overflow-y-auto scroll-thin';

/** Close a popover on a click outside `root`. */
function useOutside(root: React.RefObject<HTMLElement | null>, open: boolean, close: () => void) {
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (!root.current?.contains(e.target as Node)) close(); };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
}

/** Open upward when there's more room above than below. */
function opensUp(el: HTMLElement | null): boolean {
  if (!el) return false;
  const box = el.getBoundingClientRect();
  return innerHeight - box.bottom < 300 && box.top > innerHeight - box.bottom;
}

/** The option list both dropdowns share. */
function Options({ id, items, active, selected, up, onPick, onHover, render }: {
  id: string; items: number; active: number; selected: (i: number) => boolean; up: boolean;
  onPick: (i: number) => void; onHover: (i: number) => void; render: (i: number) => ReactNode;
}) {
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => { list.current?.querySelector(`[data-i="${active}"]`)?.scrollIntoView({ block: 'nearest' }); }, [active]);
  return (
    <div ref={list} role="listbox" id={id} className={`${popover} ${up ? 'bottom-full mb-1' : 'top-full mt-1'}`}>
      {Array.from({ length: items }, (_, i) => (
        <div
          key={i}
          id={`${id}-${i}`}
          data-i={i}
          role="option"
          aria-selected={selected(i)}
          onMouseDown={(e) => e.preventDefault()}
          // preventDefault: inside a Field's <label>, a click would otherwise reach the control again and reopen it
          onClick={(e) => { e.preventDefault(); onPick(i); }}
          onMouseMove={() => onHover(i)}
          className={`flex items-center gap-2 min-h-8 px-2 py-[6px] rounded-ctl cursor-pointer ${i === active ? 'bg-surface' : ''}`}
        >
          <span className="w-[13px] flex-none">{selected(i) && <Check size={13} strokeWidth={2.25} className="text-accent" aria-hidden />}</span>
          {render(i)}
        </div>
      ))}
    </div>
  );
}

/** A dropdown in the page's own style: click or arrow keys to open, type a letter to jump. */
export function Select({ value, onChange, options, mono, label, placeholder = 'Choose…', className = '' }: {
  value: string | number; onChange: (value: string) => void; options: Choice[]; mono?: boolean; label?: string; placeholder?: string; className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [up, setUp] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const typed = useRef({ text: '', at: 0 });
  const id = useId();
  const selected = options.findIndex((o) => o.value === String(value));
  useOutside(root, open, () => setOpen(false));

  const show = () => {
    setUp(opensUp(button.current));
    setActive(Math.max(0, selected));
    setOpen(true);
  };
  const choose = (i: number) => {
    if (options[i]) onChange(options[i].value);
    setOpen(false);
    button.current?.focus();
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    const last = options.length - 1;
    const move = (to: number) => { e.preventDefault(); if (!open) show(); else setActive(Math.min(last, Math.max(0, to))); };
    if (e.key === 'ArrowDown') return move(active + 1);
    if (e.key === 'ArrowUp') return move(active - 1);
    if (open && e.key === 'Home') return move(0);
    if (open && e.key === 'End') return move(last);
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      return open ? choose(active) : show();
    }
    if (e.key === 'Escape' && open) {
      e.preventDefault();
      e.stopPropagation();
      return setOpen(false);
    }
    if (e.key === 'Tab') return setOpen(false);
    // Type the start of a name to jump to it
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const now = Date.now();
      typed.current = { text: (now - typed.current.at < 700 ? typed.current.text : '') + e.key.toLowerCase(), at: now };
      const i = options.findIndex((o) => o.label.replace(/^\//, '').toLowerCase().startsWith(typed.current.text));
      if (i < 0) return;
      if (open) setActive(i);
      else onChange(options[i].value);
    }
  };

  const current = options[selected];
  return (
    <span ref={root} className={`relative flex min-w-0 ${className}`}>
      <button
        ref={button}
        type="button"
        role="combobox"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={id}
        aria-activedescendant={open ? `${id}-${active}` : undefined}
        onClick={() => (open ? setOpen(false) : show())}
        onKeyDown={onKeyDown}
        className={`${control} flex items-center gap-2 text-left ${open ? 'border-accent' : ''} ${mono ? 'font-mono text-[12px]' : ''}`}
      >
        {current?.icon && <span className="flex-none grid place-items-center text-text">{current.icon}</span>}
        <span className={`flex-1 min-w-0 truncate ${current ? '' : 'text-muted'}`}>{current?.label ?? placeholder}</span>
        {current?.hint && <span className="text-[11.5px] text-muted font-sans flex-none">{current.hint}</span>}
        <ChevronsUpDown size={13} className="text-muted flex-none" aria-hidden />
      </button>
      {open && (
        <Options
          id={id}
          items={options.length}
          active={active}
          up={up}
          selected={(i) => i === selected}
          onPick={choose}
          onHover={setActive}
          render={(i) => (
            <>
              {options[i].icon && <span className="flex-none grid place-items-center w-4">{options[i].icon}</span>}
              <span className={`flex-1 min-w-0 truncate ${i === selected ? 'font-medium' : ''} ${mono ? 'font-mono text-[12px]' : ''}`}>{options[i].label}</span>
              {options[i].hint && <span className="text-[11.5px] text-muted flex-none">{options[i].hint}</span>}
            </>
          )}
        />
      )}
    </span>
  );
}

/** A model the provider lists, and what to know about it. */
export interface ModelChoice { id: string; free?: boolean; mayTrain?: boolean }

/**
 * A model id: type any, or pick from the provider's list. Opening it shows the
 * whole list; typing narrows it. `onOpen` runs when it opens with no list yet,
 * to load one.
 */
export function ModelInput({ value, onChange, models, loading, error, onOpen, placeholder, label = 'Model', className = '' }: {
  value: string; onChange: (value: string) => void; models: ModelChoice[]; loading?: boolean; error?: string | null;
  onOpen?: () => void; placeholder?: string; label?: string; className?: string;
}) {
  const [open, setOpen] = useState(false);
  /** What's typed since it opened; null shows every model. */
  const [query, setQuery] = useState<string | null>(null);
  const [active, setActive] = useState(-1);
  const [up, setUp] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const id = useId();
  useOutside(root, open, () => setOpen(false));

  const q = query?.trim().toLowerCase() ?? '';
  const items = q ? models.filter((m) => m.id.toLowerCase().includes(q)) : models;
  // Nothing to add: the list would only repeat what's typed
  const pointless = items.length === 1 && items[0].id === value && query !== null;
  const showing = open && !pointless && (items.length > 0 || loading || (!!error && models.length === 0));

  const show = () => {
    setUp(opensUp(input.current));
    setQuery(null);
    setActive(Math.max(-1, models.findIndex((m) => m.id === value)));
    setOpen(true);
    if (!models.length && !loading) onOpen?.();
  };
  const choose = (i: number) => {
    if (!items[i]) return;
    onChange(items[i].id);
    setQuery(null);
    setOpen(false);
    input.current?.focus();
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!open) return show();
      setActive((a) => Math.min(items.length - 1, Math.max(0, a + (e.key === 'ArrowDown' ? 1 : -1))));
    } else if (e.key === 'Enter' && showing && items[active]) {
      e.preventDefault();
      choose(active);
    } else if (e.key === 'Escape' && open) {
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
    } else if (e.key === 'Tab') setOpen(false);
  };

  return (
    <span ref={root} className={`relative flex min-w-0 ${className}`}>
      <input
        ref={input}
        role="combobox"
        aria-label={label}
        aria-autocomplete="list"
        aria-expanded={showing}
        aria-controls={id}
        aria-activedescendant={showing && active >= 0 ? `${id}-${active}` : undefined}
        autoComplete="off"
        spellCheck={false}
        value={value}
        placeholder={placeholder}
        onChange={(e) => {
          onChange(e.target.value);
          setQuery(e.target.value);
          setActive(0);
          if (!open) { setUp(opensUp(input.current)); setOpen(true); }
        }}
        onClick={() => { if (!open) show(); }}
        onKeyDown={onKeyDown}
        className={`${control} font-mono text-[12px] pr-8 ${showing ? 'border-accent' : ''}`}
      />
      <button
        type="button"
        tabIndex={-1}
        aria-label={`Show ${label.toLowerCase()} list`}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => { if (open) setOpen(false); else { show(); input.current?.focus(); } }}
        className="absolute right-[3px] top-1/2 -translate-y-1/2 w-7 h-7 grid place-items-center rounded-ctl text-muted hover:text-text"
      >
        <ChevronsUpDown size={13} aria-hidden />
      </button>
      {showing && (items.length > 0 ? (
        <Options
          id={id}
          items={items.length}
          active={active}
          up={up}
          selected={(i) => items[i].id === value}
          onPick={choose}
          onHover={setActive}
          render={(i) => {
            const m = items[i];
            const at = q ? m.id.toLowerCase().indexOf(q) : -1;
            return (
              <>
                <span className="flex-1 min-w-0 font-mono text-[12px] truncate" title={m.id}>
                  {at < 0 ? m.id : <>{m.id.slice(0, at)}<b className="font-semibold text-accent">{m.id.slice(at, at + q.length)}</b>{m.id.slice(at + q.length)}</>}
                </span>
                {m.free && <span className="text-[10.5px] font-semibold text-green bg-green-bg rounded-full px-[6px] py-px flex-none">free</span>}
                {m.mayTrain && <span className="text-[10.5px] text-amber flex-none" title="The provider may train on what you send this model">may train</span>}
              </>
            );
          }}
        />
      ) : (
        <div role="status" className={`${popover} ${up ? 'bottom-full mb-1' : 'top-full mt-1'} px-3 py-[9px] text-[12px] ${loading ? 'text-muted' : 'text-red'}`}>
          {loading ? 'Loading models…' : error}
        </div>
      ))}
    </span>
  );
}

/** A text box; `icon` sits at its left. */
export function TextInput({ icon: Icon, mono, className = '', ...props }: React.InputHTMLAttributes<HTMLInputElement> & { icon?: LucideIcon; mono?: boolean }) {
  if (!Icon) return <input {...props} className={`${control} ${mono ? 'font-mono text-[12px]' : ''} ${className}`} />;
  return (
    <span className={`relative flex min-w-0 ${className}`}>
      <Icon size={13} className="absolute left-[10px] top-1/2 -translate-y-1/2 text-muted pointer-events-none" aria-hidden />
      <input {...props} className={`${control} pl-8 ${mono ? 'font-mono text-[12px]' : ''}`} />
    </span>
  );
}

/** A choice of a few options side by side. */
export function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: [T, string][]; onChange: (v: T) => void; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} className="flex p-[3px] rounded-card bg-bg border border-border gap-[2px] min-w-0">
      {options.map(([id, text]) => (
        <button
          key={id}
          type="button"
          role="radio"
          aria-checked={value === id}
          onClick={() => onChange(id)}
          className={`flex-1 h-7 px-3 rounded-ctl whitespace-nowrap ${value === id ? 'bg-raised shadow-[0_1px_2px_rgba(0,0,0,.1)] font-semibold' : 'text-muted'}`}
        >
          {text}
        </button>
      ))}
    </div>
  );
}

/** warn: amber (risk the user is taking). info: muted. error/ok: a result. */
export function Notice({ kind, children }: { kind: 'warn' | 'info' | 'cost' | 'error' | 'ok'; children: ReactNode }) {
  if (kind === 'ok' || kind === 'error') {
    return (
      <div role={kind === 'error' ? 'alert' : 'status'} className={`flex items-start gap-[5px] text-[12px] ${kind === 'ok' ? 'text-green' : 'text-red'}`}>
        {kind === 'ok' ? <CircleCheck size={13} className="flex-none mt-px" aria-hidden /> : <X size={13} className="flex-none mt-px" aria-hidden />}
        <span className="[overflow-wrap:anywhere]">{children}</span>
      </div>
    );
  }
  const Icon = kind === 'warn' ? TriangleAlert : kind === 'cost' ? Coins : Info;
  return (
    <div className={`flex gap-2 px-3 py-[10px] rounded-ctl text-[12.5px] leading-[1.45] ${kind === 'warn' ? 'bg-amber-bg border border-amber-line' : 'bg-bg border border-border text-muted text-[12px]'}`}>
      <Icon size={kind === 'warn' ? 15 : 14} className={`flex-none mt-px ${kind === 'warn' ? 'text-amber' : ''}`} aria-hidden />
      <span>{children}</span>
    </div>
  );
}

/** A dashed box for a list with nothing in it yet. */
export function Empty({ icon: Icon, title, children }: { icon: LucideIcon; title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center text-center gap-[6px] p-5 border border-dashed border-border-strong rounded-ctl">
      <Icon size={20} className="text-muted" aria-hidden />
      <div className="font-semibold">{title}</div>
      {children && <div className="text-[12px] text-muted max-w-[420px]">{children}</div>}
    </div>
  );
}

/** A small icon button (pause, delete, copy). */
export function IconButton({ icon: Icon, label, onClick, tone }: { icon: LucideIcon; label: string; onClick: () => void; tone?: 'accent' | 'danger' }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className={`p-[5px] rounded-ctl hover:bg-bg ${tone === 'accent' ? 'text-accent' : tone === 'danger' ? 'text-muted hover:text-red' : 'text-muted hover:text-text'}`}
    >
      <Icon size={15} aria-hidden />
    </button>
  );
}

/** A command to copy, in a code block with its name. */
export function CodeBlock({ title, code }: { title: string; code: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(code).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };
  return (
    <div className="rounded-ctl bg-bg border border-border overflow-hidden">
      <div className="flex items-center py-[5px] pr-[6px] pl-3 border-b border-border text-[12px] text-muted">
        <span className="flex-1">{title}</span>
        <button type="button" onClick={copy} className={`flex items-center gap-1 h-6 px-2 rounded-ctl font-medium ${copied ? 'text-green' : 'text-text hover:bg-surface'}`}>
          {copied ? <Check size={12} aria-hidden /> : <Copy size={12} aria-hidden />}{copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre className="p-3 font-mono text-[12px] leading-[1.6] whitespace-pre-wrap [overflow-wrap:anywhere]">{code}</pre>
    </div>
  );
}

/** Ask the background worker; resolves with its reply. */
export function send<T = any>(action: string, payload?: unknown): Promise<{ success: boolean; data?: T; error?: string }> {
  return (browser.runtime.sendMessage({ action, payload }) as Promise<any>)
    .then((res) => res ?? { success: false, error: 'No reply from Tabi' })
    .catch((err: Error) => ({ success: false, error: err?.message ?? String(err) }));
}

/** Save agent preferences; resolves false if it didn't work. */
export async function savePrefs(change: Record<string, unknown>): Promise<boolean> {
  return (await send('SAVE_PREFS', change)).success;
}
