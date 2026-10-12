// First run, before any provider is set up: choose one, paste its key, test
// it. Three steps in the panel; everything else is in Settings.
import { useState } from 'react';
import { ArrowUpRight, Check, KeyRound, LoaderCircle, Settings, X } from 'lucide-react';
import { PROVIDERS, type ProviderId } from '@/lib/api/providers';
import { send } from '../hooks';

const CHOICES: { id: ProviderId; name: string; hint: string; suggested?: boolean }[] = [
  { id: 'groq', name: 'Groq', hint: 'Free tier · very fast', suggested: true },
  { id: 'gemini', name: 'Google Gemini', hint: 'Free tier · sees screenshots' },
  { id: 'ollama', name: 'Ollama', hint: 'Runs on your computer · no key' },
];

/** The model to start with: the provider's default if the key can use it, else a sensible one from its list. */
function pickModel(provider: ProviderId, models: string[]): string | undefined {
  const preset = PROVIDERS[provider];
  if (preset.defaultModel && models.includes(preset.defaultModel)) return preset.defaultModel;
  return models.find((m) => /flash-lite/.test(m)) ?? preset.defaultModel ?? models[0];
}

interface Props {
  onOpenSettings: () => void;
  /** Called once the key works and is saved. */
  onReady: () => void;
}

function Num({ n, done }: { n: number; done: boolean }) {
  return (
    <span className={`w-[22px] h-[22px] rounded-full grid place-items-center text-[11.5px] font-semibold flex-none ${done ? 'bg-green-bg text-green' : 'bg-accent-soft text-accent'}`}>
      {done ? <Check size={12} aria-label="Done" /> : n}
    </span>
  );
}

export default function Setup({ onOpenSettings, onReady }: Props) {
  const [provider, setProvider] = useState<ProviderId>('groq');
  const [key, setKey] = useState('');
  const [state, setState] = useState<{ testing?: boolean; ok?: string; error?: string }>({});
  const preset = PROVIDERS[provider];
  const needsKey = preset.needsKey;
  const name = CHOICES.find((c) => c.id === provider)?.name ?? preset.label;

  const test = async () => {
    setState({ testing: true });
    const started = Date.now();
    const listed = await send<{ models: { id: string }[] }>('LIST_MODELS', { provider, apiKey: key.trim() });
    if (!listed.success) return setState({ error: listed.error ?? 'It didn’t work' });
    const models = (listed.data?.models ?? []).map((m) => m.id);
    const model = pickModel(provider, models);
    if (!model) return setState({ error: `${name} has no models this key can use.` });
    const saved = await send('SAVE_LLM_SETTINGS', { provider, model, apiKey: key.trim() });
    if (!saved.success) return setState({ error: saved.error ?? 'Couldn’t save it' });
    setState({ ok: `Key works · answered in ${((Date.now() - started) / 1000).toFixed(1)}s · using ${model.replace(/^[^/]+\//, '')}` });
    setTimeout(onReady, 900);
  };

  return (
    <div className="flex-1 min-h-0 overflow-y-auto scroll-thin pt-[18px] px-[14px] pb-[10px] flex flex-col gap-4" data-testid="setup">
      <div>
        <h1 className="text-[18px] font-semibold tracking-[-0.02em]">Set up Tabi</h1>
        <p className="text-muted mt-1 leading-[1.5]">Tabi runs on your own AI key, stored only on this device. Three steps, about a minute.</p>
      </div>

      <section className="flex gap-3">
        <Num n={1} done={!!state.ok} />
        <div className="flex-1 min-w-0">
          <h2 className="font-semibold">Choose a provider</h2>
          <div role="radiogroup" aria-label="Provider" className="flex flex-col gap-[6px] mt-2">
            {CHOICES.map((c) => (
              <button
                key={c.id}
                type="button"
                role="radio"
                aria-checked={provider === c.id}
                onClick={() => { setProvider(c.id); setState({}); }}
                className={`flex items-center gap-[10px] px-3 py-[9px] rounded-ctl border text-left ${provider === c.id ? 'border-accent bg-accent-soft' : 'border-border bg-surface hover:border-border-strong'}`}
              >
                <span className={`w-[14px] h-[14px] rounded-full border-[1.5px] grid place-items-center flex-none ${provider === c.id ? 'border-accent' : 'border-border-strong'}`}>
                  {provider === c.id && <span className="w-[6px] h-[6px] rounded-full bg-accent" />}
                </span>
                <span className="flex-1 min-w-0">
                  <span className="block font-medium">{c.name}</span>
                  <span className="block text-[11.5px] text-muted">{c.hint}</span>
                </span>
                {c.suggested && <span className="text-[10.5px] font-semibold text-accent bg-accent-soft rounded-full px-2 py-px">Suggested</span>}
              </button>
            ))}
          </div>
          <p className="text-[11.5px] text-muted mt-2">OpenAI, DeepSeek, OpenRouter and others are in Settings.</p>
        </div>
      </section>

      <section className="flex gap-3">
        <Num n={2} done={!!state.ok} />
        <div className="flex-1 min-w-0">
          <h2 className="font-semibold">{needsKey ? `Paste your ${name} key` : `Start ${name}`}</h2>
          {needsKey ? (
            <>
              <label className="mt-2 flex items-center gap-2 h-8 px-[10px] rounded-ctl border border-border-strong bg-raised focus-within:shadow-[var(--focus)]">
                <KeyRound size={13} className="text-muted flex-none" aria-hidden />
                <input
                  type="password"
                  value={key}
                  onChange={(e) => { setKey(e.target.value); setState({}); }}
                  placeholder={provider === 'groq' ? 'gsk_…' : 'Your API key'}
                  aria-label={`${name} API key`}
                  autoComplete="off"
                  spellCheck={false}
                  className="flex-1 min-w-0 bg-transparent outline-none font-mono text-[12px] placeholder:text-muted focus-visible:shadow-none"
                />
              </label>
              {preset.keyUrl && (
                <a href={preset.keyUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 mt-[6px] text-[12px] font-medium text-accent">
                  Get a {provider === 'ollama' ? '' : 'free '}key at {new URL(preset.keyUrl).host}<ArrowUpRight size={12} aria-hidden />
                </a>
              )}
            </>
          ) : (
            <p className="text-[12px] text-muted mt-1 leading-[1.5]">
              Start Ollama with <code className="font-mono text-[11.5px]">OLLAMA_ORIGINS=chrome-extension://*</code> so Tabi may reach it, and pull a model first.
            </p>
          )}
        </div>
      </section>

      <section className="flex gap-3">
        <Num n={3} done={!!state.ok} />
        <div className="flex-1 min-w-0">
          <h2 className="font-semibold">Test it</h2>
          <button type="button" className="btn btn-primary mt-2" disabled={state.testing || (needsKey && key.trim().length < 8)} onClick={test}>
            {state.testing && <LoaderCircle size={13} className="animate-spin" aria-hidden />}{needsKey ? 'Test key' : 'Test connection'}
          </button>
          {state.ok && <div role="status" className="mt-2 flex items-center gap-[5px] text-[12px] text-green"><Check size={13} aria-hidden />{state.ok}</div>}
          {state.error && <div role="alert" className="mt-2 flex items-start gap-[5px] text-[12px] text-red [overflow-wrap:anywhere]"><X size={13} className="flex-none mt-px" aria-hidden />{state.error}</div>}
        </div>
      </section>

      <button type="button" onClick={onOpenSettings} className="self-start inline-flex items-center gap-[6px] text-[12.5px] font-medium text-accent mt-1">
        <Settings size={13} aria-hidden />Open full Settings
      </button>
    </div>
  );
}
