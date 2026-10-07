// mcp/src/protocol.ts
// The bridge between the tabi-mcp server (Node) and the Tabi extension.
// Shared by both sides; uses only WebCrypto, which Node 20+ and Chrome have.
//
// The server listens on 127.0.0.1; the extension connects to it. Anything on
// this computer could listen on that port, and web pages can open WebSockets
// to localhost, so before any command both sides prove they know the pairing
// token, without sending it:
//   extension → hello {nonce}
//   server    → challenge {proof: HMAC(token, "server:" + nonce), nonce}
//   extension → answer  {proof: HMAC(token, "client:" + nonce)}
//   server    → ready
// Then the server sends requests ({id, method, params}) and the extension
// replies ({id, result} or {id, error}).

export const DEFAULT_PORT = 17354;
export const PROTOCOL_VERSION = 1;

/** What the extension can be asked to do. */
export type BridgeMethod =
  | 'tabs_list'
  | 'tab_open'
  | 'tab_select'
  | 'page_snapshot'
  | 'page_act'
  | 'page_screenshot'
  | 'run_task';

export type BridgeMessage =
  | { type: 'hello'; version: number; nonce: string }
  | { type: 'challenge'; proof: string; nonce: string }
  | { type: 'answer'; proof: string }
  | { type: 'ready' }
  | { type: 'denied'; reason: string }
  | { type: 'request'; id: number; method: BridgeMethod; params: Record<string, unknown> }
  | { type: 'response'; id: number; result?: unknown; error?: string }
  | { type: 'ping' }
  | { type: 'pong' };

const encoder = new TextEncoder();

function hex(bytes: ArrayBuffer | Uint8Array): string {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** A random hex string (pairing tokens, nonces). */
export function randomHex(bytes = 16): string {
  return hex(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** HMAC-SHA256(token, message) as hex. */
export async function hmac(token: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(token), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, encoder.encode(message)));
}

/** Compare two strings without leaking where they differ through timing. */
export function sameString(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Pairing tokens are "tbk_" and 64 hex characters. Proofs use only the hex part. */
export const TOKEN_PREFIX = 'tbk_';

export const serverProof = (token: string, nonce: string) => hmac(tokenSecret(token), `server:${nonce}`);
export const clientProof = (token: string, nonce: string) => hmac(tokenSecret(token), `client:${nonce}`);

/** A new pairing token. */
export const newToken = () => TOKEN_PREFIX + randomHex(32);

/** The token as "tbk_<hex>"; accepts pasted ones with stray whitespace or capitals. */
export const normalizeToken = (token: string) => token.trim().toLowerCase();

const tokenSecret = (token: string) => normalizeToken(token).slice(TOKEN_PREFIX.length);

export function isValidToken(token: string): boolean {
  return /^tbk_[0-9a-f]{64}$/.test(normalizeToken(token));
}
