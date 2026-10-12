// The Settings page's building blocks: section cards with a header, toggle
// rows, labelled fields, inline notices, list rows and empty states. Colours
// come from the tokens (assets/tabi.css).
import { useState, type ReactNode } from 'react';
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
      <div className="flex gap-4 items-start flex-wrap">
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

/** A native select, styled like the design's. */
export function Select({ value, onChange, children, mono, label, className = '' }: {
  value: string | number; onChange: (value: string) => void; children: ReactNode; mono?: boolean; label?: string; className?: string;
}) {
  return (
    <span className={`relative flex min-w-0 ${className}`}>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-label={label}
        className={`${control} appearance-none pr-8 ${mono ? 'font-mono text-[12px]' : ''}`}
      >
        {children}
      </select>
      <ChevronsUpDown size={13} className="absolute right-[10px] top-1/2 -translate-y-1/2 text-muted pointer-events-none" aria-hidden />
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
