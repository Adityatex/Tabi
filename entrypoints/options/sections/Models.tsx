// Models & keys: the main provider (provider, model, masked key with Test and
// Replace), backup providers in order (drag to reorder), and the optional fast
// model for routine steps. Keys stay in the background worker; this page only
// ever sees them masked.
import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Check, CircleCheck, CircleX, Ellipsis, Eye, EyeOff, GripVertical, KeyRound, Link, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { PROVIDERS, PROVIDER_IDS, type ProviderId } from '@/lib/api/providers';
import type { ModelInfo } from '@/lib/api/llmClient';
import { Card, Field, Notice, PageHead, Select, TextInput, Toggle, send } from '../ui';

interface Settings {
  provider: ProviderId;
  models: Partial<Record<ProviderId, string>>;
  customBaseUrl: string;
  maskedKeys: Partial<Record<ProviderId, string>>;
  fallbacks: ProviderId[];
  ready: ProviderId[];
  executor: { provider: ProviderId; model: string } | null;
}

const free = (id: ProviderId) => /free/i.test(PROVIDERS[id].note ?? '') || id === 'ollama';

/** Edit one provider: as the main one, or as a backup. */
function ProviderEditor({ settings, initial, mode, exclude = [], onSaved, onCancel, onTested }: {
  settings: Settings; initial: ProviderId; mode: 'main' | 'backup'; exclude?: ProviderId[];
  onSaved: () => void; onCancel?: () => void; onTested?: (ok: boolean) => void;
}) {
  const [provider, setProvider] = useState<ProviderId>(initial);
  const savedModel = settings.models[provider] || PROVIDERS[provider].defaultModel || '';
  const [model, setModel] = useState(savedModel);
  const [key, setKey] = useState('');
  const [replacing, setReplacing] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [url, setUrl] = useState(settings.customBaseUrl);
  const [models, setModels] = useState<ModelInfo[]>([]);
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
    setResult(null);
  }, [provider]); // eslint-disable-line react-hooks/exhaustive-deps
  // Saved settings came back: the typed key is now the saved one; what the save said stays
  useEffect(() => {
    setKey('');
    setReplacing(false);
  }, [settings]);

  const dirty = provider !== initial || model.trim() !== savedModel || !!key.trim() || (provider === 'custom' && url !== settings.customBaseUrl) || mode === 'backup' && !settings.fallbacks.includes(provider);

  /** List the models the key can use: tests the key too. */
  const test = async () => {
    setBusy('Testing');
    setResult(null);
    const started = Date.now();
    const res = await send<{ models: ModelInfo[] }>('LIST_MODELS', { provider, apiKey: key.trim(), customBaseUrl: url.trim() });
    setBusy(null);
    if (!res.success) {
      setResult({ ok: false, text: res.error ?? 'It didn’t work' });
      onTested?.(false);
      return;
    }
    const list = res.data?.models ?? [];
    setModels(list);
    const freeCount = list.filter((m) => m.free).length;
    setResult({ ok: true, text: `Key works · answered in ${((Date.now() - started) / 1000).toFixed(1)}s · ${list.length} models${freeCount ? `, ${freeCount} free` : ''}` });
    onTested?.(true);
  };

  const save = async () => {
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
        <Select value={provider} onChange={(v) => setProvider(v as ProviderId)} label="Provider">
          {options.map((id) => <option key={id} value={id}>{PROVIDERS[id].label}{free(id) ? ' · free tier' : ''}</option>)}
        </Select>
      </Field>
      <Field label="Model">
        <span className="flex gap-[6px]">
          <TextInput mono list={`models-${mode}`} value={model} onChange={(e) => setModel(e.target.value)} placeholder={preset.defaultModel ?? 'Model id'} aria-label="Model" className="flex-1" />
          <datalist id={`models-${mode}`}>
            {models.map((m) => <option key={m.id} value={m.id} label={[m.free && 'free', m.mayTrain && 'may train on your data'].filter(Boolean).join(' · ') || undefined} />)}
          </datalist>
          <button type="button" title="Reload model list" aria-label="Reload model list" onClick={test} className="w-[34px] h-[34px] grid place-items-center rounded-ctl border border-border-strong text-muted flex-none hover:text-text">
            <RefreshCw size={14} className={busy === 'Testing' ? 'animate-spin' : ''} aria-hidden />
          </button>
        </span>
      </Field>
      {provider === 'custom' && (
        <Field label="Server URL" className="sm:col-span-2">
          <TextInput icon={Link} mono value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://host/v1" />
        </Field>
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
            <button type="button" className="btn btn-secondary h-[34px]" onClick={test} disabled={!!busy || (editingKey && !key.trim() && !masked)}>Test</button>
            {masked && !replacing && <button type="button" className="btn btn-quiet h-[34px]" onClick={() => setReplacing(true)}>Replace</button>}
            {replacing && <button type="button" className="btn btn-quiet h-[34px]" onClick={() => { setReplacing(false); setKey(''); }}>Keep the saved key</button>}
          </div>
          {preset.keyUrl && !masked && <a href={preset.keyUrl} target="_blank" rel="noreferrer" className="text-[12px] font-medium text-accent self-start">Get a key at {new URL(preset.keyUrl).host}</a>}
        </div>
      )}
      {preset.note && <p className="sm:col-span-2 text-[12px] text-muted max-w-[640px]">{preset.note}</p>}
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
      <div className="flex-1 min-w-0">
        <div className="font-medium">{PROVIDERS[id].label}</div>
        <div className="font-mono text-[11.5px] text-muted truncate">{[model, settings.maskedKeys[id]].filter(Boolean).join(' · ')}</div>
      </div>
      {ready
        ? <span className="flex items-center gap-1 text-[12px] text-green"><CircleCheck size={13} aria-hidden />Ready</span>
        : <span className="flex items-center gap-1 text-[12px] text-red"><CircleX size={13} aria-hidden />No key or model</span>}
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
      <PageHead title="Models & keys">Tabi uses your own API keys. They’re stored only in this browser and sent only to the provider you pick.</PageHead>

      <Card title="Main provider" note="Plans the task and decides each step." right={pill}>
        <ProviderEditor settings={settings} initial={main} mode="main" exclude={[]} onSaved={load} onTested={setTested} />
      </Card>

      <Card title="Backup providers" note="If your main provider hits a rate limit, the next one takes over mid-task, with the same plan and progress. Drag to change the order." bare testId="backups">
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
              <ProviderEditor settings={settings} initial={unused[0] ?? 'gemini'} mode="backup" exclude={[main, ...order]} onSaved={() => { setAdding(false); load(); }} onCancel={() => setAdding(false)} />
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
              <div className="text-[12px] text-muted mt-[2px] max-w-[560px] [text-wrap:pretty]">A quick, cheap model handles simple steps like typing into a field. Your main model still plans and checks the result. Saves calls on free tiers, and a smaller model on the same provider often has a quota of its own.</div>
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
                <Select value={fast.provider} onChange={(v) => setFast((f) => ({ ...f, provider: v as ProviderId }))} label="Fast model provider">
                  <option value="">Choose…</option>
                  {settings.ready.map((id) => <option key={id} value={id}>{PROVIDERS[id].label}</option>)}
                </Select>
              </Field>
              <Field label="Fast model" className="flex-1 min-w-[200px] max-w-[360px]">
                <TextInput mono value={fast.model} onChange={(e) => setFast((f) => ({ ...f, model: e.target.value }))} placeholder="e.g. llama-3.1-8b-instant" />
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
