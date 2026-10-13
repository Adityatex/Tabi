import { describe, it, expect } from 'vitest';
import { markState, statusPill, planItems, formatElapsed, failureKind, failedProvider, siteOf, pathOf, when, foldLongRun, splitSources } from '@/lib/panel/view';
import type { RunView } from '@/lib/agent/runner';

const run = (over: Partial<RunView>): RunView => ({ goal: 'g', status: 'running', message: '', loading: true, step: 1, plan: [], updatedAt: 0, steps: [], ...over });

describe('the side panel view of a run', () => {
  it('moves the mark with what the agent is doing', () => {
    expect(markState(null)).toBe('idle');
    expect(markState(run({ phase: 'reading' }))).toBe('reading');
    expect(markState(run({ phase: 'thinking' }))).toBe('thinking');
    expect(markState(run({ phase: 'acting' }))).toBe('acting');
    expect(markState(run({ status: 'paused' }))).toBe('waiting');
    expect(markState(run({ status: 'done' }))).toBe('done');
    expect(markState(run({ status: 'error' }))).toBe('failed');
    expect(markState(run({ status: 'stopped' }))).toBe('stopped');
    expect(markState(run({ status: 'stopped', outcome: 'The agent is on mybank.com, which is on your block list, so it stopped.' }))).toBe('failed');
  });

  it('labels the status pill', () => {
    expect(statusPill(run({}))).toEqual({ tone: 'running', label: 'Running' });
    expect(statusPill(run({ replay: 'replaying' })).label).toBe('Replaying · no AI calls');
    expect(statusPill(run({ status: 'paused', asking: { action: 'click "Buy"', risk: 'a purchase' } })).label).toBe('Needs your OK');
    expect(statusPill(run({ status: 'paused' })).label).toBe('Paused');
    expect(statusPill(run({ status: 'stopped' })).label).toBe('Stopped by you');
    expect(statusPill(run({ status: 'queued' })).tone).toBe('neutral');
  });

  it('reads the plan: done items, the current one, and the ones that ask first', () => {
    expect(planItems(['[x] Open the product', '[ ] Fill in your address', '[ ] Place the order'])).toEqual([
      { text: 'Open the product', state: 'done', irreversible: false },
      { text: 'Fill in your address', state: 'current', irreversible: false },
      { text: 'Place the order', state: 'todo', irreversible: true },
    ]);
    expect(planItems(['Untagged step']).map((p) => p.state)).toEqual(['current']);
    expect(planItems(['[x] Open it', '[ ] Buy it'], true).map((p) => p.state)).toEqual(['done', 'done']);
  });

  it('formats elapsed time', () => {
    expect(formatElapsed(102_000)).toBe('1:42');
    expect(formatElapsed(3_729_000)).toBe('1:02:09');
  });

  it('tells failures apart', () => {
    expect(failureKind('Groq rejected the API key (401): Invalid API Key')).toBe('bad_key');
    expect(failureKind('Rate limit exceeded on Groq: try again in 42s')).toBe('rate_limit');
    expect(failureKind('Page timed out after 20s')).toBe('page_load');
    expect(failureKind('No API key for Groq. Add one in Settings.')).toBe('setup');
    expect(failureKind('something else')).toBe('other');
  });

  it('names the provider the error is about, which may be a backup', () => {
    expect(failedProvider('OpenRouter rejected the API key (401): No auth credentials found.')).toBe('OpenRouter');
    expect(failedProvider('Rate limit exceeded on Groq: try again in 42s')).toBe('Groq');
    expect(failedProvider('Page timed out after 20s')).toBe('');
  });

  it('splits a URL for the site row', () => {
    expect(siteOf('https://www.trailhead.shop/checkout?cart=8f')).toBe('trailhead.shop');
    expect(siteOf('chrome://extensions')).toBe('');
    expect(pathOf('https://trailhead.shop/checkout?cart=8f#x')).toBe('/checkout?cart=8f#x');
  });

  it('says when, briefly', () => {
    const now = new Date(2026, 9, 2, 12).getTime();
    expect(when(now - 30_000, now)).toBe('just now');
    expect(when(now - 5 * 60_000, now)).toBe('5m ago');
    expect(when(now - 86_400_000, now)).toBe('Yesterday');
  });
});

describe('folding a long run', () => {
  const step = (n: number, planItem?: string, status: 'ok' | 'fail' | 'run' = 'ok') => ({ n, planItem, status, icon: 'click' as const, action: `a${n}`, result: 'r' });

  it('folds each finished plan item into one row and keeps the last steps of the current one', () => {
    const steps = [
      ...Array.from({ length: 14 }, (_, i) => step(i + 1, 'Search three job boards')),
      ...Array.from({ length: 31 }, (_, i) => step(i + 15, 'Open and read 31 listings', i < 2 ? 'fail' : 'ok')),
      ...Array.from({ length: 16 }, (_, i) => step(i + 46, 'Add each job to the sheet', i === 15 ? 'run' : 'ok')),
    ];
    const rows = foldLongRun(steps, undefined);
    expect(rows.map((r) => (r.kind === 'step' ? `step ${r.step.n}` : r.kind === 'item' ? `${r.text}: ${r.count}/${r.failed}${r.current ? ' (current)' : ''}` : `earlier ${r.count}`))).toEqual([
      'Search three job boards: 14/0',
      'Open and read 31 listings: 31/2',
      'Add each job to the sheet: 16/0 (current)',
      'earlier 13',
      'step 59', 'step 60', 'step 61',
    ]);
  });

  it('counts steps from before the plan, and ones trimmed away', () => {
    const rows = foldLongRun([step(201), step(202, 'Sign in'), step(203, 'Sign in')], { count: 200, failed: 3 });
    expect(rows[0]).toEqual({ kind: 'earlier', count: 200, failed: 3 });
    expect(rows[1]).toEqual({ kind: 'earlier', count: 1, failed: 0 });
    expect(rows.filter((r) => r.kind === 'step')).toHaveLength(2);
  });
});

describe('answer sources', () => {
  it('splits the sources off an answer', () => {
    const { answer, sources } = splitSources('Mostly yes. **23 of 41** say so.\n\nSOURCES:\n- Reviews | "Runs small, order a half size up"\n- Size chart | US 10 = 27.9 cm\n- nonsense line');
    expect(answer).toBe('Mostly yes. **23 of 41** say so.');
    expect(sources).toEqual([{ label: 'Reviews', quote: 'Runs small, order a half size up' }, { label: 'Size chart', quote: 'US 10 = 27.9 cm' }]);
  });

  it('leaves an answer without sources alone', () => {
    expect(splitSources('Just an answer.')).toEqual({ answer: 'Just an answer.', sources: [] });
    expect(splitSources('Answer\n\n**Sources:**\n1. Header | Welcome back').sources).toEqual([{ label: 'Header', quote: 'Welcome back' }]);
  });
});
