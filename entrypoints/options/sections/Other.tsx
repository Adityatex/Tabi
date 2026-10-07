// entrypoints/options/sections/Other.tsx
// Autofill profile, Appearance, Privacy & data, and About.
import { useEffect, useState } from 'react';
import { ArrowUpRight, Database, History, Keyboard, Trash2, X } from 'lucide-react';
import { loadStoredProfile, saveStoredProfile, PROFILE_FIELDS, DEFAULT_PROFILE, type AutofillProfile } from '@/lib/automation/profile';
import { MAX_RUNS } from '@/lib/agent/timeline';
import TabiMark from '@/components/TabiMark';
import { Card, ControlRow, Field, Notice, PageHead, Segmented, TextInput, ToggleRow, send } from '../ui';
import { DEFAULT_SELECTION, SELECTION_KEY, cleanSelectionPrefs, loadSelectionPrefs, updateSelectionPrefs, type SelectionPrefs } from '@/lib/utils/selectionPrefs';
import { THEMES, loadTheme, saveTheme, type Theme } from '@/lib/utils/theme';
import { shortcutsPage, useOpenShortcut } from '@/components/useOpenShortcut';

export function Autofill() {
  const [profile, setProfile] = useState<AutofillProfile>({ ...DEFAULT_PROFILE });
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => { loadStoredProfile().then(setProfile).catch(() => {}); }, []);

  const save = async () => {
    try {
      await saveStoredProfile(profile);
      setMessage({ ok: true, text: 'Saved on this device.' });
    } catch (err) {
      setMessage({ ok: false, text: (err as Error)?.message || 'Couldn’t save it' });
    }
  };

  return (
    <>
      <PageHead title="Autofill profile">Your details, for filling in forms: type /autofill in the side panel. They’re kept only in this browser, and nothing is filled without you asking.</PageHead>
      <Card bare testId="autofill">
        <form className="px-5 py-[18px] grid grid-cols-1 sm:grid-cols-2 gap-x-5 gap-y-4" onSubmit={(e) => { e.preventDefault(); save(); }}>
          {PROFILE_FIELDS.map((f) => (
            <Field key={f.key} label={f.label} className={f.key === 'address' ? 'sm:col-span-2' : ''}>
              <TextInput
                type={f.type || 'text'}
                placeholder={f.placeholder}
                value={profile[f.key]}
                onChange={(e) => { setProfile((p) => ({ ...p, [f.key]: e.target.value })); setMessage(null); }}
              />
            </Field>
          ))}
          <div className="sm:col-span-2 flex items-center gap-3">
            <button type="submit" className="btn btn-primary">Save profile</button>
            {message && <Notice kind={message.ok ? 'ok' : 'error'}>{message.text}</Notice>}
          </div>
        </form>
      </Card>
    </>
  );
}

export function Appearance() {
  const [theme, setTheme] = useState<Theme>('system');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { loadTheme().then(setTheme).catch(() => {}); }, []);

  const choose = async (next: Theme) => {
    const before = theme;
    setTheme(next);
    setError(null);
    try {
      await saveTheme(next);
    } catch (err) {
      setTheme(before);
      setError((err as Error)?.message || 'Couldn’t save it');
    }
  };

  return (
    <>
      <PageHead title="Appearance & keyboard">How Tabi looks, the key that opens it, and the toolbar on selected text.</PageHead>
      <Card bare testId="appearance">
        <ControlRow
          title="Theme"
          note="System follows your computer’s light or dark setting. The change shows everywhere at once, the toolbar on selected text included. The toolbar icon follows the browser, and the cue on a page follows that page."
          control={<Segmented<Theme> label="Theme" value={theme} onChange={choose} options={THEMES} />}
        >
          {error && <Notice kind="error">{error}</Notice>}
        </ControlRow>
        <KeyboardShortcut />
      </Card>
      <SelectionToolbarSetting />
    </>
  );
}

/** The toolbar on selected text: on or off, and the sites it stays off. */
function SelectionToolbarSetting() {
  const [prefs, setPrefs] = useState<SelectionPrefs | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    loadSelectionPrefs().then(setPrefs).catch(() => setPrefs(DEFAULT_SELECTION));
    // The toolbar's own menu changes them too
    const onChange = (changes: Record<string, { newValue?: unknown }>, area: string) => {
      if (area === 'local' && SELECTION_KEY in changes) setPrefs(cleanSelectionPrefs(changes[SELECTION_KEY].newValue));
    };
    browser.storage.onChanged.addListener(onChange);
    return () => browser.storage.onChanged.removeListener(onChange);
  }, []);
  const change = async (c: Parameters<typeof updateSelectionPrefs>[0]) => {
    setError(null);
    try {
      setPrefs(await updateSelectionPrefs(c));
    } catch (err) {
      setError((err as Error)?.message || 'Couldn’t save it');
    }
  };
  if (!prefs) return null;
  return (
    <Card bare testId="selection-toolbar">
      <ToggleRow
        title="Toolbar on selected text"
        note="Select text on any page to ask about it, explain, translate or summarize it, with the answer beside the text. Nothing is sent to your AI provider until you press one of its buttons. It uses your fast model when you have one."
        on={prefs.enabled}
        onChange={(on) => change({ enabled: on })}
      >
        {error && <Notice kind="error">{error}</Notice>}
        {prefs.enabled && prefs.hiddenOn.length > 0 && (
          <div className="flex flex-col gap-[6px]">
            <div className="text-[12px] font-medium">Not shown on</div>
            <ul className="flex flex-wrap gap-[6px]">
              {prefs.hiddenOn.map((site) => (
                <li key={site} className="flex items-center gap-1 h-7 pl-[10px] pr-1 rounded-ctl border border-border bg-bg font-mono text-[12px]">
                  {site}
                  <button type="button" className="icon-btn w-5 h-5" aria-label={`Show on ${site} again`} title="Show here again" onClick={() => change({ show: site })}><X size={12} /></button>
                </li>
              ))}
            </ul>
          </div>
        )}
        {prefs.enabled && prefs.hiddenOn.length === 0 && (
          <div className="text-[12px] text-muted">To keep it off a site, use “Don’t show on …” in the toolbar’s ⋯ menu there.</div>
        )}
      </ToggleRow>
    </Card>
  );
}

/** The key that opens Tabi, as the browser has it, and the way to change it (only the browser can). */
function KeyboardShortcut() {
  const shortcut = useOpenShortcut();
  const page = shortcutsPage();
  return (
    <ControlRow
      title="Open Tabi"
      note="Opens the side panel from any page. Only the browser can change it: Change opens its shortcuts page, where you set Tabi’s “Open Tabi”. Pick a key the browser doesn’t use, since its own shortcuts win (Ctrl+G is its Find next)."
      control={(
        <div className="flex items-center gap-2">
          {shortcut === undefined ? null : shortcut
            ? <kbd className="font-mono text-[12.5px] border border-border-strong rounded-[4px] px-[7px] py-[2px] bg-bg" data-testid="open-shortcut">{shortcut}</kbd>
            : <span className="text-[12.5px] text-muted" data-testid="open-shortcut">Not set</span>}
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => browser.tabs.create({ url: page })}>
            <Keyboard size={13} aria-hidden />{shortcut ? 'Change' : 'Set a shortcut'}
          </button>
        </div>
      )}
    >
      {shortcut === '' && <Notice kind="info">No key opens Tabi right now: the browser may have kept the one Tabi suggested for itself. The toolbar icon and the right-click menu still open it.</Notice>}
    </ControlRow>
  );
}

const STORED: [string, string][] = [
  ['API keys', 'In this browser only. Each is sent only to its own provider, and this page only ever sees them masked.'],
  ['Pages Tabi reads', 'Sent to the AI provider you chose, as part of each request. Nothing goes anywhere else.'],
  ['Run history', `The last ${MAX_RUNS} tasks, step by step, in this browser. Typed passwords and card numbers are masked.`],
  ['Skills, workflows, shortcuts, schedules', 'In this browser. A workflow that types a password keeps it here, like your keys.'],
  ['Autofill profile, site lists and appearance', 'In this browser.'],
];

export function Privacy() {
  const [runs, setRuns] = useState<number | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const load = () => send<unknown[]>('LIST_RUNS').then((res) => { if (res.success) setRuns(res.data?.length ?? 0); });
  useEffect(() => { load(); }, []);

  const deleteAll = async () => {
    const res = await send('DELETE_RUNS', {});
    setConfirming(false);
    setMessage(res.success ? 'All run history is deleted.' : res.error ?? 'Couldn’t delete it');
    load();
  };

  return (
    <>
      <PageHead title="Privacy & data">Tabi has no server and no account. Everything below stays in this browser, apart from what each task sends to the AI provider you picked.</PageHead>
      <Card title="What’s stored where" bare>
        <dl className="px-5 py-2">
          {STORED.map(([what, where]) => (
            <div key={what} className="grid grid-cols-1 sm:grid-cols-[220px_minmax(0,1fr)] gap-1 sm:gap-4 py-[10px] border-b border-border last:border-b-0">
              <dt className="font-medium">{what}</dt>
              <dd className="text-muted">{where}</dd>
            </div>
          ))}
        </dl>
      </Card>
      <Card title="Run history" note={`Tabi keeps the last ${MAX_RUNS} tasks so you can see what a background or scheduled task did. Older ones are dropped.`} bare>
        <div className="px-5 py-4 flex items-center gap-3 flex-wrap">
          <span className="flex items-center gap-2 text-muted"><Database size={14} aria-hidden />{runs === null ? '…' : `${runs} saved run${runs === 1 ? '' : 's'}`}</span>
          <div className="flex-1" />
          <button type="button" className="btn btn-secondary" onClick={() => send('OPEN_HISTORY', {})}><History size={14} aria-hidden />Open History</button>
          {confirming ? (
            <span className="flex items-center gap-[6px]">
              <span className="text-[12.5px]">Delete {runs} run{runs === 1 ? '' : 's'}? This can’t be undone.</span>
              <button type="button" className="btn btn-danger" onClick={deleteAll}>Delete</button>
              <button type="button" className="btn btn-quiet" onClick={() => setConfirming(false)}>Cancel</button>
            </span>
          ) : (
            <button type="button" className="btn btn-secondary" disabled={!runs} onClick={() => setConfirming(true)}><Trash2 size={14} aria-hidden />Delete all history</button>
          )}
        </div>
        {message && <div className="px-5 pb-4"><Notice kind="ok">{message}</Notice></div>}
      </Card>
    </>
  );
}

export function About() {
  const version = browser.runtime.getManifest().version;
  const link = (href: string, text: string) => (
    <a href={href} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-medium text-accent">{text}<ArrowUpRight size={12} aria-hidden /></a>
  );
  return (
    <>
      <PageHead title="About" />
      <Card bare>
        <div className="px-5 py-5 flex items-center gap-4">
          <div className="w-12 h-12 rounded-[10px] bg-accent grid place-items-center flex-none"><TabiMark size={28} color="#fff" label="" /></div>
          <div className="flex-1">
            <div className="font-semibold text-[16px]">Tabi <span className="font-mono text-[12px] text-muted font-normal">v{version}</span></div>
            <div className="text-muted">An open-source browser agent. Bring your own AI key. MIT licensed.</div>
          </div>
        </div>
        <div className="px-5 pb-5 flex flex-wrap gap-x-5 gap-y-2">
          {link('https://github.com/Adityatex/Tabi', 'Source on GitHub')}
          {link('https://github.com/Adityatex/Tabi#readme', 'Docs')}
          {link('https://github.com/Adityatex/Tabi/issues', 'Report a problem')}
        </div>
      </Card>
    </>
  );
}
