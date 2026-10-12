import { describe, it, expect, afterEach } from 'vitest';
import { EDITOR_MARK, codeEditorRoot, judgePaste, sameCode, setCodeInPage, visibleCode } from '@/lib/agent/codeEditor';

afterEach(() => {
  document.body.innerHTML = '';
  delete (window as any).monaco;
});

const CODE = 'class S {\n    int f() {\n        return 1;\n    }\n};';

describe('codeEditorRoot', () => {
  it('finds the editor around its hidden input, or the one inside a wrapper', () => {
    document.body.innerHTML = '<div id="wrap"><div class="monaco-editor"><textarea id="t"></textarea></div></div><textarea id="plain"></textarea>';
    const root = document.querySelector('.monaco-editor');
    expect(codeEditorRoot(document.getElementById('t')!)).toBe(root);
    expect(codeEditorRoot(document.getElementById('wrap')!)).toBe(root);
    expect(codeEditorRoot(document.getElementById('plain')!)).toBeNull();
  });
});

describe('setCodeInPage', () => {
  it('replaces or appends through Monaco when the page exposes it', () => {
    document.body.innerHTML = `<div id="host"><div class="monaco-editor" ${EDITOR_MARK}><textarea></textarea></div></div>`;
    let value = 'old\n';
    const model = {
      getValue: () => value,
      getLineCount: () => value.split('\n').length,
      getLineMaxColumn: (n: number) => value.split('\n')[n - 1].length + 1,
      getFullModelRange: () => 'all',
    };
    const editor = {
      getDomNode: () => document.getElementById('host'),
      getModel: () => model,
      executeEdits: (_: string, [edit]: { range: unknown; text: string }[]) => { value = edit.range === 'all' ? edit.text : value + edit.text; },
    };
    (window as any).monaco = { editor: { getEditors: () => [editor], getModels: () => [model] } };

    expect(setCodeInPage(EDITOR_MARK, null, false)).toEqual({ ok: true, value: 'old\n' });
    expect(setCodeInPage(EDITOR_MARK, CODE, true)).toEqual({ ok: true, value: CODE });
    expect(setCodeInPage(EDITOR_MARK, '// end', false)).toEqual({ ok: true, value: CODE + '// end' });
  });

  it('uses CodeMirror 5 and Ace', () => {
    document.body.innerHTML = `<div class="CodeMirror" ${EDITOR_MARK}></div>`;
    let cm = 'a';
    (document.querySelector('.CodeMirror') as any).CodeMirror = { getValue: () => cm, setValue: (v: string) => { cm = v; }, lastLine: () => 0, replaceRange: (t: string) => { cm += t; } };
    expect(setCodeInPage(EDITOR_MARK, CODE, true)).toEqual({ ok: true, value: CODE });

    document.body.innerHTML = `<div class="ace_editor" ${EDITOR_MARK}></div>`;
    let ace = '';
    (document.querySelector('.ace_editor') as any).env = { editor: { getValue: () => ace, setValue: (v: string) => { ace = v; } } };
    expect(setCodeInPage(EDITOR_MARK, CODE, true)).toEqual({ ok: true, value: CODE });
  });

  it('pastes when the page hides its editor: select all, then the code as one paste', () => {
    document.body.innerHTML = `<div class="monaco-editor" ${EDITOR_MARK}><textarea></textarea></div>`;
    const seen: string[] = [];
    const input = document.querySelector('textarea')!;
    input.addEventListener('keydown', (e) => seen.push(`${e.ctrlKey || e.metaKey ? 'mod+' : ''}${e.keyCode}`));
    input.addEventListener('paste', (e) => seen.push(`paste:${(e as ClipboardEvent).clipboardData?.getData('text/plain')}`));

    expect(setCodeInPage(EDITOR_MARK, null, false)).toMatchObject({ ok: false });
    expect(seen).toEqual([]); // reading never pastes
    expect(setCodeInPage(EDITOR_MARK, CODE, true)).toEqual({ ok: true, pasted: true });
    expect(seen).toEqual(['mod+65', `paste:${CODE}`]);
  });
});

describe('reading a pasted editor back', () => {
  it('reads Monaco lines in screen order', () => {
    document.body.innerHTML = '<div class="monaco-editor"><div class="view-line" style="top: 19px">b</div><div class="view-line" style="top: 0px">a&nbsp;=&nbsp;1</div></div>';
    expect(visibleCode(document.querySelector('.monaco-editor')!)).toBe('a = 1\nb');
  });

  it('tells the code alone, its end in view, mixed with other lines, or missing', () => {
    expect(judgePaste(CODE.replace(/\n/g, '\r\n') + '\n', CODE, true)).toBe('exact');
    expect(judgePaste(CODE.split('\n').slice(2).join('\n'), CODE, true)).toBe('end');
    expect(judgePaste(`${CODE}\n    }\n};`, CODE, true)).toBe('mixed');
    expect(judgePaste('class Old {\n};', CODE, true)).toBe('missing');
    expect(sameCode('a  \r\nb\n', 'a\nb')).toBe(true);
  });
});
