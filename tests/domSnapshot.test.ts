import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createDOMSnapshot, findElements, pageText, SNAPSHOT_BUDGET } from '@/lib/agent/domSnapshot';

// happy-dom has no layout engine, so give every element a non-zero box.
beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(
    { x: 0, y: 0, width: 100, height: 20, top: 0, left: 0, right: 100, bottom: 20, toJSON: () => ({}) },
  );
});

describe('createDOMSnapshot', () => {
  it('lists dropdown options so the model can choose a valid one', () => {
    document.body.innerHTML = `
      <label>Country
        <select name="country">
          <option value="IN">India</option>
          <option value="US">United States</option>
        </select>
      </label>`;

    const { text, elements } = createDOMSnapshot();

    expect(elements[0].options).toEqual(['India', 'United States']);
    expect(text).toContain('options=["India", "United States"]');
  });

  it('caps long option lists', () => {
    const opts = Array.from({ length: 40 }, (_, i) => `<option>Item ${i}</option>`).join('');
    document.body.innerHTML = `<select>${opts}</select>`;

    const { elements } = createDOMSnapshot();

    expect(elements[0].options).toHaveLength(16);
    expect(elements[0].options!.at(-1)).toBe('…+25 more');
  });

  it('tags elements with data-tabi-id matching their snapshot id', () => {
    document.body.innerHTML = '<button>A</button><a href="/x">B</a>';

    const { elements } = createDOMSnapshot();

    for (const el of elements) {
      expect(document.querySelector(`[data-tabi-id="${el.id}"]`)).not.toBeNull();
    }
    expect(elements).toHaveLength(2);
  });
});

describe('shadow DOM', () => {
  it('finds elements inside open shadow roots and the executor can click them', async () => {
    document.body.innerHTML = '<div id="host"></div><button>Outside</button>';
    const root = document.getElementById('host')!.attachShadow({ mode: 'open' });
    root.innerHTML = '<button>Subscribe</button>';
    const onClick = vi.fn();
    root.querySelector('button')!.addEventListener('click', onClick);

    const { text, elements } = createDOMSnapshot();
    const sub = elements.find(e => e.label === 'Subscribe');
    expect(sub).toBeDefined();
    expect(text).toContain('"Subscribe"');

    Element.prototype.scrollIntoView = vi.fn();
    const { executeAction } = await import('@/lib/agent/actionExecutor');
    await executeAction({ action: 'click', elementId: sub!.id });
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('lists elements in document order, shadow content where its host is', () => {
    document.body.innerHTML = '<button>First</button><div id="host"></div><button>Last</button>';
    document.getElementById('host')!.attachShadow({ mode: 'open' }).innerHTML = '<button>Middle</button>';
    expect(createDOMSnapshot().elements.map(e => e.label)).toEqual(['First', 'Middle', 'Last']);
  });

  it("never includes Tabi's own UI on the page: the cue and the toolbar on selected text", () => {
    document.body.innerHTML = '<button>Page button</button><tabi-cue></tabi-cue><tabi-selection></tabi-selection>';
    document.querySelector('tabi-cue')!.attachShadow({ mode: 'open' }).innerHTML = '<button>Stop</button>';
    document.querySelector('tabi-selection')!.attachShadow({ mode: 'open' }).innerHTML = '<div role="toolbar" aria-label="Tabi"><button>Explain</button></div>';
    const { text, elements } = createDOMSnapshot();
    expect(elements.map(e => e.label)).toEqual(['Page button']);
    expect(text).not.toContain('Tabi');
  });
});

describe('ARIA widgets', () => {
  it('lists custom widgets with their role and state', () => {
    document.body.innerHTML = `
      <div tabindex="0" aria-haspopup="listbox" aria-expanded="false" aria-label="Plan">Select a plan</div>
      <div role="switch" aria-checked="true" aria-label="Dark mode"></div>
      <ul role="listbox"><li role="option" aria-selected="true">Pro</li></ul>`;
    const lines = createDOMSnapshot().text.split('\n').filter(l => l.startsWith('['));
    expect(lines).toEqual([
      '[0] <div> "Plan" [collapsed, popup=listbox]',
      '[1] <div> role="switch" "Dark mode" [checked]',
      '[2] <li> role="option" "Pro" [selected]',
    ]);
  });
});

describe('long pages: snapshot budget + find', () => {
  const rect = (top: number) => ({ x: 0, y: top, width: 100, height: 20, top, left: 0, right: 100, bottom: top + 20, toJSON: () => ({}) });

  beforeEach(() => {
    // Buttons labelled "far ..." sit far below the viewport; the rest are on screen
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return rect(this.textContent?.startsWith('far') ? 50_000 : 10);
    });
  });

  function mountLongPage() {
    const near = Array.from({ length: 150 }, (_, i) => `<button>near button number ${i}</button>`).join('');
    const far = Array.from({ length: 150 }, (_, i) => `<button>far button number ${i}</button>`).join('');
    document.body.innerHTML = near + far;
    document.body.insertAdjacentHTML('afterbegin', '<button>far Account settings</button>');
  }

  it('stays within the budget and says how many elements it left out', () => {
    mountLongPage();
    const { text, elements } = createDOMSnapshot();
    expect(elements).toHaveLength(301); // every element still gets an ID
    expect(text.length).toBeLessThanOrEqual(SNAPSHOT_BUDGET);
    expect(text).toMatch(/… \d+ more elements are off-screen and not listed\. Use \{"action": "find"/);
  });

  it('lists on-screen elements before off-screen ones', () => {
    mountLongPage();
    const listed = createDOMSnapshot().text.split('\n').filter(l => /^\[\d+\]/.test(l));
    expect(listed.some(l => l.includes('"near button number 0"'))).toBe(true);
    // The off-screen button comes first in page order but must not crowd out on-screen ones
    expect(listed.some(l => l.includes('far Account settings'))).toBe(false);
  });

  it('find reaches unlisted elements, and their IDs are clickable', async () => {
    mountLongPage();
    createDOMSnapshot();
    const [hit] = findElements('account settings');
    expect(hit.label).toBe('far Account settings');

    const onClick = vi.fn();
    document.querySelector('button')!.addEventListener('click', onClick);
    Element.prototype.scrollIntoView = vi.fn();
    const { executeAction } = await import('@/lib/agent/actionExecutor');
    expect(await executeAction({ action: 'find', text: 'account settings' })).toContain(`[${hit.id}] <button> "far Account settings"`);
    await executeAction({ action: 'click', elementId: hit.id });
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('find matches all words, in any order', () => {
    mountLongPage();
    createDOMSnapshot();
    expect(findElements('settings ACCOUNT').map(e => e.label)).toEqual(['far Account settings']);
    expect(findElements('nonexistent thing')).toEqual([]);
  });
});

describe('page text from shadow roots', () => {
  it('includes text rendered inside a shadow root, which body.innerText leaves out', () => {
    document.body.innerHTML = '<h1>Newsletter</h1><div id="host"></div>';
    document.getElementById('host')!.attachShadow({ mode: 'open' }).innerHTML =
      '<style>p { color: red }</style><button>Subscribe</button><p>Subscribed!</p>';

    const text = pageText(2000);
    expect(text).toContain('Newsletter');
    expect(text).toContain('[in component]');
    expect(text).toContain('Subscribed!');
    expect(text).not.toContain('color: red'); // style text isn't page text
  });

  it("keeps the text of Tabi's own UI on the page out", () => {
    document.body.innerHTML = '<p>Page</p><tabi-cue></tabi-cue><tabi-selection></tabi-selection>';
    document.querySelector('tabi-cue')!.attachShadow({ mode: 'open' }).innerHTML = '<p>Tabi is working</p>';
    document.querySelector('tabi-selection')!.attachShadow({ mode: 'open' }).innerHTML = '<p>Photosynthesis is how plants</p>';
    const text = pageText(2000);
    expect(text).not.toContain('Tabi is working');
    expect(text).not.toContain('Photosynthesis');
  });
});

describe('labels and groups, the way a screen reader names things', () => {
  it('names a field by aria-labelledby, then aria-label, then its <label>', () => {
    document.body.innerHTML = `
      <div id="q1">Participant name</div><input id="a" aria-labelledby="q1 missing">
      <input aria-label="Search">
      <label for="email">Email address</label><input id="email" placeholder="you@example.com">
      <label><input type="checkbox"> I agree to the terms</label>`;

    const { elements } = createDOMSnapshot();

    expect(elements.map((e) => e.label)).toEqual(['Participant name', 'Search', 'Email address', 'I agree to the terms']);
  });

  it('heads each question’s options with the question, so "Paris" in two questions is not ambiguous', () => {
    document.body.innerHTML = `
      <div role="list">
        <div role="listitem">
          <div role="heading" id="h1">1. Capital of France?</div>
          <div role="radiogroup" aria-labelledby="h1">
            <div role="radio" aria-label="Paris" tabindex="0"></div><div role="radio" aria-label="Lyon" tabindex="0"></div>
          </div>
        </div>
        <div role="listitem">
          <div role="heading" id="h2">2. Where is the Louvre?</div>
          <div role="radiogroup" aria-labelledby="h2">
            <div role="radio" aria-label="Paris" tabindex="0"></div>
          </div>
        </div>
      </div>`;

    const { text, elements } = createDOMSnapshot();

    expect(elements.map((e) => e.group)).toEqual(['1. Capital of France?', '1. Capital of France?', '2. Where is the Louvre?']);
    const lines = text.split('\n');
    const first = lines.indexOf('── 1. Capital of France? ──');
    const second = lines.indexOf('── 2. Where is the Louvre? ──');
    expect(first).toBeGreaterThan(-1);
    expect(lines[first + 1]).toMatch(/"Paris"/);
    expect(lines[first + 2]).toMatch(/"Lyon"/);
    expect(lines[second + 1]).toMatch(/"Paris"/);
  });

  it('gives a grid row both its question and its row', () => {
    document.body.innerHTML = `
      <div role="listitem"><div role="heading">13. Rate each era</div>
        <div role="radiogroup" aria-label="The Renaissance"><div role="radio" aria-label="High" tabindex="0"></div></div>
      </div>`;

    expect(createDOMSnapshot().elements[0].group).toBe('13. Rate each era › The Renaissance');
  });

  it('doesn’t repeat a field’s question as its group', () => {
    document.body.innerHTML = `
      <div role="listitem"><div role="heading" id="q">Your name</div><input aria-labelledby="q"></div>`;

    const { text, elements } = createDOMSnapshot();

    expect(elements[0].label).toBe('Your name');
    expect(elements[0].group).toBeUndefined();
    expect(text).not.toContain('──');
  });

  it('names a product card’s button by the card’s heading, and find searches it', () => {
    document.body.innerHTML = `
      <ul><li><h3>Kite 14</h3><button>Add to cart</button></li><li><h3>Kite 9</h3><button>Add to cart</button></li></ul>
      <nav><ul><li><a href="/home">Home</a></li></ul></nav>`;

    const { elements } = createDOMSnapshot();

    expect(elements.map((e) => e.group)).toEqual(['Kite 14', 'Kite 9', undefined]);
    expect(findElements('add to cart kite 9').map((e) => e.id)).toEqual([1]);
  });
});

describe('styled rating buttons: hidden radios inside their labels', () => {
  const question = (n: number, text: string, course: string) => `
    <div class="mode-input">
      <span><b>${n}: </b>${text}<em>*</em></span>
      <div class="radiobehav"><div class="radio-inputs">
        ${['Strongly Disagree', 'Disagree', 'Neutral', 'Agree', 'Strongly Agree'].map((name, i) => `
        <label class="radio">
          <input type="radio" style="display:none" name="answer[${course}][9005][${n}]" value="${i + 1}">
          <p class="name">${name}</p>
        </label>`).join('')}
      </div></div>
    </div>`;

  it('lists each visible label in place of its hidden radio, under its question', () => {
    document.body.innerHTML = question(1, 'The syllabus was adequately covered.', 'CSE062') + question(2, 'The teacher was well-prepared for each class.', 'CSE062');

    const { text, elements } = createDOMSnapshot();

    expect(elements).toHaveLength(10);
    expect(elements.slice(0, 5).map((e) => `${e.tag} ${e.type} ${e.label} ${e.value}`)).toEqual([
      'input radio Strongly Disagree 1', 'input radio Disagree 2', 'input radio Neutral 3', 'input radio Agree 4', 'input radio Strongly Agree 5',
    ]);
    expect(elements[0].group).toBe('1: The syllabus was adequately covered.*');
    expect(elements[9].group).toBe('2: The teacher was well-prepared for each class.*');
    // The label is what gets clicked
    expect(document.querySelector('[data-tabi-id="4"]')!.tagName).toBe('LABEL');
    expect(text).toContain('── 2: The teacher was well-prepared for each class.* ──');
  });

  it('still lists a visible radio itself, and never twice', () => {
    document.body.innerHTML = '<label><input type="radio" name="a" value="y"> Yes</label><label><input type="radio" name="a" value="n"> No</label>';
    const { elements } = createDOMSnapshot();
    expect(elements.map((e) => e.label)).toEqual(['Yes', 'No']);
    expect(document.querySelector('[data-tabi-id="0"]')!.tagName).toBe('INPUT');
  });
});
