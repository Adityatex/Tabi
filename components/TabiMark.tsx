// The Tabi mark: an abstract footprint (a toe and a sole, tilted 15°), the
// product being built around steps. It moves to show what Tabi is doing:
// walks while acting, taps its toe while thinking, stops mid-step in amber
// when it needs you. All motion stops under prefers-reduced-motion.

import type { CSSProperties } from 'react';

export type TabiMarkState = 'idle' | 'reading' | 'thinking' | 'acting' | 'waiting' | 'done' | 'failed' | 'stopped';

/** Colour by state; the fallbacks are the light theme's tokens. */
const COLOR: Record<TabiMarkState, string> = {
  idle: 'var(--accent, #2B45D8)',
  reading: 'var(--accent, #2B45D8)',
  thinking: 'var(--accent, #2B45D8)',
  acting: 'var(--accent, #2B45D8)',
  waiting: 'var(--amber, #995000)',
  done: 'var(--green, #1F7A3D)',
  failed: 'var(--red, #C2271D)',
  stopped: 'var(--muted, #5F5F5B)',
};

/** Fractions of the size: left, top, width, height. Both shapes are capsules. */
const TOE = [0.11, 0.24, 0.27, 0.34];
const SOLE = [0.44, 0.08, 0.43, 0.84];
const TILT = 15;

const KEYFRAMES = `
@keyframes tb-breathe { 0%,100% { transform: scale(.92); opacity: .85 } 50% { transform: scale(1); opacity: 1 } }
@keyframes tb-scan { 0% { clip-path: inset(0 0 100% 0) } 55% { clip-path: inset(0); opacity: 1 } 100% { clip-path: inset(0); opacity: 0 } }
@keyframes tb-tap { 0%,36%,100% { transform: translateY(0) } 9%,27% { transform: translateY(-28%) } 18% { transform: translateY(0) } }
@keyframes tb-step { 0% { opacity: 0; transform: translateY(12%) } 18% { opacity: 1; transform: translateY(0) } 55% { opacity: 1 } 80%,100% { opacity: 0; transform: translateY(-8%) } }
@keyframes tb-wait { 0%,100% { opacity: 1 } 50% { opacity: .5 } }
@keyframes tb-land { 0% { transform: translateY(-16%) scale(.9); opacity: .3 } 100% { transform: none; opacity: 1 } }
@keyframes tb-shake { 0%,100% { transform: translateX(0) } 25% { transform: translateX(-6%) } 75% { transform: translateX(6%) } }
@media (prefers-reduced-motion: reduce) { [data-tabi-mark], [data-tabi-mark] * { animation: none !important; transition: none !important } }
`;

const fill: CSSProperties = { position: 'absolute', inset: 0 };

interface Props {
  state?: TabiMarkState;
  /** Width and height in px. */
  size?: number;
  /** A colour for every state, e.g. on a coloured background. */
  color?: string;
  /** What a screen reader says; '' when the mark sits next to the word "Tabi". */
  label?: string;
}

export default function TabiMark({ state = 'idle', size = 20, color, label }: Props) {
  const c = color ?? COLOR[state];
  const capsule = ([left, top, width, height]: number[], extra?: CSSProperties): CSSProperties => ({
    position: 'absolute', left: left * size, top: top * size, width: width * size, height: height * size,
    borderRadius: (width * size) / 2, background: c, ...extra,
  });
  /** One footprint; `toe` moves the toe on its own (tapping, lifted, knocked aside). */
  const print = (key: string, style?: CSSProperties, toe?: CSSProperties) => (
    <div key={key} style={{ ...fill, ...style }}>
      <div style={{ ...fill, transform: `rotate(${TILT}deg)` }}>
        <div style={capsule(TOE, toe)} />
        <div style={capsule(SOLE)} />
      </div>
    </div>
  );

  let layers;
  switch (state) {
    case 'idle': layers = print('p', { animation: 'tb-breathe 4s ease-in-out infinite' }); break;
    // The fill scans top to bottom over a faint copy
    case 'reading': layers = [print('ghost', { opacity: 0.25 }), print('scan', { animation: 'tb-scan 1.6s ease-in-out infinite' })]; break;
    case 'thinking': layers = print('p', undefined, { animation: 'tb-tap 1.2s ease-in-out infinite' }); break;
    // Walks: a left and a right print fade in turn
    case 'acting': layers = [
      <div key="l" style={{ ...fill, animation: 'tb-step 1s ease-in-out infinite' }}>
        {print('pl', { transform: 'translate(-14%,10%) scale(-.72,.72)' })}
      </div>,
      <div key="r" style={{ ...fill, opacity: 0, animation: 'tb-step 1s ease-in-out -.5s infinite' }}>
        {print('pr', { transform: 'translate(14%,-10%) scale(.72)' })}
      </div>,
    ]; break;
    case 'waiting': layers = print('p', { animation: 'tb-wait 1.4s ease-in-out infinite' }, { transform: 'translateY(-22%)' }); break;
    case 'done': layers = print('p', { animation: 'tb-land .3s cubic-bezier(.2,.8,.3,1) 1' }); break;
    case 'failed': layers = print('p', { animation: 'tb-shake .32s ease-in-out 1' }, { transform: 'translate(-12%,22%) rotate(-24deg)' }); break;
    default: layers = print('p');
  }

  const spoken = label ?? `Tabi: ${state}`;
  return (
    <div
      data-tabi-mark=""
      role={spoken ? 'img' : undefined}
      aria-label={spoken || undefined}
      aria-hidden={spoken ? undefined : true}
      style={{ position: 'relative', width: size, height: size, flex: 'none' }}
    >
      {/* React hoists this once per document or shadow root */}
      <style href="tabi-mark" precedence="default">{KEYFRAMES}</style>
      {layers}
    </div>
  );
}
