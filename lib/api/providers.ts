// lib/api/providers.ts
// LLM provider presets and settings. Every provider here speaks the OpenAI
// chat-completions API, so one client (llmClient.ts) serves them all.

export type ProviderId = 'groq' | 'gemini' | 'mistral' | 'deepseek' | 'openai' | 'openrouter' | 'kilo' | 'opencode' | 'ollama' | 'custom';

export interface ProviderPreset {
  id: ProviderId;
  label: string;
  /** Base URL of the OpenAI-compatible API ('' for custom: the user supplies it). */
  baseUrl: string;
  needsKey: boolean;
  keyUrl?: string;
  /**
   * Which of the provider's models Tabi can use. Some providers also serve
   * models through non-chat-completions APIs (Anthropic messages, OpenAI
   * responses) that Tabi doesn't speak yet.
   */
  modelFilter?: (id: string) => boolean;
  /** Free models the provider's /models list doesn't mark as free. */
  freeModels?: string[];
  /**
   * Only set where it has been benchmarked. Model names change and get
   * retired (Groq retired this project's original default), so for other
   * providers Settings lists what the key can actually use via /models.
   */
  defaultModel?: string;
  /**
   * Response cap for agent planning, when a provider needs a smaller one than
   * the default. Groq's free tier rejects any request whose max_tokens exceeds
   * its output-tokens-per-minute limit (1,000 for some models).
   */
  maxOutputTokens?: number;
  note?: string;
}

export const PROVIDERS: Record<ProviderId, ProviderPreset> = {
  groq: {
    id: 'groq',
    label: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    needsKey: true,
    keyUrl: 'https://console.groq.com/keys',
    defaultModel: 'qwen/qwen3.8-27b',
    maxOutputTokens: 800,
    note: 'Free tier: about 8k tokens/minute, 1k output tokens/minute and 200k tokens/day per model.',
  },
  gemini: {
    id: 'gemini',
    label: 'Google AI Studio (Gemini)',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    needsKey: true,
    keyUrl: 'https://aistudio.google.com/apikey',
    // The list also has speech, image, embedding and live-audio models
    modelFilter: (id) => /^(gemini|gemma)-/.test(id) && !/(tts|image|embedding|live|audio|transcribe|robotics|computer-use)/.test(id),
    note: 'A free AI Studio key needs no billing. On the free tier pick a Flash-Lite model (about 500 requests/day); other Flash models allow only 20 requests/day, about 4 tasks. Google may use free-tier prompts, which include page content, to improve its products.',
  },
  mistral: {
    id: 'mistral',
    label: 'Mistral',
    baseUrl: 'https://api.mistral.ai/v1',
    needsKey: true,
    keyUrl: 'https://console.mistral.ai/api-keys',
    note: 'The free Experiment plan (no card) allows about 1 request/second. On it, Mistral may use your prompts, which include page content, for training; check the data settings in its console.',
  },
  deepseek: {
    id: 'deepseek',
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    needsKey: true,
    keyUrl: 'https://platform.deepseek.com/api_keys',
  },
  openai: {
    id: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    needsKey: true,
    keyUrl: 'https://platform.openai.com/api-keys',
  },
  openrouter: {
    id: 'openrouter',
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    needsKey: true,
    keyUrl: 'https://openrouter.ai/keys',
  },
  kilo: {
    id: 'kilo',
    label: 'Kilo AI Gateway',
    baseUrl: 'https://api.kilo.ai/api/gateway',
    needsKey: true,
    keyUrl: 'https://app.kilo.ai',
    note: 'Hundreds of models, including free ones (marked "free"). Free models cost nothing with the key from a free Kilo account. Some free models may use your prompts, which include page content, for training.',
  },
  opencode: {
    id: 'opencode',
    label: 'OpenCode Zen',
    baseUrl: 'https://opencode.ai/zen/v1',
    needsKey: true,
    keyUrl: 'https://opencode.ai/auth',
    // Claude, GPT, Grok, Gemini, Muse, Jev and some Qwen models use other APIs
    // (Anthropic messages, OpenAI responses, Gemini) on Zen; these don't.
    modelFilter: (id) => !/^(claude-|gpt-|grok-|gemini-|muse-|jev-|qwen)/.test(id),
    freeModels: ['big-pickle'],
    note: 'Needs a Zen key with credit. Zen\'s free models refuse requests from outside the OpenCode app, so use a paid model here.',
  },
  ollama: {
    id: 'ollama',
    label: 'Ollama (local)',
    baseUrl: 'http://localhost:11434/v1',
    needsKey: false,
    note: 'Runs on your machine; nothing leaves it. Start Ollama with OLLAMA_ORIGINS=chrome-extension://* so the extension may call it.',
  },
  custom: {
    id: 'custom',
    label: 'Custom (OpenAI-compatible)',
    baseUrl: '',
    needsKey: false,
    note: 'Any server with an OpenAI-compatible /chat/completions endpoint.',
  },
};

export const PROVIDER_IDS = Object.keys(PROVIDERS) as ProviderId[];

/** What's saved in chrome.storage.local under SETTINGS_KEY. */
export interface StoredLLMSettings {
  provider: ProviderId;
  /** Chosen model per provider, so switching back and forth keeps each choice. */
  models: Partial<Record<ProviderId, string>>;
  /** API key per provider. Only the background service worker reads these. */
  keys: Partial<Record<ProviderId, string>>;
  customBaseUrl?: string;
  /**
   * Backup providers, in order. When the active one is rate-limited or fails,
   * the next one takes over, with its own saved key and model.
   */
  fallbacks?: ProviderId[];
  /**
   * Optional fast model for routine agent steps, while the active provider's
   * model plans and checks. It uses that provider's saved key.
   */
  executor?: { provider: ProviderId; model: string };
}

export const SETTINGS_KEY = 'tabi_llm';

/** Everything a request needs, resolved from settings. */
export interface LLMConfig {
  provider: ProviderId;
  label: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Planner response cap, if the provider needs a smaller one than the default. */
  maxOutputTokens?: number;
  /** Set by the fallback chain: give up at once on rate limits, another provider is waiting. */
  failFast?: boolean;
}

/** Stored settings, or Groq with nothing set up. */
export function readSettings(stored: Record<string, unknown>): StoredLLMSettings {
  const saved = stored[SETTINGS_KEY] as StoredLLMSettings | undefined;
  if (saved?.provider && PROVIDERS[saved.provider]) {
    const fallbacks = (saved.fallbacks ?? []).filter((id) => PROVIDERS[id] && id !== saved.provider);
    const executor = saved.executor && PROVIDERS[saved.executor.provider] && saved.executor.model?.trim()
      ? { provider: saved.executor.provider, model: saved.executor.model.trim() }
      : undefined;
    return { provider: saved.provider, models: saved.models ?? {}, keys: saved.keys ?? {}, customBaseUrl: saved.customBaseUrl, fallbacks, executor };
  }
  return { provider: 'groq', models: {}, keys: {} };
}

/** Config for the active provider (or `provider`, when given). */
export function resolveConfig(settings: StoredLLMSettings, provider: ProviderId = settings.provider): LLMConfig {
  const preset = PROVIDERS[provider];
  return {
    provider,
    label: preset.label,
    baseUrl: (provider === 'custom' ? settings.customBaseUrl ?? '' : preset.baseUrl).replace(/\/+$/, ''),
    apiKey: settings.keys[provider] ?? '',
    model: settings.models[provider] || preset.defaultModel || '',
    ...(preset.maxOutputTokens ? { maxOutputTokens: preset.maxOutputTokens } : {}),
  };
}

/**
 * The active provider's config, then each usable backup's, in order. Backups
 * that aren't set up (no key or model saved) are left out.
 */
export function resolveChain(settings: StoredLLMSettings): LLMConfig[] {
  const backups = [...new Set(settings.fallbacks ?? [])]
    .filter((id) => id !== settings.provider && PROVIDERS[id])
    .map((id) => resolveConfig(settings, id))
    .filter((config) => configProblem(config) === null);
  return [resolveConfig(settings, settings.provider), ...backups];
}

/** Config for the fast executor model, or null if none is set up or it lacks a key. */
export function resolveExecutor(settings: StoredLLMSettings): LLMConfig | null {
  const choice = settings.executor;
  if (!choice) return null;
  const config = { ...resolveConfig(settings, choice.provider), model: choice.model };
  return configProblem(config) === null ? config : null;
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * API keys and page content go to this URL, so it must be HTTPS. Plain HTTP is
 * allowed only for servers on this machine (e.g. Ollama). Returns an error
 * message, or null if the URL is fine.
 */
export function validateBaseUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'Enter a full URL, e.g. https://api.example.com/v1';
  }
  if (url.protocol === 'https:') return null;
  if (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname)) return null;
  if (url.protocol === 'http:') return 'Use https:// (http:// is only allowed for localhost), since your API key and page content are sent to this URL';
  return 'The URL must start with https://';
}

/** Why this config can't make requests yet, or null if it's ready. */
export function configProblem(config: LLMConfig): string | null {
  const preset = PROVIDERS[config.provider];
  if (!config.baseUrl) return `Set the server URL for ${config.label} in Tabi's Settings.`;
  const urlError = validateBaseUrl(config.baseUrl);
  if (urlError) return `${config.label} URL: ${urlError}.`;
  if (preset.needsKey && !config.apiKey) return `No API key for ${config.label}. Add one in Tabi's Settings.`;
  if (!config.model) return `Choose a ${config.label} model in Tabi's Settings ("Load models" lists what your key can use).`;
  return null;
}

export function maskKey(key: string): string {
  if (!key) return '';
  return key.length <= 12 ? '••••' : `${key.slice(0, 6)}…${key.slice(-4)}`;
}
