// Writing into code editors (Monaco on LeetCode and VS Code for the web,
// CodeMirror, Ace). Typing into one goes wrong: every Enter is auto-indented
// and every bracket auto-closed, so code typed as keystrokes comes out
// staircased, with stray brackets. And the hidden <textarea> that takes the
// keystrokes is always empty, so reading it back says nothing about the code.
//
// So set the code through the editor's own API, in the page's main world
// (setCodeInPage, run by the background), and read it back the same way. When
// the page doesn't expose its editor, paste the code instead: editors insert a
// paste as-is, without auto-indenting it.

/** Root elements of the code editors Tabi knows. */
export const CODE_EDITOR_SELECTOR = '.monaco-editor, .cm-editor, .CodeMirror, .ace_editor';

/** Marks the editor the main-world script should act on, while it runs. */
export const EDITOR_MARK = 'data-tabi-code-editor';

/** The code editor `el` belongs to: it's inside one, or it holds exactly one. */
export function codeEditorRoot(el: Element): HTMLElement | null {
  const around = el.closest<HTMLElement>(CODE_EDITOR_SELECTOR);
  if (around) return around;
  const inside = el.querySelectorAll<HTMLElement>(CODE_EDITOR_SELECTOR);
  return inside.length === 1 ? inside[0] : null;
}

/**
 * The code the editor shows. Editors only render the lines on screen, so for
 * long code this is the visible part, not all of it.
 */
export function visibleCode(root: HTMLElement): string {
  const lines = root.querySelectorAll<HTMLElement>('.view-line, .cm-line, .CodeMirror-line, .ace_line');
  const rows = [...lines];
  // Monaco positions its lines absolutely, not in document order
  if (root.classList.contains('monaco-editor')) rows.sort((a, b) => parseFloat(a.style.top) - parseFloat(b.style.top));
  return rows.map((l) => (l.textContent ?? '').replace(/ /g, ' ')).join('\n');
}

/** The editor's whole content, or `pasted` when the page hides its editor and the code went in as a paste. */
export type EditorResult = { ok: true; value: string } | { ok: true; pasted: true } | { ok: false; why: string };

/**
 * Runs in the page's main world (chrome.scripting, world MAIN), so it is
 * self-contained: no imports, no closures. Replaces the code (`clear`) or adds
 * it at the end, then returns the editor's whole content. Without `text`, it
 * only reads.
 *
 * When the page hides its editor, it pastes instead: Ctrl+A (or Ctrl+End), then
 * a paste event. Both are dispatched from here because editors read the key's
 * legacy keyCode, which an isolated-world script can't set on an event.
 */
export function setCodeInPage(mark: string, text: string | null, clear: boolean): EditorResult {
  const root = document.querySelector(`[${mark}]`);
  if (!root) return { ok: false, why: 'editor not found' };
  const w = window as any;

  const paste = (): EditorResult => {
    if (text === null) return { ok: false, why: 'no editor API' };
    const input = root.querySelector<HTMLElement>('textarea, .native-edit-context, .cm-content, [contenteditable="true"]') ?? (root as HTMLElement);
    input.focus();
    const mac = /Mac|iPhone|iPad/.test(navigator.platform);
    const [key, code, keyCode] = clear ? ['a', 'KeyA', 65] : ['End', 'End', 35];
    for (const type of ['keydown', 'keyup']) {
      const event = new KeyboardEvent(type, { key, code, ctrlKey: !mac, metaKey: mac, bubbles: true, cancelable: true, composed: true });
      Object.defineProperty(event, 'keyCode', { get: () => keyCode });
      Object.defineProperty(event, 'which', { get: () => keyCode });
      input.dispatchEvent(event);
    }
    const data = new DataTransfer();
    data.setData('text/plain', text);
    input.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true, composed: true }));
    return { ok: true, pasted: true };
  };

  // Monaco: window.monaco, when the page exposes it
  if (root.classList.contains('monaco-editor')) {
    const api = w.monaco?.editor;
    const editors: any[] = api?.getEditors?.() ?? [];
    const editor = editors.find((e) => { const dom = e.getDomNode?.(); return dom && (dom === root || dom.contains(root) || root.contains(dom)); });
    const models: any[] = api?.getModels?.() ?? [];
    const model = editor?.getModel?.() ?? (models.length === 1 ? models[0] : null);
    if (!model) return paste();
    if (text !== null) {
      const last = model.getLineCount();
      const end = { startLineNumber: last, startColumn: model.getLineMaxColumn(last), endLineNumber: last, endColumn: model.getLineMaxColumn(last) };
      const range = clear ? model.getFullModelRange() : end;
      if (editor) {
        editor.pushUndoStop?.();
        editor.executeEdits('tabi', [{ range, text, forceMoveMarkers: true }]);
        editor.pushUndoStop?.();
        editor.focus?.();
      } else {
        model.pushEditOperations([], [{ range, text }], () => null);
      }
    }
    return { ok: true, value: model.getValue() };
  }

  // CodeMirror 6: the content element points at its view
  if (root.classList.contains('cm-editor')) {
    const content: any = root.querySelector('.cm-content');
    let view: any = null;
    for (let tile = content?.cmView ?? content?.cmTile ?? (root as any).cmView; tile && !view; tile = tile.parent) {
      if (tile.view?.dispatch && tile.view?.state) view = tile.view;
      else if (tile.rootView?.view?.dispatch) view = tile.rootView.view;
    }
    if (!view) return paste();
    if (text !== null) {
      const length = view.state.doc.length;
      view.dispatch({ changes: { from: clear ? 0 : length, to: length, insert: text }, selection: { anchor: (clear ? 0 : length) + text.length } });
      view.focus?.();
    }
    return { ok: true, value: view.state.doc.toString() };
  }

  // CodeMirror 5
  const cm5 = (root as any).CodeMirror;
  if (cm5?.getValue) {
    if (text !== null) {
      if (clear) cm5.setValue(text);
      else cm5.replaceRange(text, { line: cm5.lastLine() + 1, ch: 0 });
      cm5.focus?.();
    }
    return { ok: true, value: cm5.getValue() };
  }

  // Ace
  const ace = (root as any).env?.editor;
  if (ace?.getValue) {
    if (text !== null) {
      if (clear) ace.setValue(text, 1);
      else { ace.navigateFileEnd(); ace.insert(text); }
      ace.focus?.();
    }
    return { ok: true, value: ace.getValue() };
  }
  return paste();
}

/** Line endings and trailing spaces aside, the same code. */
export function sameCode(a: string, b: string): boolean {
  const tidy = (s: string) => s.replace(/\r\n?/g, '\n').split('\n').map((l) => l.trimEnd()).join('\n').trim();
  return tidy(a) === tidy(b);
}

/**
 * How a paste looks from the lines on screen. 'exact': the editor shows just
 * the code. 'end': it shows the code's last lines (all a long paste leaves in
 * view). 'mixed': it shows the code with other lines around it. 'missing': no
 * sign of it.
 */
export function judgePaste(visible: string, text: string, clear: boolean): 'exact' | 'end' | 'mixed' | 'missing' {
  if (clear && sameCode(visible, text)) return 'exact';
  const lines = (s: string) => s.replace(/\r\n?/g, '\n').split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const shown = lines(visible);
  const tail = lines(text).slice(-3);
  const at = shown.findIndex((_, i) => tail.every((l, j) => shown[i + j] === l));
  if (at < 0) return 'missing';
  // Fewer lines on screen than the code has: the start scrolled out of view
  return clear && shown.length >= lines(text).length ? 'mixed' : 'end';
}
