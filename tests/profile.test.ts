import { describe, it, expect, vi } from 'vitest';
import { STARTER_FIELDS, cleanProfile, filledFields, profileText } from '@/lib/automation/profile';
import { profileSection, startRun, type RunnerDeps } from '@/lib/agent/runner';

const PROFILE = [
  { label: 'Full name', value: 'Ananya Rao' },
  { label: 'Mobile number', value: '+91 98765 43210' },
  { label: 'Email', value: 'ananya@example.com' },
  { label: 'Postal code', value: '' },
];

describe('the autofill profile', () => {
  it('starts with the common details, all empty', () => {
    const fresh = cleanProfile(undefined);
    expect(fresh.map((f) => f.label)).toEqual([...STARTER_FIELDS]);
    expect(filledFields(fresh)).toEqual([]);
  });

  it('carries over a profile saved in the old shape, in the same order', () => {
    const old = { fullname: 'Ada Lovelace', email: 'ada@example.com', phone: '+44 20 7946 0000', address: '', city: 'London', state: '', zip: '', country: 'UK' };
    expect(filledFields(cleanProfile(old))).toEqual([
      { label: 'Full name', value: 'Ada Lovelace' },
      { label: 'Email', value: 'ada@example.com' },
      { label: 'Mobile number', value: '+44 20 7946 0000' },
      { label: 'City', value: 'London' },
      { label: 'Country', value: 'UK' },
    ]);
  });

  it('keeps the user’s own fields and drops broken or unnamed ones', () => {
    expect(cleanProfile([
      { label: ' Roll number ', value: '22CSE1043' },
      { label: '', value: 'no name' },
      { label: 'Bad', value: 7 },
      'junk',
    ])).toEqual([{ label: 'Roll number', value: '22CSE1043' }]);
    expect(cleanProfile([])).toEqual([]); // the user removed them all
  });

  it('gives the model the filled details, one per line', () => {
    expect(profileText([...PROFILE, { label: 'Why this course', value: 'I like\n  building things.' }])).toBe(
      '- Full name: Ananya Rao\n- Mobile number: +91 98765 43210\n- Email: ananya@example.com\n- Why this course: I like / building things.',
    );
  });
});

describe('the profile in the agent’s prompt', () => {
  it('lists only the labels until the details are loaded, and nothing when there are none', () => {
    const labels = profileSection(PROFILE, false);
    expect(labels).toContain('Full name, Mobile number, Email');
    expect(labels).toContain('use_profile');
    expect(labels).not.toContain('Ananya');
    expect(profileSection(PROFILE, true)).toContain('- Mobile number: +91 98765 43210');
    expect(profileSection(PROFILE, true)).toMatch(/by meaning/);
    expect(profileSection([{ label: 'Email', value: '' }], true)).toBe('');
  });

  function fakeRun(actions: string[]) {
    const goals: string[] = [];
    let i = 0;
    const deps: RunnerDeps = {
      plan: vi.fn(async (goal) => { goals.push(goal); return actions[Math.min(i++, actions.length - 1)]; }),
      send: vi.fn(async (_tab, message: any) => (message.action === 'AGENT_SNAPSHOT' ? { text: 'PAGE: Form' } : message.action === 'AGENT_EXECUTE' ? '✅ Typed' : { ok: true })),
      getTab: vi.fn(async () => ({ status: 'complete', url: 'https://apply.test/', title: 'Form' })),
      navigate: vi.fn(async () => {}),
      onRunEnded: vi.fn(),
      sleep: vi.fn(async () => {}),
    };
    return { deps, goals };
  }

  it('loads the details with use_profile, from the next call on', async () => {
    const { deps, goals } = fakeRun(['{"action":"use_profile"}', '{"action":"done","summary":"ok"}']);
    const view = await startRun(deps, 901, 'Fill in this form with my details', { profile: PROFILE });
    expect(goals[0]).not.toContain('+91 98765 43210');
    expect(goals[1]).toContain('- Mobile number: +91 98765 43210');
    expect(view.steps[0]).toMatchObject({ action: 'Read your autofill profile', result: 'Your details are in use' });
  });

  it('says so when there is nothing to load', async () => {
    const { deps, goals } = fakeRun(['{"action":"use_profile"}', '{"action":"done","summary":"ok"}']);
    await startRun(deps, 902, 'Fill in this form', { profile: [{ label: 'Email', value: '' }] });
    expect(goals[1]).not.toContain('MY DETAILS');
    expect((deps.plan as any).mock.calls[1][2][0]).toMatch(/no details saved/);
  });

  it('has the details from the start in an autofill task, and the safety check counts them as the user’s', async () => {
    const critic = vi.fn(async () => ({ ok: false, reason: 'no' }));
    const { deps, goals } = fakeRun(['{"action":"type","elementId":1,"text":"ananya@example.com"}', '{"action":"done","summary":"ok"}']);
    deps.critic = critic;
    const view = await startRun(deps, 903, 'Fill in the form on this page with my details.', { profile: PROFILE, autofill: true, critic: true });
    expect(goals[0]).toContain('- Email: ananya@example.com');
    expect(critic).not.toHaveBeenCalled();
    expect(view.status).toBe('done');
  });

  it('still checks an email that isn’t in the profile', async () => {
    const critic = vi.fn(async () => ({ ok: true, reason: '' }));
    const { deps } = fakeRun(['{"action":"type","elementId":1,"text":"someone@else.test"}', '{"action":"done","summary":"ok"}']);
    deps.critic = critic;
    await startRun(deps, 904, 'Fill in the form on this page with my details.', { profile: PROFILE, autofill: true, critic: true });
    expect(critic).toHaveBeenCalledTimes(1);
  });
});
