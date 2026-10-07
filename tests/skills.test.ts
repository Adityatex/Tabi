import { describe, it, expect, vi } from 'vitest';
import { parseSkill, formatSkill, siteMatches, relevance, pickSkills, slugify, type Skill } from '@/lib/skills/skill';
import { loadSkills, saveSkill, deleteSkill, type KeyValueStorage } from '@/lib/skills/store';
import { hostsOf, typedValues, scrubTyped, writeSkillFromRun } from '@/lib/skills/writer';
import { skillsSection, startRun, type RunnerDeps, type TabInfo } from '@/lib/agent/runner';
import type { LLMConfig } from '@/lib/api/providers';

const skill = (name: string, description: string, sites: string[] = [], body = '1. Do the thing.'): Skill => ({ name, description, sites, body });

describe('SKILL.md', () => {
  it('reads the header and the instructions', () => {
    const r = parseSkill('---\nname: Order Status\ndescription: "Check an order\'s status on the shop"\nsites: [shop.test, https://www.Example.com/path]\nlicense: MIT\n---\n1. Open "My account".\n2. Click "Orders".\n');
    expect(r).toEqual({ ok: true, skill: {
      name: 'order-status',
      description: "Check an order's status on the shop",
      sites: ['shop.test', 'www.example.com'],
      body: '1. Open "My account".\n2. Click "Orders".',
    } });
  });

  it('reads a YAML list of sites and Windows line endings', () => {
    const r = parseSkill('---\r\nname: x\r\ndescription: y\r\nsites:\r\n  - a.test\r\n  - "*.b.test"\r\n---\r\nSteps');
    expect(r.ok && r.skill.sites).toEqual(['a.test', '*.b.test']);
  });

  it('says what is missing', () => {
    expect(parseSkill('just some text')).toMatchObject({ ok: false, error: expect.stringContaining('header between --- lines') });
    expect(parseSkill('---\nname: x\n---\nsteps')).toMatchObject({ ok: false, error: expect.stringContaining('needs a description') });
    expect(parseSkill('---\nname: x\ndescription: y\n---\n')).toMatchObject({ ok: false, error: expect.stringContaining('no instructions') });
    expect(parseSkill(`---\nname: x\ndescription: y\n---\n${'a'.repeat(3001)}`)).toMatchObject({ ok: false, error: expect.stringContaining('too long') });
  });

  it('writes a skill that reads back the same', () => {
    const s = skill('order-status', 'Check an order: "quotes" too', ['shop.test'], '1. Open the account.');
    expect(parseSkill(formatSkill(s))).toEqual({ ok: true, skill: s });
    expect(slugify('  Buy: Trail Runners!! ')).toBe('buy-trail-runners');
  });
});

describe('picking skills', () => {
  it('matches sites, with *. covering subdomains', () => {
    expect(siteMatches(['shop.test'], 'www.shop.test')).toBe(true);
    expect(siteMatches(['*.example.com'], 'mail.example.com')).toBe(true);
    expect(siteMatches(['*.example.com'], 'example.com')).toBe(true);
    expect(siteMatches(['example.com'], 'notexample.com')).toBe(false);
  });

  it('scores how much of a skill\'s description the goal mentions', () => {
    expect(relevance(skill('invoice-total', 'Add up unpaid invoices across billing pages'), 'what do I owe on unpaid invoices?')).toBeGreaterThan(0.3);
    expect(relevance(skill('invoice-total', 'Add up unpaid invoices across billing pages'), 'buy running shoes')).toBe(0);
  });

  it('shows the skills for this site that relate to the goal, then strong fits from anywhere', () => {
    const skills = [
      skill('shop-returns', 'Return an item bought on the shop', ['shop.test']),
      skill('shop-order-status', 'Check the delivery status of an order on the shop', ['shop.test']),
      skill('flights', 'Search for cheap flights'),
    ];
    const picked = pickSkills(skills, 'Where is my order? Check its delivery status', 'https://shop.test/account').map((s) => s.name);
    expect(picked).toEqual(['shop-order-status']);
    expect(pickSkills(skills, 'Find cheap flights to Paris', 'https://other.test/').map((s) => s.name)).toEqual(['flights']);
    expect(pickSkills(skills, 'Log in', 'https://shop.test/')).toEqual([]); // same site, different task
  });

  it('puts chosen skills in full under the goal and lists the others', () => {
    const skills = [skill('order-status', 'Check an order status on the shop', ['shop.test'], '1. Open Orders.'), skill('flights', 'Search flights')];
    const text = skillsSection(skills, 'check my order status', 'https://shop.test/', new Set());
    expect(text).toBe('\n\n--- SKILLS (instructions the user saved for tasks like this; follow them where they fit) ---\n'
      + '### order-status: Check an order status on the shop\n1. Open Orders.\n\n'
      + '--- OTHER SKILLS (load one with use_skill if it fits this task) ---\n- flights: Search flights');
    expect(skillsSection([], 'x', undefined, new Set())).toBe('');
  });
});

describe('skill storage', () => {
  function memoryStorage(): KeyValueStorage {
    const data: Record<string, unknown> = {};
    return { get: async (k) => ({ [k]: data[k] }), set: async (items) => { Object.assign(data, items); } };
  }

  it('adds, replaces by name, and deletes', async () => {
    const storage = memoryStorage();
    await saveSkill(storage, skill('a', 'first'));
    await saveSkill(storage, skill('b', 'second'));
    await saveSkill(storage, skill('a', 'first, improved'));
    expect((await loadSkills(storage)).map((s) => `${s.name}: ${s.description}`)).toEqual(['b: second', 'a: first, improved']);
    await deleteSkill(storage, 'b');
    expect((await loadSkills(storage)).map((s) => s.name)).toEqual(['a']);
  });
});

describe('Save as skill', () => {
  const record = {
    goal: 'Log in as demo and check order 1042',
    status: 'done' as const,
    plan: [],
    history: [
      'navigate https://shop.test/login → ✅ now on "Login"',
      'type [3] "demo" → ✅ typed',
      'type [4] "hunter2" → ✅ typed',
      'click [5] → ❌ Element [5] is covered by a cookie banner',
      'click [9] → ✅ Clicked <button> "Accept cookies"',
    ],
    summary: 'Order 1042 has shipped',
    urls: ['https://shop.test/login', 'https://www.shop.test/orders', 'not a url'],
    trace: [],
  };
  const config: LLMConfig = { provider: 'groq', label: 'Groq', baseUrl: 'https://groq.test/v1', apiKey: 'k', model: 'm' };

  it('finds the sites visited and the values typed', () => {
    expect(hostsOf(record.urls)).toEqual(['shop.test']);
    expect(typedValues(record.history)).toEqual(['demo', 'hunter2']);
    expect(scrubTyped('log in with demo / hunter2', ['demo', 'hunter2'])).toBe('log in with <value> / <value>');
  });

  it('asks the model for a skill, and keeps typed values out of it whatever the model wrote', async () => {
    const call = vi.fn(async () => JSON.stringify({
      name: 'Shop Order Status',
      description: 'Check an order on shop.test',
      body: '1. Log in (username demo, password hunter2).\n2. Accept cookies first.',
    }));
    const s = await writeSkillFromRun(record, config, call as any);
    expect(s).toEqual({
      name: 'shop-order-status',
      description: 'Check an order on shop.test',
      sites: ['shop.test'],
      body: '1. Log in (username <value>, password <value>).\n2. Accept cookies first.',
    });
    const prompt = (call.mock.calls[0] as any)[0][1].content as string;
    expect(prompt).toContain('TASK: Log in as demo and check order 1042');
    expect(prompt).toContain('4. click [5] → ❌ Element [5] is covered by a cookie banner');
  });

  it('refuses an unusable answer', async () => {
    await expect(writeSkillFromRun(record, config, (async () => 'no json here') as any)).rejects.toThrow("didn't write a usable skill");
  });
});

describe('skills in a run', () => {
  function deps(answers: string[]) {
    const tab: TabInfo = { status: 'complete', url: 'https://shop.test/', title: 'Shop' };
    const goals: string[] = [];
    const histories: string[][] = [];
    let i = 0;
    const d: RunnerDeps = {
      plan: vi.fn(async (goal: string, _s: string, history: string[]) => {
        goals.push(goal);
        histories.push([...history]);
        return answers[Math.min(i++, answers.length - 1)];
      }),
      send: vi.fn(async (_t: number, m: any) => (m.action === 'AGENT_SNAPSHOT' ? { text: 'PAGE' } : m.action === 'AGENT_EXECUTE' ? '✅ ok' : { ok: true })),
      getTab: vi.fn(async () => ({ ...tab })),
      navigate: vi.fn(async () => {}),
      onRunEnded: vi.fn(),
      sleep: vi.fn(async () => {}),
    };
    return { d, goals, histories };
  }

  it('shows fitting skills with the goal, and loads others on request', async () => {
    const skills = [skill('order-status', 'Check order status on the shop', ['shop.test'], '1. Open Orders.'), skill('returns', 'Return an item', [], '1. Open Returns.')];
    const { d, goals, histories } = deps([
      '{"actions":[{"action":"use_skill","text":"returns"},{"action":"use_skill","text":"nope"}]}',
      '{"action":"done","summary":"ok"}',
    ]);
    await startRun(d, 90, 'check my order status', { skills });
    expect(goals[0]).toContain('### order-status: Check order status on the shop\n1. Open Orders.');
    expect(goals[0]).toContain('- returns: Return an item');
    expect(histories[1]).toEqual([
      'use_skill "returns" → ✅ loaded: its instructions are now under SKILLS',
      'use_skill "nope" → ❌ there is no skill named "nope"',
    ]);
    expect(goals[1]).toContain('### returns: Return an item\n1. Open Returns.');
    // use_skill never reaches the page
    expect((d.send as any).mock.calls.some(([, m]: any) => m.action === 'AGENT_EXECUTE')).toBe(false);
  });

  it('puts a skill the user chose (/name) in full from the first step, however little the goal looks like it', async () => {
    const skills = [skill('house-style', 'Write replies in our house style', [], '1. Sign off with "Cheers".'), skill('returns', 'Return an item', [], '1. Open Returns.')];
    const { d, goals } = deps(['{"action":"done","summary":"ok"}']);
    const view = await startRun(d, 91, 'answer the message from Sam', { skills, useSkills: ['house-style', 'no-such-skill'] });
    expect(goals[0]).toContain('### house-style: Write replies in our house style\n1. Sign off with "Cheers".');
    expect(goals[0]).toContain('- returns: Return an item');
    expect(view.chosenSkills).toEqual(['house-style']);
  });
});
