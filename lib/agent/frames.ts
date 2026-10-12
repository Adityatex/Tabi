// Page snapshots that include cross-origin iframes (e.g. Stripe-style payment
// forms). The top page can't read those frames, but Tabi's frame content
// script runs inside every frame (entrypoints/frame.content.ts) and can.
//
// Pairing an <iframe> element with Chrome's frame id: post a random token into
// each unreadable iframe, then the background asks every frame which token it
// holds (chrome.scripting.executeScript with allFrames).

import {
  collectLocalElements, addRemoteElements, renderSnapshot,
  type FrameSnapshot, type OpaqueFrame, type SnapshotElement, type SnapshotParts,
} from '@/lib/agent/domSnapshot';

export const FRAME_TOKEN_MESSAGE = 'tabi-frame-token';
/** Time for the frames' content scripts to receive their tokens. */
const HANDSHAKE_WAIT_MS = 80;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

interface FrameResult {
  token: string;
  frameId: number;
  snapshot: FrameSnapshot | null;
}

async function addCrossOriginFrames(parts: SnapshotParts): Promise<void> {
  const byToken = new Map<string, OpaqueFrame>();
  for (const frame of parts.opaqueFrames) {
    const token = crypto.randomUUID();
    byToken.set(token, frame);
    // The token only identifies the frame; it grants nothing
    frame.iframe.contentWindow?.postMessage({ type: FRAME_TOKEN_MESSAGE, token }, '*');
  }
  await sleep(HANDSHAKE_WAIT_MS);

  const res = await browser.runtime.sendMessage({ action: 'FRAME_SNAPSHOTS', payload: { tokens: [...byToken.keys()] } });
  if (!res?.success) return;
  for (const { token, frameId, snapshot } of res.data as FrameResult[]) {
    const frame = byToken.get(token);
    if (frame && snapshot) addRemoteElements(parts, frame, frameId, snapshot);
  }
}

/**
 * Snapshot of the whole page for the agent: this document, its shadow roots
 * and same-origin iframes, plus any cross-origin iframes Tabi can reach.
 */
export async function createPageSnapshot(): Promise<{ text: string; elements: SnapshotElement[] }> {
  const parts = collectLocalElements();
  if (parts.opaqueFrames.length > 0) {
    try {
      await addCrossOriginFrames(parts);
    } catch (err) {
      // Still give the model the rest of the page
      console.warn('[Tabi] Could not read cross-origin frames:', err);
    }
  }
  return renderSnapshot(parts);
}
