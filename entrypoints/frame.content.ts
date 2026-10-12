// Runs inside every iframe so the agent can see and act in cross-origin
// frames (e.g. Stripe-style payment forms) that the top page can't read.
// It does nothing until the top page's agent asks (see lib/agent/frames.ts).

import { createDOMSnapshot, getElementById, pageText, type FrameSnapshot } from '@/lib/agent/domSnapshot';
import { executeAction, setFrameOffset } from '@/lib/agent/actionExecutor';
import { FRAME_TOKEN_MESSAGE } from '@/lib/agent/frames';

export default defineContentScript({
  matches: ['<all_urls>'],
  allFrames: true,
  runAt: 'document_idle',

  main() {
    // The top frame belongs to the main content script (content.ts)
    if (window === window.top) return;

    // Token handshake: the parent page names this frame so the background can
    // match Chrome's frame id to the right <iframe> element
    window.addEventListener('message', (event) => {
      const data = event.data;
      if (event.source !== window.parent || data?.type !== FRAME_TOKEN_MESSAGE || typeof data.token !== 'string') return;
      (globalThis as any).__tabiFrameToken = data.token;
    });

    browser.runtime.onMessage.addListener((message: any, _sender, sendResponse) => {
      if (message?.action === 'FRAME_SNAPSHOT') {
        const { elements } = createDOMSnapshot();
        const rects = elements.map(el => getElementById(el.id)?.getBoundingClientRect());
        const snapshot: FrameSnapshot = {
          elements,
          tops: rects.map(r => r?.top ?? 0),
          boxes: rects.map(r => (r ? { x: r.left, y: r.top, w: r.width, h: r.height } : null)),
          text: pageText(1200),
        };
        sendResponse({ success: true, data: snapshot });
        return;
      }

      if (message?.action === 'FRAME_EXECUTE') {
        // Where this frame sits in the top-level viewport, for trusted clicks
        setFrameOffset(message.payload.offset);
        executeAction(message.payload.action)
          .then(result => sendResponse({ success: true, data: result }))
          .catch(err => sendResponse({ success: false, error: String(err?.message ?? err) }))
          .finally(() => setFrameOffset(null));
        return true; // async response
      }
    });
  },
});
