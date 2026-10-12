// Provider fallback: try the active provider, and when it is rate-limited or
// failing, the user's backup providers in order. Nothing about a task lives
// with a provider (every agent call sends the goal, plan, history and page), so
// a backup can take over mid-task.

import { LLMError, type LLMErrorKind } from '@/lib/api/llmClient';
import type { LLMConfig } from '@/lib/api/providers';

/** How long a provider rests after each kind of failure, unless it says otherwise. */
const COOLDOWN_MS: Record<LLMErrorKind, number> = {
  'rate-limit': 20_000,
  unavailable: 30_000,
  other: 30_000,
  // These don't fix themselves during a task
  daily: 60 * 60_000,
  auth: 60 * 60_000,
  model: 60 * 60_000,
};
/** Longest rate-limit rest honoured from a provider's retry-after. */
const MAX_RATE_LIMIT_REST_MS = 5 * 60_000;
/** When every provider is resting, wait this long at most for one to come back. */
const MAX_WAIT_MS = 60_000;

const REASONS: Record<LLMErrorKind, string> = {
  'rate-limit': 'hit its rate limit',
  daily: 'used up its daily quota',
  auth: 'rejected its API key',
  model: "doesn't offer the chosen model",
  unavailable: "couldn't be reached",
  other: 'returned an error',
};

/** "Groq · qwen/qwen3.8-27b" */
export function modelLabel(config: LLMConfig): string {
  return `${config.label} · ${config.model}`;
}

export interface FallbackResult<T> {
  value: T;
  /** The provider that answered. */
  config: LLMConfig;
  /** Earlier providers in the chain that couldn't answer, and why. */
  skipped: { label: string; reason: string }[];
}

function kindOf(error: unknown): LLMErrorKind {
  return error instanceof LLMError ? error.kind : 'other';
}

export class ProviderPool {
  /** Resting providers, by provider + model. */
  private resting = new Map<string, { until: number; reason: string }>();

  constructor(
    private now: () => number = Date.now,
    private sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}

  private key(config: LLMConfig): string {
    return `${config.provider}|${config.model}`;
  }

  /** Why this provider is resting, or null if it can be used now. */
  restingReason(config: LLMConfig): string | null {
    const rest = this.resting.get(this.key(config));
    return rest && rest.until > this.now() ? rest.reason : null;
  }

  private rest(config: LLMConfig, error: unknown): string {
    const kind = kindOf(error);
    const retryAfter = error instanceof LLMError ? error.retryAfterMs : undefined;
    const ms = kind === 'rate-limit' && retryAfter ? Math.min(retryAfter, MAX_RATE_LIMIT_REST_MS) : COOLDOWN_MS[kind];
    const reason = REASONS[kind];
    this.resting.set(this.key(config), { until: this.now() + ms, reason });
    return reason;
  }

  /**
   * Call the first provider in `chain` that isn't resting, moving down the
   * chain on failure. Only the last available provider waits out rate limits
   * and retries; the others give up at once so the next can answer.
   */
  async run<T>(chain: LLMConfig[], call: (config: LLMConfig) => Promise<T>): Promise<FallbackResult<T>> {
    const skipped: FallbackResult<T>['skipped'] = [];
    const available = chain.filter((config) => {
      const reason = this.restingReason(config);
      if (reason) skipped.push({ label: modelLabel(config), reason });
      return !reason;
    });

    let lastError: unknown;
    for (const [i, config] of available.entries()) {
      const isLast = i === available.length - 1;
      try {
        const value = await call(isLast ? config : { ...config, failFast: true });
        this.resting.delete(this.key(config));
        return { value, config, skipped };
      } catch (error) {
        lastError = error;
        skipped.push({ label: modelLabel(config), reason: this.rest(config, error) });
      }
    }
    if (lastError) throw lastError;

    // Every provider is resting: wait for the first one back, if it's soon
    const soonest = Math.min(...chain.map((c) => this.resting.get(this.key(c))?.until ?? Infinity));
    const wait = soonest - this.now();
    if (wait <= MAX_WAIT_MS) {
      await this.sleep(Math.max(0, wait));
      return this.run(chain, call);
    }
    const why = skipped.map((s) => `${s.label} ${s.reason}`).join('; ');
    throw new LLMError(`No provider can answer right now: ${why}. Add a backup provider in Tabi's Settings, or try again later.`, 'rate-limit');
  }
}

/** Shared by all requests from the background worker. */
export const providerPool = new ProviderPool();
