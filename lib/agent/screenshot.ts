// Screenshots for vision models (background service worker only). The page is
// captured, the image shrunk, and each numbered element outlined with its
// snapshot ID ("set of marks"), so the model can match what it sees to the IDs
// it acts on. The marks are drawn on the image, never on the page.

import type { Mark } from '@/lib/agent/domSnapshot';

/** What the content script reports alongside a snapshot (AGENT_SNAPSHOT with visual). */
export interface VisualInfo {
  marks: Mark[];
  /** Viewport size in CSS pixels. */
  viewport: { width: number; height: number };
}

/** Width of the image sent to the model, in pixels. */
const SCREENSHOT_WIDTH = 1024;

const COLORS = ['#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4', '#008080', '#9a6324', '#800000'];

export interface Layout {
  /** Source rectangle in the captured bitmap (device pixels). */
  sx: number; sy: number; sw: number; sh: number;
  /** Output size. */
  width: number; height: number;
  /** Output pixels per CSS pixel. */
  scale: number;
}

/** How big to make the output: no wider than SCREENSHOT_WIDTH, never enlarged. */
export function layoutFor(info: VisualInfo, bitmapWidth: number, bitmapHeight: number, maxWidth = SCREENSHOT_WIDTH): Layout {
  const ratio = bitmapWidth / info.viewport.width; // device pixel ratio of the capture
  const cssWidth = info.viewport.width;
  const sw = Math.round(cssWidth * ratio);
  const sh = bitmapHeight;
  const scale = Math.min(maxWidth / cssWidth, ratio);
  return { sx: 0, sy: 0, sw, sh, width: Math.round(cssWidth * scale), height: Math.round((sh / ratio) * scale), scale };
}

/** Draw the capture cropped, shrunk and marked; returns a JPEG data URL. */
export async function annotate(captured: Blob, info: VisualInfo): Promise<string> {
  const bitmap = await createImageBitmap(captured);
  const l = layoutFor(info, bitmap.width, bitmap.height);
  const canvas = new OffscreenCanvas(l.width, l.height);
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(bitmap, l.sx, l.sy, l.sw, l.sh, 0, 0, l.width, l.height);
  bitmap.close();

  ctx.font = 'bold 12px sans-serif';
  ctx.lineWidth = 2;
  for (const m of info.marks) {
    const x = m.x * l.scale;
    const y = m.y * l.scale;
    if (x >= l.width || y >= l.height) continue; // below the fold
    const color = COLORS[m.id % COLORS.length];
    ctx.strokeStyle = color;
    ctx.strokeRect(x, y, m.w * l.scale, m.h * l.scale);
    const label = String(m.id);
    const tw = ctx.measureText(label).width + 6;
    // Label just above the box's corner, or inside it at the top of the image
    const ly = y >= 15 ? y - 15 : y;
    ctx.fillStyle = color;
    ctx.fillRect(x, ly, tw, 15);
    ctx.fillStyle = '#fff';
    ctx.fillText(label, x + 3, ly + 12);
  }

  const out = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.7 });
  return blobToDataUrl(out);
}

async function blobToDataUrl(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:${blob.type};base64,${btoa(binary)}`;
}

/** base64 (e.g. from the DevTools Protocol) → Blob */
export function base64ToBlob(base64: string, type = 'image/jpeg'): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type });
}
