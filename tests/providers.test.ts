import { describe, it, expect } from 'vitest';
import {
  PROVIDERS, SETTINGS_KEY, readSettings, resolveConfig, validateBaseUrl, configProblem, maskKey, makeMain,
  type StoredLLMSettings,
} from '@/lib/api/providers';

describe('readSettings', () => {
  it('reads saved settings', () => {
    const saved: StoredLLMSettings = { provider: 'deepseek', models: { deepseek: 'm' }, keys: { deepseek: 'k' } };
    expect(readSettings({ [SETTINGS_KEY]: saved }).provider).toBe('deepseek');
  });

  it('defaults to Groq with nothing saved', () => {
    expect(readSettings({})).toEqual({ provider: 'groq', models: {}, keys: {} });
  });

  it('ignores a saved unknown provider', () => {
    expect(readSettings({ [SETTINGS_KEY]: { provider: 'nope', models: {}, keys: {} } }).provider).toBe('groq');
  });
});

describe('resolveConfig', () => {
  const settings: StoredLLMSettings = {
    provider: 'groq',
    models: { deepseek: 'deepseek-x' },
    keys: { groq: 'gsk_1', deepseek: 'sk-2' },
    customBaseUrl: 'https://llm.example.com/v1/',
  };

  it('uses the preset URL, the saved key and the benchmarked default model', () => {
    expect(resolveConfig(settings)).toEqual({
      provider: 'groq', label: 'Groq', baseUrl: PROVIDERS.groq.baseUrl, apiKey: 'gsk_1', model: PROVIDERS.groq.defaultModel,
      maxOutputTokens: 800, // Groq's free tier rejects max_tokens over its 1k output-tokens/minute limit
    });
  });

  it('keeps a separate key and model per provider', () => {
    const c = resolveConfig(settings, 'deepseek');
    expect([c.apiKey, c.model]).toEqual(['sk-2', 'deepseek-x']);
    expect(c.maxOutputTokens).toBeUndefined(); // no per-request limit: the planner's default applies
  });

  it('uses the custom URL without a trailing slash', () => {
    expect(resolveConfig(settings, 'custom').baseUrl).toBe('https://llm.example.com/v1');
  });
});

describe('validateBaseUrl', () => {
  it('accepts https anywhere and http only on this machine', () => {
    expect(validateBaseUrl('https://api.example.com/v1')).toBeNull();
    expect(validateBaseUrl('http://localhost:11434/v1')).toBeNull();
    expect(validateBaseUrl('http://127.0.0.1:8080/v1')).toBeNull();
  });

  it('refuses to send keys over plain http to other hosts', () => {
    expect(validateBaseUrl('http://api.example.com/v1')).toMatch(/Use https:\/\//);
    expect(validateBaseUrl('ftp://example.com')).toMatch(/https/);
    expect(validateBaseUrl('not a url')).toMatch(/full URL/);
  });
});

describe('configProblem', () => {
  const base = { provider: 'groq' as const, label: 'Groq', baseUrl: PROVIDERS.groq.baseUrl, apiKey: 'k', model: 'm' };

  it('is null when ready', () => {
    expect(configProblem(base)).toBeNull();
  });

  it('asks for a missing key or model', () => {
    expect(configProblem({ ...base, apiKey: '' })).toMatch(/No API key for Groq/);
    expect(configProblem({ ...base, model: '' })).toMatch(/Choose a Groq model/);
  });

  it('does not require a key for local Ollama', () => {
    expect(configProblem({ provider: 'ollama', label: 'Ollama', baseUrl: PROVIDERS.ollama.baseUrl, apiKey: '', model: 'llama' })).toBeNull();
  });
});

describe('maskKey', () => {
  it('shows only the ends of a key', () => {
    expect(maskKey('gsk_abcdefghijklmnop1234')).toBe('gsk_ab…1234');
    expect(maskKey('short')).toBe('••••');
    expect(maskKey('')).toBe('');
  });
});

describe('Kilo and OpenCode Zen presets', () => {
  it('Kilo needs a key (keyless requests to its free models are rate-limited to nothing)', () => {
    const c = resolveConfig({ provider: 'kilo', models: { kilo: 'qwen/qwen3.8-27b:free' }, keys: {} });
    expect(c.baseUrl).toBe('https://api.kilo.ai/api/gateway');
    expect(configProblem(c)).toMatch(/No API key for Kilo AI Gateway/);
    expect(configProblem({ ...c, apiKey: 'k' })).toBeNull();
  });

  it('OpenCode Zen needs a key', () => {
    const c = resolveConfig({ provider: 'opencode', models: { opencode: 'deepseek-v4-flash' }, keys: {} });
    expect(c.baseUrl).toBe('https://opencode.ai/zen/v1');
    expect(configProblem(c)).toMatch(/No API key for OpenCode Zen/);
  });
});

describe('makeMain (the panel’s model menu)', () => {
  const settings: StoredLLMSettings = { provider: 'deepseek', models: {}, keys: {}, fallbacks: ['groq', 'ollama'] };

  it('swaps a backup with the main provider, keeping the backup order', () => {
    expect(makeMain(settings, 'ollama')).toMatchObject({ provider: 'ollama', fallbacks: ['groq', 'deepseek'] });
    expect(makeMain(settings, 'groq')).toMatchObject({ provider: 'groq', fallbacks: ['deepseek', 'ollama'] });
  });

  it('keeps the old main as the first backup when the new one wasn’t a backup', () => {
    expect(makeMain(settings, 'openai')).toMatchObject({ provider: 'openai', fallbacks: ['deepseek', 'groq', 'ollama'] });
  });

  it('changes nothing when it is already the main one', () => {
    expect(makeMain(settings, 'deepseek')).toBe(settings);
  });
});
