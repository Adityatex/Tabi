import { describe, it, expect, beforeEach, vi } from 'vitest';
import { executeAction } from '@/lib/agent/actionExecutor';

// happy-dom has no layout; the executor only needs these to not throw.
beforeEach(() => {
  document.body.innerHTML = '';
  Element.prototype.scrollIntoView = vi.fn();
});

describe('click', () => {
  it('fires exactly one click event', async () => {
    document.body.innerHTML = '<button data-tabi-id="0">Go</button>';
    const onClick = vi.fn();
    document.querySelector('button')!.addEventListener('click', onClick);

    await executeAction({ action: 'click', elementId: 0 });

    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('toggles a checkbox exactly once', async () => {
    document.body.innerHTML = '<input type="checkbox" data-tabi-id="0">';
    await executeAction({ action: 'click', elementId: 0 });
    expect(document.querySelector<HTMLInputElement>('input')!.checked).toBe(true);
  });

  it('fires mousedown before click for custom widgets', async () => {
    document.body.innerHTML = '<div role="button" data-tabi-id="0">Menu</div>';
    const events: string[] = [];
    const el = document.querySelector('div')!;
    for (const type of ['pointerdown', 'mousedown', 'mouseup', 'click']) {
      el.addEventListener(type, () => events.push(type));
    }
    await executeAction({ action: 'click', elementId: 0 });
    expect(events).toEqual(['pointerdown', 'mousedown', 'mouseup', 'click']);
  });
});

describe('press_key Enter', () => {
  it('submits the enclosing form via requestSubmit', async () => {
    document.body.innerHTML = '<form><input name="q" data-tabi-id="0"></form>';
    const onSubmit = vi.fn((e: Event) => e.preventDefault());
    document.querySelector('form')!.addEventListener('submit', onSubmit);

    const result = await executeAction({ action: 'press_key', key: 'Enter', elementId: 0 });

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(result).toMatch(/submitted the form/);
  });

  it('does not submit when the page handled the keydown itself', async () => {
    document.body.innerHTML = '<form><input name="q" data-tabi-id="0"></form>';
    const onSubmit = vi.fn((e: Event) => e.preventDefault());
    document.querySelector('form')!.addEventListener('submit', onSubmit);
    document.querySelector('input')!.addEventListener('keydown', e => e.preventDefault());

    await executeAction({ action: 'press_key', key: 'Enter', elementId: 0 });

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('does not submit from a textarea', async () => {
    document.body.innerHTML = '<form><textarea data-tabi-id="0"></textarea></form>';
    const onSubmit = vi.fn((e: Event) => e.preventDefault());
    document.querySelector('form')!.addEventListener('submit', onSubmit);

    await executeAction({ action: 'press_key', key: 'Enter', elementId: 0 });

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('sets legacy keyCode for sites that check e.keyCode === 13', async () => {
    document.body.innerHTML = '<input data-tabi-id="0">';
    let keyCode = -1;
    document.querySelector('input')!.addEventListener('keydown', e => { keyCode = e.keyCode; });
    await executeAction({ action: 'press_key', key: 'Enter', elementId: 0 });
    expect(keyCode).toBe(13);
  });
});

describe('select', () => {
  const html = `
    <select data-tabi-id="0">
      <option value="">Choose…</option>
      <option value="IN">India</option>
      <option value="US">United States</option>
    </select>`;

  it('matches by visible label', async () => {
    document.body.innerHTML = html;
    const onChange = vi.fn();
    document.querySelector('select')!.addEventListener('change', onChange);

    const result = await executeAction({ action: 'select', elementId: 0, value: 'united states' });

    expect(document.querySelector('select')!.value).toBe('US');
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(result).toMatch(/Selected "United States"/);
  });

  it('matches by option value', async () => {
    document.body.innerHTML = html;
    await executeAction({ action: 'select', elementId: 0, value: 'IN' });
    expect(document.querySelector('select')!.value).toBe('IN');
  });

  it('reports the available options instead of clearing the field', async () => {
    document.body.innerHTML = html;
    document.querySelector('select')!.value = 'IN';

    const result = await executeAction({ action: 'select', elementId: 0, value: 'Canada' });

    expect(result).toMatch(/No option matching "Canada"/);
    expect(result).toMatch(/"India"/);
    expect(document.querySelector('select')!.value).toBe('IN');
  });
});

describe('type / clear_and_type', () => {
  it('appends to an input and confirms the value', async () => {
    document.body.innerHTML = '<input data-tabi-id="0" value="foo">';
    const result = await executeAction({ action: 'type', elementId: 0, text: 'bar' });
    expect(document.querySelector('input')!.value).toBe('foobar');
    expect(result).toMatch(/^✅ Typed "bar"/);
  });

  it('reports failure when the page rejects the input instead of claiming success', async () => {
    document.body.innerHTML = '<input data-tabi-id="0">';
    const input = document.querySelector('input')!;
    input.addEventListener('input', () => { input.value = ''; }); // e.g. a validator that clears it
    const result = await executeAction({ action: 'type', elementId: 0, text: 'hello' });
    expect(result).toMatch(/^❌ Typing "hello" .* did not stick/);
  });

  it('types into a contenteditable editor', async () => {
    document.body.innerHTML = '<div contenteditable="true" data-tabi-id="0"></div>';
    const onInput = vi.fn();
    const editor = document.querySelector('div')!;
    editor.addEventListener('input', onInput);

    const result = await executeAction({ action: 'type', elementId: 0, text: 'Hello team' });

    expect(editor.textContent).toContain('Hello team');
    expect(onInput).toHaveBeenCalled();
    expect(result).toMatch(/^✅ Typed "Hello team" into editor/);
  });

  it('clear_and_type replaces an editor\'s content', async () => {
    document.body.innerHTML = '<div contenteditable="true" data-tabi-id="0">old draft</div>';
    await executeAction({ action: 'clear_and_type', elementId: 0, text: 'new text' });
    expect(document.querySelector('div')!.textContent).toBe('new text');
  });

  it('refuses to "type" into something that is not a text field', async () => {
    document.body.innerHTML = '<button data-tabi-id="0">Send</button>';
    const result = await executeAction({ action: 'type', elementId: 0, text: 'hi' });
    expect(result).toMatch(/^❌ Element \[0\] <button> is not a text field/);
  });
});

describe('select on custom (ARIA) dropdowns', () => {
  beforeEach(() => {
    // happy-dom has no layout; give elements a size so visibility checks pass
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(
      { x: 0, y: 0, width: 100, height: 20, top: 0, left: 0, right: 100, bottom: 20, toJSON: () => ({}) },
    );
  });

  function mountCombobox() {
    document.body.innerHTML = `
      <div id="combo" role="combobox" aria-controls="plans" aria-expanded="false" data-tabi-id="0">Select a plan</div>
      <ul id="plans" role="listbox" style="display:none">
        <li role="option" data-value="free">Free</li>
        <li role="option" data-value="pro">Pro</li>
      </ul>`;
    const combo = document.getElementById('combo')!;
    const list = document.getElementById('plans')!;
    combo.addEventListener('click', () => { list.style.display = list.style.display === 'none' ? '' : 'none'; });
    list.addEventListener('click', e => {
      const opt = (e.target as Element).closest('[role=option]')!;
      opt.setAttribute('aria-selected', 'true');
      combo.textContent = opt.textContent!;
      list.style.display = 'none';
    });
    return combo;
  }

  it('opens the dropdown, clicks the matching option and confirms it', async () => {
    const combo = mountCombobox();
    const result = await executeAction({ action: 'select', elementId: 0, value: 'pro' });
    expect(combo.textContent).toBe('Pro');
    expect(result).toBe('✅ Selected "Pro" in dropdown [0]');
  });

  it('lists the real options when nothing matches', async () => {
    mountCombobox();
    const result = await executeAction({ action: 'select', elementId: 0, value: 'Enterprise' });
    expect(result).toMatch(/No option matching "Enterprise".*"Free", "Pro"/);
  });

  it('says so when the element opens no list', async () => {
    document.body.innerHTML = '<button data-tabi-id="0">Continue</button>';
    const result = await executeAction({ action: 'select', elementId: 0, value: 'Pro' });
    expect(result).toMatch(/^❌ Element \[0\] is not a dropdown/);
  });
});

describe('note', () => {
  it('records the note in its result, which is what carries it across pages', async () => {
    expect(await executeAction({ action: 'note', text: 'Kite 14: 16 GB, $1,049' })).toBe('📝 Noted: Kite 14: 16 GB, $1,049');
    expect(await executeAction({ action: 'note', text: '  ' })).toMatch(/^❌ note needs text/);
  });
});

describe('date and time fields', () => {
  it('sets a date in the field’s own format, whatever the locale would show', async () => {
    document.body.innerHTML = '<input type="date" data-tabi-id="0">';
    const result = await executeAction({ action: 'type', elementId: 0, text: '2026-10-07' });
    expect(document.querySelector<HTMLInputElement>('input')!.value).toBe('2026-10-07');
    expect(result).toContain('✅');
  });

  it('says which format to use when the date is written another way', async () => {
    document.body.innerHTML = '<input type="date" data-tabi-id="0">';
    const result = await executeAction({ action: 'type', elementId: 0, text: '07/10/2026' });
    expect(result).toBe('❌ Element [0] is a date field: type the value as YYYY-MM-DD, e.g. 2026-10-07.');
    expect(document.querySelector<HTMLInputElement>('input')!.value).toBe('');
  });

  it('sets a time in 24 hours', async () => {
    document.body.innerHTML = '<input type="time" data-tabi-id="0">';
    await executeAction({ action: 'clear_and_type', elementId: 0, text: '14:30' });
    expect(document.querySelector<HTMLInputElement>('input')!.value).toBe('14:30');
  });
});
