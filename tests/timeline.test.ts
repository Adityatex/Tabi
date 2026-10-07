import { describe, it, expect } from 'vitest';
import { entryKindOf, capEntries, maskSecrets, upsertRun, formatRunLog, formatDuration, type RunLog, type TimelineEntry } from '@/lib/agent/timeline';

const log = (over: Partial<RunLog> = {}): RunLog => ({
  id: 'r1', goal: 'Log in with password hunter22', started: Date.UTC(2026, 9, 2, 9, 0, 0), ended: Date.UTC(2026, 9, 2, 9, 0, 42),
  status: 'done', summary: 'Logged in', calls: 2, checks: 0, tokens: 3100,
  entries: [
    { at: Date.UTC(2026, 9, 2, 9, 0, 5), kind: 'model', text: 'Asked the model (planning)', model: 'Groq · qwen', ms: 2300, tokens: 1500 },
    { at: Date.UTC(2026, 9, 2, 9, 0, 9), kind: 'step', text: 'type [2] "hunter22" → ✅ Typed "hunter22"', url: 'https://shop.test/login' },
  ],
  ...over,
});

describe('run timeline', () => {
  it('tells Tabi notes from agent steps', () => {
    expect(entryKindOf('(note from Tabi) 2 more actions not run')).toBe('note');
    expect(entryKindOf('(invalid response) → ❌ No JSON')).toBe('note');
    expect(entryKindOf('click [3] → ✅ Clicked')).toBe('step');
  });

  it('masks typed passwords and card numbers everywhere', () => {
    const masked = maskSecrets(log(), ['hunter22']);
    expect(JSON.stringify(masked)).not.toContain('hunter22');
    expect(masked.entries[1].text).toBe('type [2] "••••" → ✅ Typed "••••"');
    expect(masked.goal).toBe('Log in with password ••••');
  });

  it('keeps the newest 50 runs, updating a run in place', () => {
    let list: RunLog[] = [];
    for (let i = 0; i < 55; i++) list = upsertRun(list, log({ id: `r${i}`, started: i }));
    expect(list).toHaveLength(50);
    expect(list[0].id).toBe('r54');
    list = upsertRun(list, log({ id: 'r54', started: 54, status: 'stopped' }));
    expect(list.filter((r) => r.id === 'r54')).toEqual([expect.objectContaining({ status: 'stopped' })]);
  });

  it('a very long run keeps its start and its end', () => {
    const entries: TimelineEntry[] = Array.from({ length: 1000 }, (_, i) => ({ at: i, kind: 'step', text: `step ${i}` }));
    const kept = capEntries(entries, 100);
    expect(kept).toHaveLength(100);
    expect(kept[0].text).toBe('step 0');
    expect(kept[25].text).toBe('(901 entries in the middle of this long run were not kept)');
    expect(kept.at(-1)!.text).toBe('step 999');
  });

  it('exports a run as Markdown', () => {
    const md = formatRunLog(maskSecrets(log(), ['hunter22']));
    expect(md).toContain('# Tabi run: Log in with password ••••');
    expect(md).toContain('- **Took:** 42s · 2 model calls · 3,100 tokens');
    expect(md).toMatch(/\| \*\*Model:\*\* Asked the model \(planning\) \| Groq · qwen · 2\.3s · 1500 tokens \|/);
    expect(md).not.toContain('hunter22');
  });

  it('formats durations', () => {
    expect(formatDuration(2300)).toBe('2.3s');
    expect(formatDuration(42_000)).toBe('42s');
    expect(formatDuration(65_000)).toBe('1m 05s');
  });
});

describe('timeline storage budget', () => {
  it('drops the oldest runs to stay under the size budget, never the newest', () => {
    const big = (id: string, started: number) => log({ id, started, entries: [{ at: 0, kind: 'step', text: 'x'.repeat(1000) }] });
    let list: RunLog[] = [];
    for (let i = 0; i < 10; i++) list = upsertRun(list, big(`r${i}`, i), 50, 5000);
    expect(list.length).toBeLessThan(10);
    expect(list[0].id).toBe('r9');
    expect(upsertRun([], big('only', 1), 50, 10)).toHaveLength(1);
  });
});
