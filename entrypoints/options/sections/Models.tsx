// Models & keys: the main provider (provider, model, masked key with Test and
// Replace), backup providers in order (drag to reorder), and the optional fast
// model for routine steps. Keys stay in the background worker; this page only
// ever sees them masked.
import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Check, CircleCheck, CircleX, Ellipsis, Eye, EyeOff, GripVertical, KeyRound, Link, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { PROVIDERS, PROVIDER_IDS, type ProviderId } from '@/lib/api/providers';
import { USAGE_URL } from '@/lib/api/chatgptAuth';
import type { ModelInfo } from '@/lib/api/llmClient';
import ChatGPTButton from '@/components/ChatGPTButton';
import ProviderIcon from '@/components/ProviderIcon';
import { Card, Field, ModelInput, Notice, PageHead, Select, TextInput, Toggle, send } from '../ui';

interface Settings {
  provider: ProviderId;
  models: Partial<Record<ProviderId, string>>;
  customBaseUrl: string;
  maskedKeys: Partial<Record<ProviderId, string>>;
  fallbacks: ProviderId[];
  ready: ProviderId[];
  executor: { provider: ProviderId; model: string } | null;
  /** Who is signed in with ChatGPT. */
  chatgpt: { email: string; planUsage: boolean } | null;
}

const free = (id: ProviderId) => /free/i.test(PROVIDERS[id].note ?? '') || id === 'ollama';

type SignIn = { state: 'idle' } | { state: 'waiting' } | { state: 'done'; email: string; planUsage: boolean } | { state: 'error'; message: string };

/**
 * Sign in with ChatGPT, in place of an API key: "Continue with ChatGPT" opens
 * OpenAI's sign-in in a window; this waits for the background to finish it.
 * Wording follows OpenAI's guidelines (developers.openai.com/siwc/ui-ux-guidelines).
 */
function ChatGPTSignIn({ account, onSignedIn, onSignedOut }: {
  account: Settings['chatgpt']; onSignedIn: () => void; onSignedOut: () => void;
}) {
  const [status, setStatus] = useState<SignIn>({ state: 'idle' });
  const [welcome, setWelcome] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);

  // While the sign-in window is open, see how it's going
  useEffect(() => {
    if (status.state !== 'waiting') return;
    const timer = setInterval(async () => {
      const res = await send<SignIn>('CHATGPT_STATUS');
      if (!res.success || !res.data || res.data.state === 'waiting') return;
      setStatus(res.data);
      if (res.data.state === 'done') {
        setWelcome(true);
        onSignedIn();
      }
    }, 800);
    return () => clearInterval(timer);
  }, [status.state]); // eslint-disable-line react-hooks/exhaustive-deps

  const start = async (fresh = false) => {
    setNote(null);
    const res = await send('CHATGPT_SIGN_IN', { fresh });
    setStatus(res.success ? { state: 'waiting' } : { state: 'error', message: res.error ?? 'Couldn’t open the sign-in' });
  };
  const leave = async () => {
    const res = await send<{ revoked: boolean }>('CHATGPT_SIGN_OUT');
    setStatus({ state: 'idle' });
    setWelcome(false);
    setNote(res.data?.revoked === false
      ? { ok: false, text: 'Signed out here, but ChatGPT couldn’t be told. To be sure, disconnect Tabi in ChatGPT’s settings.' }
      : { ok: true, text: 'Signed out of ChatGPT.' });
    onSignedOut();
  };

  if (account) {
    return (
      <div className="sm:col-span-2 flex flex-col gap-3" data-testid="chatgpt-account">
        {welcome && account.planUsage && (
          <div role="dialog" aria-label="You're using your ChatGPT plan" className="rounded-card border border-border bg-raised p-4 flex flex-col gap-2">
            <div className="font-semibold text-[14px]">You’re using your ChatGPT plan</div>
            <p className="text-[12.5px] text-muted [text-wrap:pretty]">Tabi’s requests now count toward your ChatGPT plan’s usage, not an API key. You can see and manage that usage in ChatGPT’s settings.</p>
            <div className="flex gap-2">
              <button type="button" className="btn btn-primary h-8" onClick={() => setWelcome(false)}>Got it</button>
              <a href={USAGE_URL} target="_blank" rel="noreferrer" className="btn btn-quiet h-8">Manage usage</a>
            </div>
          </div>
        )}
        <div className="flex items-center gap-3 flex-wrap">
          <span className="flex-1 min-w-[220px] flex flex-col">
            <span className="text-[13px]">Signed in as <span className="font-medium">{account.email}</span></span>
            <span className={`text-[12px] ${account.planUsage ? 'text-green' : 'text-amber'}`}>{account.planUsage ? 'Using ChatGPT plan' : 'Plan usage isn’t available for this account'}</span>
          </span>
          <a href={USAGE_URL} target="_blank" rel="noreferrer" className="btn btn-secondary h-[34px]">Manage usage</a>
          <button type="button" className="btn btn-quiet h-[34px]" onClick={leave}>Sign out</button>
        </div>
        {!account.planUsage && (
          <Notice kind="warn">This account can sign in, but its plan can’t be used in other apps. OpenAI decides which plans and workspaces allow it. Choose another provider, or sign in with another account.</Notice>
        )}
        {!account.planUsage && <button type="button" className="text-[12px] font-medium text-accent self-start" onClick={() => start(true)}>Use another account</button>}
      </div>
    );
  }
  return (
    <div className="sm:col-span-2 flex flex-col gap-[10px]" data-testid="chatgpt-sign-in">
      <div>
        <div className="font-semibold text-[13.5px]">Use your ChatGPT plan</div>
        <p className="text-[12px] text-muted mt-[2px] max-w-[560px] [text-wrap:pretty]">Instead of an API key, with a paid ChatGPT plan. Tabi’s requests count toward the plan’s usage.</p>
      </div>
      <div className="flex items-center gap-3 flex-wrap">
        <ChatGPTButton onClick={() => start()} disabled={status.state === 'waiting'} />
        {status.state === 'waiting' && <span className="text-[12px] text-muted" role="status">Finish signing in in the window that opened.</span>}
      </div>
      {status.state === 'error' && <Notice kind="error">{status.message}</Notice>}
      {note && <Notice kind={note.ok ? 'ok' : 'error'}>{note.text}</Notice>}
    </div>
  );
}

/** Edit one provider: as the main one, or as a backup. */
function ProviderEditor({ settings, initial, mode, exclude = [], onSaved, onCancel, onTested, onAccount }: {
  settings: Settings; initial: ProviderId; mode: 'main' | 'backup'; exclude?: ProviderId[];
  onSaved: () => void; onCancel?: () => void; onTested?: (ok: boolean) => void;
  /** Signed in or out with ChatGPT: load the settings again. */
  onAccount: () => void;
}) {
  const [provider, setProvider] = useState<ProviderId>(initial);
  const savedModel = settings.models[provider] || PROVIDERS[provider].defaultModel || '';
  const [model, setModel] = useState(savedModel);
  const [key, setKey] = useState('');
  const [replacing, setReplacing] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [url, setUrl] = useState(settings.customBaseUrl);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [listError, setListError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const preset = PROVIDERS[provider];
  const masked = settings.maskedKeys[provider];
  const editingKey = !masked || replacing;
  const needsKey = preset.needsKey || provider === 'custom';

  useEffect(() => { setProvider(initial); }, [initial]);
  // Another provider: start its form afresh
  useEffect(() => {
    setModel(settings.models[provider] || PROVIDERS[provider].defaultModel || '');
    setKey('');
    setReplacing(false);
    setModels([]);
    setListError(null);
    setResult(null);
  }, [provider]); // eslint-disable-line react-hooks/exhaustive-deps
  // Saved settings came back: the typed key is now the saved one; what the save said stays
  useEffect(() => {
    setKey('');
    setReplacing(false);
  }, [settings]);

  const dirty = provider !== initial || model.trim() !== savedModel || !!key.trim() || (provider === 'custom' && url !== settings.customBaseUrl) || mode === 'backup' && !settings.fallbacks.includes(provider);

  /** List the models the key can use: tests the key too. `quiet`: only the list, for the model dropdown. */
  const test = async (quiet = false) => {
    setBusy('Testing');
    setListError(null);
    if (!quiet) setResult(null);
    const started = Date.now();
    const res = await send<{ models: ModelInfo[] }>('LIST_MODELS', { provider, apiKey: key.trim(), customBaseUrl: url.trim() });
    setBusy(null);
    if (quiet) {
      if (res.success) setModels(res.data?.models ?? []);
      else setListError(res.error ?? 'Couldn’t list the models');
      return;
    }
    if (!res.success) {
      setResult({ ok: false, text: res.error ?? 'It didn’t work' });
      onTested?.(false);
      return;
    }
    const list = res.data?.models ?? [];
    setModels(list);
    const freeCount = list.filter((m) => m.free).length;
    // Signed in: start with the first model the plan offers
    if (preset.signIn) {
      if (!model.trim() && list[0]) setModel(list[0].id);
      setResult({ ok: true, text: `Signed in · ${list.length} models on your plan` });
      onTested?.(true);
      return;
    }
    setResult({ ok: true, text: `Key works · answered in ${((Date.now() - started) / 1000).toFixed(1)}s · ${list.length} models${freeCount ? `, ${freeCount} free` : ''}` });
    onTested?.(true);
  };

  const save = async () => {
    if (preset.signIn && !settings.chatgpt) return setResult({ ok: false, text: 'Continue with ChatGPT first.' });
    if (needsKey && preset.needsKey && !key.trim() && !masked) return setResult({ ok: false, text: `Paste your ${preset.label} API key first.` });
    if (!model.trim()) return setResult({ ok: false, text: 'Choose a model. The reload button lists what your key can use.' });
    setBusy('Saving');
    const res = await send<{ fallbacks: ProviderId[] }>('SAVE_LLM_SETTINGS', {
      provider, model: model.trim(), apiKey: key.trim(), customBaseUrl: url.trim(), asBackup: mode === 'backup',
    });
    setBusy(null);
    if (!res.success) return setResult({ ok: false, text: res.error ?? 'Couldn’t save it' });
    setResult({ ok: true, text: mode === 'backup' ? `Saved as backup #${(res.data?.fallbacks ?? []).indexOf(provider) + 1}.` : `Saved. Tabi now uses ${preset.label} · ${model.trim()}.` });
    onSaved();
  };

  const options = PROVIDER_IDS.filter((id) => id === provider || !exclude.includes(id));
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-5 gap-y-4">
      <Field label="Provider">
        <Select value={provider} onChange={(v) => setProvider(v as ProviderId)} label="Provider" options={options.map((id) => ({ value: id, label: PROVIDERS[id].label, hint: free(id) ? 'Free tier' : undefined, icon: <ProviderIcon id={id} /> }))} />
      </Field>
      <Field label="Model">
        <span className="flex gap-[6px]">
          <ModelInput
            value={model}
            onChange={setModel}
            models={models}
            loading={busy === 'Testing'}
            error={listError}
            onOpen={() => test(true)}
            placeholder={preset.defaultModel ?? 'Model id'}
            className="flex-1"
          />
          <button type="button" title="Reload model list" aria-label="Reload model list" onClick={() => test()} className="w-[34px] h-[34px] grid place-items-center rounded-ctl border border-border-strong text-muted flex-none hover:text-text">
            <RefreshCw size={14} className={busy === 'Testing' ? 'animate-spin' : ''} aria-hidden />
          </button>
        </span>
      </Field>
      {provider === 'custom' && (
        <Field label="Server URL" className="sm:col-span-2">
          <TextInput icon={Link} mono value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://host/v1" />
        </Field>
      )}
      {preset.signIn && (
        <ChatGPTSignIn account={settings.chatgpt} onSignedIn={() => { onAccount(); test(); }} onSignedOut={onAccount} />
      )}
      {needsKey && (
        <div className="sm:col-span-2 flex flex-col gap-[6px]">
          <span className="text-[12px] font-medium">API key{preset.needsKey ? '' : ' (optional)'}</span>
          <div className="flex gap-[6px] flex-wrap">
            {editingKey ? (
              <span className="relative flex-1 min-w-[220px] flex">
                <TextInput
                  icon={KeyRound}
                  mono
                  type={showKey ? 'text' : 'password'}
                  value={key}
                  onChange={(e) => setKey(e.target.value)}
                  placeholder={masked ? 'Paste the new key' : `Paste your ${preset.label} key`}
                  aria-label="API key"
                  autoComplete="off"
                  spellCheck={false}
                  className="flex-1"
                />
                <button type="button" onClick={() => setShowKey((s) => !s)} aria-label={showKey ? 'Hide key' : 'Show key'} className="absolute right-2 top-1/2 -translate-y-1/2 text-muted p-1">
                  {showKey ? <EyeOff size={14} aria-hidden /> : <Eye size={14} aria-hidden />}
                </button>
              </span>
            ) : (
              <span className="flex-1 min-w-[220px] h-[34px] flex items-center gap-2 px-[10px] rounded-ctl border border-border-strong bg-raised" aria-label="Saved API key">
                <KeyRound size={13} className="text-muted" aria-hidden />
                <span className="flex-1 font-mono text-[12px] truncate">{masked}</span>
              </span>
            )}
            <button type="button" className="btn btn-secondary h-[34px]" onClick={() => test()} disabled={!!busy || (editingKey && !key.trim() && !masked)}>Test</button>
            {masked && !replacing && <button type="button" className="btn btn-quiet h-[34px]" onClick={() => setReplacing(true)}>Replace</button>}
            {replacing && <button type="button" className="btn btn-quiet h-[34px]" onClick={() => { setReplacing(false); setKey(''); }}>Keep the saved key</button>}
          </div>
          {preset.keyUrl && !masked && <a href={preset.keyUrl} target="_blank" rel="noreferrer" className="text-[12px] font-medium text-accent self-start">Get a key at {new URL(preset.keyUrl).host}</a>}
        </div>
      )}
      {preset.note && !preset.signIn && <p className="sm:col-span-2 text-[12px] text-muted max-w-[640px]">{preset.note}</p>}
      {result && <div className="sm:col-span-2"><Notice kind={result.ok ? 'ok' : 'error'}>{result.text}</Notice></div>}
      {(dirty || onCancel) && (
        <div className="sm:col-span-2 flex gap-[6px]">
          <button type="button" className="btn btn-primary" onClick={save} disabled={!!busy}>{busy === 'Saving' ? 'Saving…' : mode === 'backup' ? 'Save as backup' : provider !== initial ? 'Use as main provider' : 'Save changes'}</button>
          <button type="button" className="btn btn-quiet" onClick={() => { if (onCancel) onCancel(); else { setProvider(initial); setModel(savedModel); setKey(''); setReplacing(false); setResult(null); } }}>Cancel</button>
        </div>
      )}
    </div>
  );
}

/** A backup's row: drag it, or use its menu, to change the order. */
function BackupRow({ id, index, count, settings, onMove, onRemove, dragging, onDragStart, onDragEnter, onDragEnd }: {
  id: ProviderId; index: number; count: number; settings: Settings;
  onMove: (to: number) => void; onRemove: () => void; dragging: boolean;
  onDragStart: () => void; onDragEnter: () => void; onDragEnd: () => void;
}) {
  const [menu, setMenu] = useState(false);
  const ready = settings.ready.includes(id);
  const model = settings.models[id] || PROVIDERS[id].defaultModel || '';
  return (
    <li
      draggable
      onDragStart={(e) => { e.dataTransfer.effectAllowed = 'move'; onDragStart(); }}
      onDragEnter={onDragEnter}
      onDragOver={(e) => e.preventDefault()}
      onDragEnd={onDragEnd}
      className={`relative flex items-center gap-3 px-2 py-[10px] border-b border-border last:border-b-0 ${dragging ? 'bg-bg rounded-ctl shadow-[0_6px_18px_rgba(0,0,0,.1)] outline outline-1 outline-accent' : ''}`}
    >
      <GripVertical size={15} className={`flex-none ${dragging ? 'text-accent cursor-grabbing' : 'text-muted cursor-grab'}`} aria-hidden />
      <span className="font-mono text-[12px] text-muted w-[14px]">{index + 1}</span>
      <ProviderIcon id={id} size={16} />
      <div className="flex-1 min-w-0">
        <div className="font-medium">{PROVIDERS[id].label}</div>
        <div className="font-mono text-[11.5px] text-muted truncate">{[model, settings.maskedKeys[id]].filter(Boolean).join(' · ')}</div>
      </div>
      {ready
        ? <span className="flex items-center gap-1 text-[12px] text-green"><CircleCheck size={13} aria-hidden />Ready</span>
        : <span className="flex items-center gap-1 text-[12px] text-red"><CircleX size={13} aria-hidden />{PROVIDERS[id].signIn && !settings.chatgpt ? 'Not signed in' : 'No key or model'}</span>}
      <button type="button" aria-label={`More for ${PROVIDERS[id].label}`} aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu((m) => !m)} className="p-1 rounded-ctl text-muted hover:text-text">
        <Ellipsis size={15} aria-hidden />
      </button>
      {menu && (
        <div role="menu" className="absolute right-2 top-full z-10 bg-raised border border-border rounded-card shadow-pop p-1 w-[160px]" onKeyDown={(e) => e.key === 'Escape' && setMenu(false)}>
          <button type="button" role="menuitem" autoFocus disabled={index === 0} onClick={() => { setMenu(false); onMove(index - 1); }} className="w-full flex items-center gap-2 p-2 rounded-ctl text-left hover:bg-surface disabled:opacity-40"><ArrowUp size={13} aria-hidden />Move up</button>
          <button type="button" role="menuitem" disabled={index === count - 1} onClick={() => { setMenu(false); onMove(index + 1); }} className="w-full flex items-center gap-2 p-2 rounded-ctl text-left hover:bg-surface disabled:opacity-40"><ArrowDown size={13} aria-hidden />Move down</button>
          <button type="button" role="menuitem" onClick={() => { setMenu(false); onRemove(); }} className="w-full flex items-center gap-2 p-2 rounded-ctl text-left hover:bg-surface text-red"><Trash2 size={13} aria-hidden />Remove</button>
        </div>
      )}
    </li>
  );
}

export default function Models() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [tested, setTested] = useState<boolean | null>(null);
  const [adding, setAdding] = useState(false);
  const [order, setOrder] = useState<ProviderId[]>([]);
  const [drag, setDrag] = useState<number | null>(null);
  const [fast, setFast] = useState<{ provider: ProviderId | ''; model: string; on: boolean }>({ provider: '', model: '', on: false });
  const [fastResult, setFastResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [fastModels, setFastModels] = useState<{ provider: ProviderId | ''; list: ModelInfo[]; loading: boolean; error: string | null }>({ provider: '', list: [], loading: false, error: null });
  /** The fast provider's models, with its saved key. */
  const listFast = async (provider: ProviderId) => {
    setFastModels({ provider, list: [], loading: true, error: null });
    const res = await send<{ models: ModelInfo[] }>('LIST_MODELS', { provider, apiKey: '', customBaseUrl: settings?.customBaseUrl ?? '' });
    setFastModels({ provider, list: res.data?.models ?? [], loading: false, error: res.success ? null : res.error ?? 'Couldn’t list the models' });
  };
  const orderRef = useRef<ProviderId[]>([]);

  const load = useCallback(async () => {
    const res = await send<Settings>('GET_LLM_SETTINGS');
    if (!res.success || !res.data) return;
    setSettings(res.data);
    setOrder(res.data.fallbacks);
    orderRef.current = res.data.fallbacks;
    setFast({ provider: res.data.executor?.provider ?? '', model: res.data.executor?.model ?? '', on: !!res.data.executor });
  }, []);
  useEffect(() => { load(); }, [load]);

  const saveOrder = async (next: ProviderId[]) => {
    setOrder(next);
    orderRef.current = next;
    const res = await send<{ fallbacks: ProviderId[] }>('SAVE_FALLBACKS', { fallbacks: next });
    if (res.success) await load();
  };
  const move = (from: number, to: number) => {
    const next = [...orderRef.current];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item);
    return next;
  };

  const saveFast = async (provider: ProviderId | '', model: string) => {
    const res = await send('SAVE_EXECUTOR', { executor: provider ? { provider, model: model.trim() } : null });
    setFastResult(res.success
      ? { ok: true, text: provider ? `Routine steps now go to ${PROVIDERS[provider].label} · ${model.trim()}.` : 'Off: your main model takes every step.' }
      : { ok: false, text: res.error ?? 'Couldn’t save it' });
    if (res.success) load();
  };

  if (!settings) return <PageHead title="Models & keys" />;
  const main = settings.provider;
  const mainReady = settings.ready.includes(main);
  const pill = tested === true
    ? <span className="flex items-center gap-[5px] h-[22px] px-2 rounded-full bg-green-bg text-green text-[11.5px] font-semibold"><Check size={12} aria-hidden />Working</span>
    : tested === false
      ? <span className="flex items-center gap-[5px] h-[22px] px-2 rounded-full bg-red-bg text-red text-[11.5px] font-semibold"><CircleX size={12} aria-hidden />Not working</span>
      : <span className="flex items-center gap-[5px] h-[22px] px-2 rounded-full border border-border text-muted text-[11.5px] font-semibold">{mainReady ? 'Saved' : 'Not set up'}</span>;
  const unused = PROVIDER_IDS.filter((id) => id !== main && !order.includes(id));

  return (
    <>
      <PageHead title="Models & keys">Your own API keys, or your ChatGPT plan. Kept only in this browser.</PageHead>

      <Card title="Main provider" note="Plans the task and decides each step." right={pill}>
        <ProviderEditor settings={settings} initial={main} mode="main" exclude={[]} onSaved={load} onTested={setTested} onAccount={load} />
      </Card>

      <Card title="Backup providers" note="If your main provider hits a rate limit, the next one takes over mid-task. Drag to reorder." bare testId="backups">
        <div className="px-3 py-2">
          {order.length > 0 && (
            <ol aria-label="Backup providers">
              {order.map((id, i) => (
                <BackupRow
                  key={id}
                  id={id}
                  index={i}
                  count={order.length}
                  settings={settings}
                  dragging={drag === i}
                  onDragStart={() => setDrag(i)}
                  onDragEnter={() => { if (drag !== null && drag !== i) { setOrder(move(drag, i)); orderRef.current = move(drag, i); setDrag(i); } }}
                  onDragEnd={() => { setDrag(null); saveOrder(orderRef.current); }}
                  onMove={(to) => saveOrder(move(i, to))}
                  onRemove={() => saveOrder(order.filter((x) => x !== id))}
                />
              ))}
            </ol>
          )}
          {adding ? (
            <div className="px-2 py-3 border-t border-border first:border-t-0">
              <ProviderEditor settings={settings} initial={unused[0] ?? 'gemini'} mode="backup" exclude={[main, ...order]} onSaved={() => { setAdding(false); load(); }} onCancel={() => setAdding(false)} onAccount={load} />
            </div>
          ) : unused.length > 0 && (
            <button type="button" onClick={() => setAdding(true)} className="flex items-center gap-[6px] px-2 pt-[10px] pb-[6px] text-accent font-medium">
              <Plus size={14} aria-hidden />Add a backup
            </button>
          )}
        </div>
      </Card>

      <Card bare>
        <div className="px-5 py-4 flex flex-col gap-[14px]">
          <div className="flex gap-4 items-start">
            <div className="flex-1">
              <div className="font-semibold text-[14px]">Fast model for routine steps</div>
              <div className="text-[12px] text-muted mt-[2px] max-w-[560px] [text-wrap:pretty]">A quicker, cheaper model for simple steps like typing into a field. Your main model still plans and checks.</div>
            </div>
            <Toggle
              on={fast.on}
              label="Fast model for routine steps"
              onChange={(on) => {
                setFast((f) => ({ ...f, on }));
                if (!on) saveFast('', '');
              }}
            />
          </div>
          {fast.on && (
            <div className="flex gap-2 items-end flex-wrap">
              <Field label="Provider" className="w-[220px]">
                <Select value={fast.provider} onChange={(v) => setFast((f) => ({ ...f, provider: v as ProviderId }))} label="Fast model provider" options={settings.ready.map((id) => ({ value: id, label: PROVIDERS[id].label, icon: <ProviderIcon id={id} /> }))} />
              </Field>
              <Field label="Fast model" className="flex-1 min-w-[200px] max-w-[360px]">
                <ModelInput
                  label="Fast model"
                  value={fast.model}
                  onChange={(model) => setFast((f) => ({ ...f, model }))}
                  models={fastModels.provider === fast.provider ? fastModels.list : []}
                  loading={fastModels.provider === fast.provider && fastModels.loading}
                  error={fastModels.provider === fast.provider ? fastModels.error : null}
                  onOpen={() => { if (fast.provider) listFast(fast.provider); }}
                  placeholder="e.g. llama-3.1-8b-instant"
                />
              </Field>
              <button type="button" className="btn btn-secondary h-[34px]" disabled={!fast.provider || !fast.model.trim()} onClick={() => saveFast(fast.provider, fast.model)}>Save</button>
            </div>
          )}
          {fast.on && settings.ready.length === 0 && <Notice kind="info">Save a provider with a key first; then it can take routine steps.</Notice>}
          {fastResult && <Notice kind={fastResult.ok ? 'ok' : 'error'}>{fastResult.text}</Notice>}
        </div>
      </Card>
    </>
  );
}
