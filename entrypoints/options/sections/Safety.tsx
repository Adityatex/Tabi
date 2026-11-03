// Safety & sites: asking before what can't be undone, the safety check
// against hijacking, and the user's site lists (lib/agent/sites.ts): sites
// Tabi never acts on, and optionally the only ones it acts on without asking.
import { useEffect, useState } from 'react';
import { Ban, Globe, X } from 'lucide-react';
import { normalizeSite, type SiteRules } from '@/lib/agent/sites';
import { DEFAULT_PREFS, type AgentPrefs } from '@/lib/agent/prefs';
import { Card, Notice, PageHead, TextInput, ToggleRow, savePrefs, send } from '../ui';

type ListName = keyof SiteRules;

function SiteList({ list, sites, onRemove }: { list: ListName; sites: string[]; onRemove: (site: string) => void }) {
  return (
    <ul aria-label={list === 'blocked' ? 'Sites Tabi never acts on' : 'Sites Tabi may act on'} className="px-3 py-[6px]">
      {sites.map((site) => (
        <li key={site} className="flex items-center gap-3 px-2 py-[9px] border-b border-border last:border-b-0">
          {list === 'blocked' ? <Ban size={14} className="text-muted" aria-hidden /> : <Globe size={14} className="text-muted" aria-hidden />}
          <span className="flex-1 font-mono text-[12.5px]">{site}</span>
          <button type="button" aria-label={`Remove ${site}`} onClick={() => onRemove(site)} className="p-1 rounded-ctl text-muted hover:text-text"><X size={14} aria-hidden /></button>
        </li>
      ))}
    </ul>
  );
}

export default function Safety() {
  const [prefs, setPrefs] = useState<AgentPrefs>(DEFAULT_PREFS);
  const [rules, setRules] = useState<SiteRules>({ blocked: [], allowed: [] });
  const [drafts, setDrafts] = useState<Record<ListName, string>>({ blocked: '', allowed: '' });
  const [error, setError] = useState<{ list: ListName; text: string } | null>(null);
  /** The web page the user was on last (this page is a tab of its own), for one-click blocking. */
  const [current, setCurrent] = useState<string | null>(null);

  useEffect(() => {
    send<AgentPrefs>('GET_PREFS').then((res) => { if (res.success && res.data) setPrefs(res.data); });
    send<SiteRules>('GET_SITES').then((res) => { if (res.success && res.data) setRules(res.data); });
    browser.tabs.query({}).then((tabs) => {
      const last = tabs.filter((t) => /^https?:/.test(t.url ?? '')).sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0))[0];
      setCurrent(last?.url ? normalizeSite(last.url) : null);
    }).catch(() => {});
  }, []);

  const set = async <K extends keyof AgentPrefs>(key: K, value: AgentPrefs[K]) => {
    const before = prefs[key];
    setPrefs((p) => ({ ...p, [key]: value }));
    if (!await savePrefs({ [key]: value })) setPrefs((p) => ({ ...p, [key]: before }));
  };

  const save = async (list: ListName, change: { add?: string; remove?: string }) => {
    setError(null);
    const res = await send<SiteRules>('SAVE_SITES', { list, ...change });
    if (!res.success) {
      setError({ list, text: res.error ?? 'Couldn’t save it' });
      return false;
    }
    setRules(res.data!);
    return true;
  };
  const add = async (list: ListName) => {
    if (drafts[list].trim() && await save(list, { add: drafts[list] })) setDrafts((d) => ({ ...d, [list]: '' }));
  };

  const addRow = (list: ListName, placeholder: string, label: string, primary: boolean) => (
    <div className={`px-5 ${rules[list].length ? 'pt-[10px]' : 'pt-4'} pb-4 flex flex-col gap-2`}>
      <form className="flex gap-[6px]" onSubmit={(e) => { e.preventDefault(); add(list); }}>
        <TextInput mono value={drafts[list]} onChange={(e) => setDrafts((d) => ({ ...d, [list]: e.target.value }))} placeholder={placeholder} aria-label={label} className="flex-1 max-w-[360px]" />
        <button type="submit" className={`btn ${primary ? 'btn-primary' : 'btn-secondary'}`} disabled={!drafts[list].trim()}>Add</button>
      </form>
      {error?.list === list && <Notice kind="error">{error.text}</Notice>}
    </div>
  );

  const blockedHere = !!current && rules.blocked.includes(current);
  return (
    <>
      <PageHead title="Safety">Enforced by Tabi itself, not a model, so a page can’t talk its way past them.</PageHead>

      <Card bare>
        <ToggleRow
          title="Ask before buying, sending or deleting"
          note="Tabi stops and asks before placing an order, paying, sending a message or deleting. Saved workflows replay without asking."
          on={prefs.confirmRisky}
          onChange={(on) => set('confirmRisky', on)}
        >
          {!prefs.confirmRisky && (
            <Notice kind="warn"><b className="font-semibold">Tabi won’t ask first.</b> It can place orders, pay and send messages without checking with you, even when a page it reads tries to talk it into something.</Notice>
          )}
        </ToggleRow>
        <ToggleRow
          title="Safety check against hijacking"
          note="Pages can hide instructions for AI agents. Before a risky step, a second model that never sees the page checks it still fits your task."
          on={prefs.critic}
          onChange={(on) => set('critic', on)}
        >
          {!prefs.critic && (
            <Notice kind="warn"><b className="font-semibold">Hidden instructions won’t be caught.</b> A malicious page could steer Tabi toward steps you didn’t ask for.</Notice>
          )}
        </ToggleRow>
      </Card>

      <Card
        title="Never act on"
        note="Tabi won’t open, read or act on these sites or their subdomains."
        right={current && !blockedHere ? (
          <button type="button" className="btn btn-sm btn-secondary h-[30px]" onClick={() => save('blocked', { add: current })}><Ban size={13} aria-hidden />Block {current}</button>
        ) : undefined}
        bare
        testId="blocked-sites"
      >
        {rules.blocked.length > 0 && <SiteList list="blocked" sites={rules.blocked} onRemove={(site) => save('blocked', { remove: site })} />}
        {addRow('blocked', 'site.com', 'Site to never act on', true)}
      </Card>

      <Card title={<>Only act on <span className="font-normal text-muted">(optional)</span></>} note="Tabi asks before using any site not on this list." bare testId="allowed-sites">
        {rules.allowed.length > 0
          ? <SiteList list="allowed" sites={rules.allowed} onRemove={(site) => save('allowed', { remove: site })} />
          : null}
        {addRow('allowed', 'shop.example.com', 'Site Tabi may act on', false)}
      </Card>
    </>
  );
}
