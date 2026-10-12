// The on-page cue, shown only while a task runs in this tab: a soft glow
// around the page edge, a small pill in the bottom-left corner ("Tabi is
// working · Stop"), and a thin outline on the element being acted on. All
// three turn amber when Tabi needs the user. The pill can be dragged, and it
// moves out of the way of anything the agent is about to click.
//
// It lives in a closed shadow root on <html>, outside <body>: page styles
// can't reach it, and the agent's page snapshot and text never include it.
// Only the pill takes the mouse; the glow and outline let clicks through.

import type { RunView } from '@/lib/agent/runner';

export type CueState =
  | { mode: 'running'; target?: number }
  | { mode: 'needs'; kind: 'ask' | 'pause'; target?: number }
  | null;

/** What the cue shows for a run: working, needs the user, or nothing (not running here). */
export function cueOf(view: Pick<RunView, 'status' | 'asking' | 'target'> | null | undefined): CueState {
  if (!view) return null;
  const target = view.target !== undefined ? { target: view.target } : {};
  if (view.status === 'running') return { mode: 'running', ...target };
  if (view.status === 'paused') return { mode: 'needs', kind: view.asking ? 'ask' : 'pause', ...target };
  return null;
}

/** Gap kept between the pill and the viewport edge, and around a target. */
const EDGE = 20;
const CLEAR = 8;

const CSS = `
:host { all: initial; }
.root {
  --accent: #2B45D8; --raised: #FFFFFF; --bg: #F6F6F4; --border: #E3E3DF; --text: #121212; --muted: #5F5F5B;
  --amber: #995000; --amber-bg: #FFF1D9; --amber-line: #E9A23E; --amber-solid: #FFB23F; --amber-on: #241500;
  font: 500 12.5px/1.4 'Geist Variable', Geist, system-ui, -apple-system, 'Segoe UI', sans-serif;
  -webkit-font-smoothing: antialiased;
}
@media (prefers-color-scheme: dark) {
  .root { --accent: #8394FF; --raised: #202023; --bg: #0F0F10; --border: #2D2D31; --text: #F1F1EF; --muted: #9D9DA4;
    --amber: #FFB547; --amber-bg: #2A1F0C; --amber-line: #8F6420; }
}
.glow { position: fixed; inset: 0; pointer-events: none;
  box-shadow: inset 0 0 0 2px rgba(43,69,216,.6), inset 0 0 28px 4px rgba(43,69,216,.32);
  animation: cue-glow 2.4s ease-in-out infinite; }
.needs .glow { box-shadow: inset 0 0 0 2px rgba(233,162,62,.9), inset 0 0 30px 6px rgba(255,178,63,.45); animation-duration: 1.4s; }
@keyframes cue-glow { 0%, 100% { opacity: .75 } 50% { opacity: 1 } }
.outline { position: fixed; pointer-events: none; display: none; border: 2px solid var(--accent); border-radius: 6px; box-sizing: border-box; }
.needs .outline { border-color: var(--amber-solid); }
.pill { position: fixed; left: ${EDGE}px; bottom: ${EDGE}px; display: flex; align-items: center; gap: 9px; height: 36px; box-sizing: border-box;
  padding: 0 5px 0 8px; border-radius: 999px; background: var(--raised); color: var(--text); border: 1px solid var(--border);
  box-shadow: 0 8px 24px rgba(0,0,0,.16); pointer-events: auto; white-space: nowrap; user-select: none; }
.pill.right { left: auto; right: ${EDGE}px; }
.pill.placed { left: var(--x); top: var(--y); right: auto; bottom: auto; }
.pill.out { visibility: hidden; }
.needs .pill { background: var(--amber-bg); border-color: var(--amber-line); color: var(--amber); font-weight: 600; }
.grip { display: grid; place-items: center; color: var(--muted); cursor: grab; touch-action: none; padding: 4px 0; }
.needs .grip { color: var(--amber); opacity: .7; }
.grip:active { cursor: grabbing; }
.mark { position: relative; width: 15px; height: 15px; transform: rotate(15deg); flex: none; }
.mark i { position: absolute; background: var(--accent); }
.needs .mark i { background: var(--amber); }
button { all: unset; box-sizing: border-box; display: flex; align-items: center; gap: 4px; height: 26px; padding: 0 10px; border-radius: 999px;
  font: inherit; font-size: 12px; cursor: pointer; background: var(--bg); color: var(--text); border: 1px solid var(--border); }
button:hover { border-color: var(--muted); }
button:disabled { opacity: .5; cursor: default; }
button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.needs button { background: var(--amber-solid); color: var(--amber-on); border-color: transparent; padding: 0 11px; font-weight: 600; }
@media (prefers-reduced-motion: reduce) { .glow { animation: none; } }
`;

const GRIP = '<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="9" cy="5" r="1.6"/><circle cx="15" cy="5" r="1.6"/><circle cx="9" cy="12" r="1.6"/><circle cx="15" cy="12" r="1.6"/><circle cx="9" cy="19" r="1.6"/><circle cx="15" cy="19" r="1.6"/></svg>';
const SQUARE = '<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><rect x="1" y="1" width="8" height="8" rx="1.5" fill="currentColor"/></svg>';
/** The Tabi mark (components/TabiMark.tsx), still: a toe and a sole, as fractions of 15px. */
const MARK = [[0.11, 0.24, 0.27, 0.34], [0.44, 0.08, 0.43, 0.84]]
  .map(([l, t, w, h]) => `<i style="left:${l * 15}px;top:${t * 15}px;width:${w * 15}px;height:${h * 15}px;border-radius:${(w * 15) / 2}px"></i>`).join('');

export interface PageCue {
  /** Show what the run is doing, or nothing. */
  set(state: CueState): void;
  /** Move the pill off this element before it's clicked; hide it if there's nowhere to go. */
  avoid(el: Element | null): void;
  /** Leave the page alone for a moment (a screenshot for the model is being taken). */
  hideFor(ms: number): void;
  destroy(): void;
}

export function createPageCue(opts: {
  onStop: () => void;
  onReview: () => void;
  find: (id: number) => Element | null;
  doc?: Document;
}): PageCue {
  const doc = opts.doc ?? document;
  const win = doc.defaultView ?? window;
  const host = doc.createElement('tabi-cue');
  host.setAttribute('style', 'all: initial; position: fixed; inset: 0; z-index: 2147483647; pointer-events: none;');
  const shadow = host.attachShadow({ mode: 'closed' });
  shadow.innerHTML = `<style>${CSS}</style>
    <div class="root">
      <div class="glow"></div>
      <div class="outline"></div>
      <div class="pill" role="status">
        <span class="grip" title="Drag to move">${GRIP}</span>
        <span class="mark" aria-hidden="true">${MARK}</span>
        <span class="label"></span>
        <button type="button"></button>
      </div>
    </div>`;
  const root = shadow.querySelector('.root') as HTMLElement;
  const outline = shadow.querySelector('.outline') as HTMLElement;
  const pill = shadow.querySelector('.pill') as HTMLElement;
  const label = shadow.querySelector('.label') as HTMLElement;
  const button = shadow.querySelector('button') as HTMLButtonElement;
  const grip = shadow.querySelector('.grip') as HTMLElement;

  let state: CueState = null;
  /** Stop was pressed: the run ends once the step or model call under way finishes. */
  let stopping = false;
  let hiddenUntil = 0;
  let unhide: ReturnType<typeof setTimeout> | undefined;
  let frame = 0;

  button.addEventListener('click', (e) => {
    e.stopPropagation();
    if (state?.mode === 'needs') return opts.onReview();
    if (stopping) return;
    stopping = true;
    opts.onStop();
    render();
  });

  // Drag by the grip; the pill then stays where it was put
  grip.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    const box = pill.getBoundingClientRect();
    const dx = e.clientX - box.left;
    const dy = e.clientY - box.top;
    grip.setPointerCapture?.(e.pointerId);
    const move = (ev: PointerEvent) => {
      const x = Math.min(Math.max(0, ev.clientX - dx), win.innerWidth - box.width);
      const y = Math.min(Math.max(0, ev.clientY - dy), win.innerHeight - box.height);
      pill.style.setProperty('--x', `${x}px`);
      pill.style.setProperty('--y', `${y}px`);
      pill.classList.add('placed');
      pill.classList.remove('right');
    };
    const up = () => {
      grip.removeEventListener('pointermove', move);
      grip.removeEventListener('pointerup', up);
      grip.removeEventListener('pointercancel', up);
    };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', up);
    grip.addEventListener('pointercancel', up);
  });

  /** Keep the outline on the target as the page scrolls and moves. */
  const track = () => {
    frame = 0;
    const el = state?.target !== undefined ? opts.find(state.target) : null;
    const r = el?.getBoundingClientRect();
    if (!r || (r.width === 0 && r.height === 0) || r.bottom < 0 || r.top > win.innerHeight) {
      outline.style.display = 'none';
    } else {
      const pad = 4; // a 2px outline, 2px off the element
      Object.assign(outline.style, {
        display: 'block', left: `${r.left - pad}px`, top: `${r.top - pad}px`, width: `${r.width + pad * 2}px`, height: `${r.height + pad * 2}px`,
      });
    }
    if (state?.target !== undefined) frame = win.requestAnimationFrame(track);
  };

  const overlaps = (a: DOMRect, b: DOMRect) =>
    a.left < b.right + CLEAR && a.right > b.left - CLEAR && a.top < b.bottom + CLEAR && a.bottom > b.top - CLEAR;

  const avoid = (el: Element | null) => {
    pill.classList.remove('out');
    if (!el || !state) return;
    const target = el.getBoundingClientRect();
    if (!overlaps(pill.getBoundingClientRect(), target)) return;
    // To the other bottom corner (a placed pill goes back to the corners)
    const wasRight = pill.classList.contains('right') && !pill.classList.contains('placed');
    pill.classList.remove('placed');
    pill.classList.toggle('right', !wasRight);
    if (overlaps(pill.getBoundingClientRect(), target)) {
      pill.classList.toggle('right', wasRight);
      if (overlaps(pill.getBoundingClientRect(), target)) pill.classList.add('out'); // nowhere clear: out of the way until the next update
    }
  };

  const render = () => {
    if (!state || Date.now() < hiddenUntil) {
      host.remove();
      if (frame) win.cancelAnimationFrame(frame);
      frame = 0;
      return;
    }
    if (!host.isConnected) doc.documentElement.appendChild(host);
    host.dataset.state = state.mode; // for tests: the shadow root is closed
    root.classList.toggle('needs', state.mode === 'needs');
    if (state.mode !== 'running') stopping = false;
    label.textContent = stopping ? 'Stopping…' : state.mode === 'running' ? 'Tabi is working' : state.kind === 'ask' ? 'Tabi needs your OK' : 'Tabi is waiting for you';
    button.innerHTML = state.mode === 'running' ? `${SQUARE}Stop` : 'Review';
    button.disabled = stopping;
    button.setAttribute('aria-label', state.mode === 'running' ? 'Stop the task' : 'Review in the side panel');
    if (frame) win.cancelAnimationFrame(frame);
    track();
    avoid(state.target !== undefined ? opts.find(state.target) : null);
  };

  return {
    set(next) {
      if (!next) stopping = false;
      state = next;
      render();
    },
    avoid(el) {
      if (state && host.isConnected) avoid(el);
    },
    hideFor(ms) {
      hiddenUntil = Date.now() + ms;
      render();
      clearTimeout(unhide);
      unhide = setTimeout(() => { hiddenUntil = 0; render(); }, ms);
    },
    destroy() {
      clearTimeout(unhide);
      state = null;
      render();
    },
  };
}
