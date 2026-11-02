// Sign in with ChatGPT, the flow for open-source apps
// (developers.openai.com/siwc/token-sharing-open-source): the user signs in on
// auth.openai.com and Tabi's requests then use their ChatGPT plan, through the
// public Responses API. OAuth with PKCE, no client secret; Tabi registers itself
// on the first sign-in and gets a client ID of its own for this browser.
//
// The redirect has to go to http://127.0.0.1. An extension can't listen on a
// port, so the background watches the sign-in window and reads the code when
// it gets there (entrypoints/background.ts). The code never leaves this
// computer, and is useless without the PKCE verifier, which never leaves the
// background.
//
// Tokens are kept under AUTH_KEY in chrome.storage.local, like API keys: only
// the background reads them, and they're never shown, logged or put in a URL.

export const AUTH_ISSUER = 'https://auth.openai.com';
const AUTHORIZE_URL = `${AUTH_ISSUER}/api/accounts/authorize`;
const TOKEN_URL = `${AUTH_ISSUER}/api/accounts/oauth/token`;
const DISCOVERY_URL = `${AUTH_ISSUER}/.well-known/openid-configuration`;
export const API_RESOURCE = 'https://api.openai.com/v1';
/** The client ID that asks OpenAI to register a new client (the first sign-in). */
export const DYNAMIC_CLIENT = 'dynamic_agent_client';
const SCOPES = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
/** The scope that lets requests use the user's plan; signing in alone doesn't. */
const PLAN_SCOPE = 'chatgpt.tokens.use.direct';
export const USAGE_URL = 'https://chatgpt.com/settings/usage';
const APP_NAME = 'Tabi';
/** Refresh this long before the access token (one hour) runs out. */
const REFRESH_EARLY_MS = 2 * 60_000;
/** A sign-in left open longer than this is abandoned. */
export const SIGN_IN_TIMEOUT_MS = 15 * 60_000;

export const AUTH_KEY = 'tabi_chatgpt_auth';
/** The sign-in under way, in chrome.storage.session: it survives the service worker stopping. */
export const PENDING_KEY = 'tabi_chatgpt_pending';

export interface ChatGPTAccount {
  /** The client OpenAI issued Tabi for this account ("oaiapp_…"). */
  clientId: string;
  /** The account's identity, from the verified ID token. */
  sub: string;
  email: string;
  /** The user let Tabi use their plan (OpenAI grants it per plan; without it the account can only sign in). */
  planUsage: boolean;
  scopes: string[];
  accessToken: string;
  refreshToken: string;
  idToken: string;
  expiresAt: number;
  savedAt: number;
}

export interface ChatGPTAuth {
  /** This browser's host ID, sent with every sign-in: opaque, made once. */
  hostId: string;
  account?: ChatGPTAccount;
  /** The last account's client, kept after signing out to sign it in again. */
  lastClient?: { clientId: string; sub: string; email: string };
  /** OpenAI no longer accepts this sign-in (disconnected, or the refresh token is gone). */
  needsSignIn?: boolean;
}

/** A sign-in under way: what the callback is checked against. */
export interface PendingSignIn {
  state: string;
  nonce: string;
  verifier: string;
  redirectUri: string;
  /** DYNAMIC_CLIENT for a new registration, else the saved client. */
  clientId: string;
  hostId: string;
  windowId?: number;
  started: number;
  /** The answer came back and its code is being exchanged: it counts once. */
  answered?: boolean;
}

/** Where the sign-in stands, for Settings (no tokens in it). */
export type SignInStatus =
  | { state: 'idle' }
  | { state: 'waiting' }
  | { state: 'done'; email: string; planUsage: boolean }
  | { state: 'error'; message: string };

/** Why a token couldn't be had: sign in again ('auth'), or try again later ('unavailable'). */
export class ChatGPTAuthError extends Error {
  constructor(message: string, readonly kind: 'auth' | 'unavailable') {
    super(message);
    this.name = 'ChatGPTAuthError';
  }
}

type Fetch = typeof fetch;

// ---------------------------------------------------------------- helpers

function base64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64url(s: string): Uint8Array<ArrayBuffer> {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=');
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

const randomString = (bytes = 32) => base64url(crypto.getRandomValues(new Uint8Array(bytes)));

/** PKCE (RFC 7636): a secret verifier and its SHA-256 challenge. */
export async function pkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = randomString(32);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return { verifier, challenge: base64url(new Uint8Array(digest)) };
}

/** A loopback redirect on a random high port (only the port may differ between sign-ins). */
export function loopbackRedirect(port = 49152 + Math.floor(Math.random() * 16000)): string {
  return `http://127.0.0.1:${port}/auth/callback`;
}

/** The saved state, with a host ID made on first use. */
export function readAuth(stored: Record<string, unknown>): ChatGPTAuth {
  const saved = stored[AUTH_KEY] as ChatGPTAuth | undefined;
  return saved?.hostId ? saved : { hostId: `urn:uuid:${crypto.randomUUID()}` };
}

// ---------------------------------------------------------------- sign in

/** A new sign-in: the URL to open, and what to keep for checking the callback. */
export async function startSignIn(auth: ChatGPTAuth, opts: { fresh?: boolean; redirectUri?: string } = {}): Promise<{ url: string; pending: PendingSignIn }> {
  const { verifier, challenge } = await pkce();
  const last = opts.fresh ? undefined : auth.account ?? auth.lastClient;
  const pending: PendingSignIn = {
    state: randomString(24),
    nonce: randomString(24),
    verifier,
    redirectUri: opts.redirectUri ?? loopbackRedirect(),
    clientId: last?.clientId ?? DYNAMIC_CLIENT,
    hostId: auth.hostId,
    started: Date.now(),
  };
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: pending.clientId,
    redirect_uri: pending.redirectUri,
    scope: SCOPES,
    resource: API_RESOURCE,
    state: pending.state,
    nonce: pending.nonce,
    code_challenge_method: 'S256',
    code_challenge: challenge,
    ext_agent_host_id: auth.hostId,
  });
  // A new registration names the app; signing an account in again names the account
  if (pending.clientId === DYNAMIC_CLIENT) params.set('agent_name_hint', APP_NAME);
  else if (last?.email) params.set('login_hint', last.email);
  return { url: `${AUTHORIZE_URL}?${params}`, pending };
}

/** Whether a tab's URL is this sign-in's callback. */
export function isCallback(url: string | undefined, pending: PendingSignIn): boolean {
  return !!url && url.startsWith(`${pending.redirectUri}?`);
}

/** The code and client from the callback URL, after checking it belongs to this sign-in. */
export function parseCallback(url: string, pending: PendingSignIn): { code: string; clientId: string } {
  const params = new URL(url).searchParams;
  if (params.get('state') !== pending.state) throw new Error('The sign-in answer didn’t match this sign-in. Try again.');
  const error = params.get('error');
  if (error === 'access_denied') throw new Error('You cancelled the sign-in, so nothing changed.');
  if (error) throw new Error(`ChatGPT couldn’t sign you in (${error}${params.get('error_description') ? `: ${params.get('error_description')}` : ''}).`);
  const code = params.get('code');
  if (!code) throw new Error('ChatGPT sent no sign-in code. Try again.');
  const issued = params.get('client_id');
  if (pending.clientId === DYNAMIC_CLIENT) {
    // A new registration must come back with the client OpenAI issued
    if (!issued || issued === DYNAMIC_CLIENT) throw new Error('ChatGPT didn’t finish registering Tabi. Try again.');
    return { code, clientId: issued };
  }
  if (issued && issued !== pending.clientId) throw new Error('ChatGPT answered for a different app registration. Try again.');
  return { code, clientId: pending.clientId };
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  expires_in?: number;
  scope?: string;
}

/** An OAuth error body's code ("invalid_grant") and message. */
function oauthError(body: string): { code: string; message: string } {
  try {
    const parsed = JSON.parse(body);
    const code = parsed?.error?.code ?? (typeof parsed?.error === 'string' ? parsed.error : '') ?? '';
    const message = parsed?.error_description ?? parsed?.error?.message ?? parsed?.detail ?? '';
    return { code: String(code), message: String(message).slice(0, 200) };
  } catch {
    return { code: '', message: body.slice(0, 200) };
  }
}

async function tokenRequest(fetchFn: Fetch, form: Record<string, string>): Promise<TokenResponse> {
  let response: Response;
  try {
    response = await fetchFn(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams(form).toString(),
    });
  } catch (err) {
    throw new ChatGPTAuthError(`Couldn’t reach ChatGPT to sign in: ${(err as Error).message}`, 'unavailable');
  }
  const body = await response.text();
  if (!response.ok) {
    const { code, message } = oauthError(body);
    throw Object.assign(new ChatGPTAuthError(`ChatGPT refused the sign-in (${response.status}${code ? ` ${code}` : ''})${message ? `: ${message}` : ''}`, response.status >= 500 ? 'unavailable' : 'auth'), { code });
  }
  return JSON.parse(body) as TokenResponse;
}

// ---------------------------------------------------------------- the ID token

interface Jwk extends JsonWebKey { kid?: string }

let jwksCache: { keys: Jwk[]; at: number } | null = null;

/** OpenAI's signing keys, from its OpenID configuration (cached for an hour). */
async function signingKeys(fetchFn: Fetch, refresh = false): Promise<Jwk[]> {
  if (jwksCache && !refresh && Date.now() - jwksCache.at < 3_600_000) return jwksCache.keys;
  const config = await (await fetchFn(DISCOVERY_URL)).json();
  const jwks = await (await fetchFn(config.jwks_uri)).json();
  jwksCache = { keys: jwks.keys ?? [], at: Date.now() };
  return jwksCache.keys;
}

export interface IdClaims {
  iss: string;
  sub: string;
  aud: string | string[];
  exp: number;
  nonce?: string;
  email?: string;
}

/**
 * Check the ID token: OpenAI's signature (RS256, its published keys), issuer,
 * audience (Tabi's client), expiry and nonce. Returns its claims.
 */
export async function verifyIdToken(idToken: string, expect: { clientId: string; nonce: string }, fetchFn: Fetch, now = Date.now()): Promise<IdClaims> {
  const parts = idToken.split('.');
  if (parts.length !== 3) throw new Error('ChatGPT sent an ID token Tabi can’t read.');
  const header = JSON.parse(new TextDecoder().decode(fromBase64url(parts[0])));
  const claims = JSON.parse(new TextDecoder().decode(fromBase64url(parts[1]))) as IdClaims;
  if (header.alg !== 'RS256') throw new Error(`ChatGPT’s ID token is signed with ${header.alg}, which Tabi doesn’t accept.`);

  const verify = async (keys: Jwk[]) => {
    const jwk = keys.find((k) => k.kid === header.kid) ?? (keys.length === 1 ? keys[0] : undefined);
    if (!jwk) return false;
    const key = await crypto.subtle.importKey('jwk', { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true }, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    return crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, fromBase64url(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  };
  // A key Tabi hasn't seen may be new: fetch the keys again once
  if (!await verify(await signingKeys(fetchFn)) && !await verify(await signingKeys(fetchFn, true))) {
    throw new Error('ChatGPT’s ID token signature didn’t check out, so Tabi didn’t sign you in.');
  }
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (claims.iss !== AUTH_ISSUER) throw new Error('The ID token wasn’t issued by ChatGPT.');
  if (!audience.includes(expect.clientId)) throw new Error('The ID token is for another app.');
  if (!claims.exp || claims.exp * 1000 < now - 60_000) throw new Error('The ID token has expired. Try again.');
  if (claims.nonce !== expect.nonce) throw new Error('The ID token didn’t match this sign-in. Try again.');
  if (!claims.sub) throw new Error('The ID token names no account.');
  return claims;
}

/**
 * Finish a sign-in: exchange the code, verify the ID token, and return the new
 * state. Signing an account in again must be the same account.
 */
export async function completeSignIn(auth: ChatGPTAuth, pending: PendingSignIn, callbackUrl: string, fetchFn: Fetch = fetch, now = Date.now()): Promise<ChatGPTAuth> {
  const { code, clientId } = parseCallback(callbackUrl, pending);
  const tokens = await tokenRequest(fetchFn, {
    grant_type: 'authorization_code',
    client_id: clientId,
    code,
    code_verifier: pending.verifier,
    redirect_uri: pending.redirectUri,
    resource: API_RESOURCE,
  });
  if (!tokens.id_token || !tokens.refresh_token) throw new Error('ChatGPT’s answer was missing tokens. Try again.');
  const claims = await verifyIdToken(tokens.id_token, { clientId, nonce: pending.nonce }, fetchFn, now);
  const previous = auth.account ?? auth.lastClient;
  if (pending.clientId !== DYNAMIC_CLIENT && previous && previous.sub !== claims.sub) {
    throw new Error(`That’s a different ChatGPT account from ${previous.email}. To use it, choose “Use another account”.`);
  }
  const scopes = (tokens.scope ?? '').split(/\s+/).filter(Boolean);
  const account: ChatGPTAccount = {
    clientId,
    sub: claims.sub,
    email: claims.email ?? previous?.email ?? 'your ChatGPT account',
    planUsage: scopes.includes(PLAN_SCOPE),
    scopes,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    idToken: tokens.id_token,
    expiresAt: now + (tokens.expires_in ?? 3600) * 1000,
    savedAt: now,
  };
  return { hostId: auth.hostId, account, lastClient: { clientId, sub: account.sub, email: account.email } };
}

// ---------------------------------------------------------------- tokens

/** Refresh errors that mean the sign-in is gone for good (sign in again). */
const TERMINAL_REFRESH = new Set(['invalid_grant', 'invalid_refresh_token', 'token_expired', 'refresh_token_expired', 'refresh_token_invalidated', 'refresh_token_reused']);

/** A new access token and the replacement refresh token. */
export async function refreshAccount(account: ChatGPTAccount, fetchFn: Fetch = fetch, now = Date.now()): Promise<ChatGPTAccount> {
  const tokens = await tokenRequest(fetchFn, {
    grant_type: 'refresh_token',
    client_id: account.clientId,
    refresh_token: account.refreshToken,
    resource: API_RESOURCE,
  });
  const scopes = tokens.scope ? tokens.scope.split(/\s+/).filter(Boolean) : account.scopes;
  return {
    ...account,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token ?? account.refreshToken,
    idToken: tokens.id_token ?? account.idToken,
    scopes,
    planUsage: scopes.includes(PLAN_SCOPE),
    expiresAt: now + (tokens.expires_in ?? 3600) * 1000,
    savedAt: now,
  };
}

/** Storage the token functions read and write (chrome.storage.local in the extension). */
export interface AuthStore {
  get(): Promise<ChatGPTAuth>;
  set(auth: ChatGPTAuth): Promise<void>;
}

export const localAuthStore: AuthStore = {
  get: async () => readAuth(await browser.storage.local.get(AUTH_KEY)),
  set: (auth) => browser.storage.local.set({ [AUTH_KEY]: auth }),
};

// One at a time, each reading the store after the last finished: refresh tokens
// rotate, and spending one twice (refresh_token_reused) ends the sign-in
let queue: Promise<unknown> = Promise.resolve();

/**
 * An access token for a request, refreshed when it's about to run out, or when
 * it's `rejected`, the token the API just refused (unless another request has
 * already replaced it).
 */
export function accessToken(store: AuthStore = localAuthStore, fetchFn: Fetch = fetch, rejected?: string): Promise<string> {
  const next = queue.then(() => currentToken(store, fetchFn, rejected));
  queue = next.catch(() => {});
  return next;
}

async function currentToken(store: AuthStore, fetchFn: Fetch, rejected?: string): Promise<string> {
  const auth = await store.get();
  const account = auth.account;
  if (!account) {
    throw new ChatGPTAuthError(auth.needsSignIn
      ? 'ChatGPT signed Tabi out. Sign in with ChatGPT again in Tabi’s Settings.'
      : 'Sign in with ChatGPT in Tabi’s Settings first.', 'auth');
  }
  if (account.accessToken !== rejected && account.expiresAt - REFRESH_EARLY_MS > Date.now()) return account.accessToken;
  try {
    const refreshed = await refreshAccount(account, fetchFn);
    await store.set({ ...auth, account: refreshed, needsSignIn: false });
    return refreshed.accessToken;
  } catch (err) {
    const code = (err as { code?: string }).code ?? '';
    if (err instanceof ChatGPTAuthError && err.kind === 'auth' && (TERMINAL_REFRESH.has(code) || !code)) {
      // Gone for good: forget the tokens, keep the client to sign the same account in again
      await store.set({ hostId: auth.hostId, lastClient: auth.lastClient, needsSignIn: true });
      throw new ChatGPTAuthError('Your ChatGPT sign-in has ended. Sign in with ChatGPT again in Tabi’s Settings.', 'auth');
    }
    throw err;
  }
}

/** The sign-in OpenAI says is no longer valid: forget its tokens (it asks to sign in again). */
export async function markSignedOut(store: AuthStore = localAuthStore): Promise<void> {
  const auth = await store.get();
  await store.set({ hostId: auth.hostId, lastClient: auth.lastClient, needsSignIn: true });
}

/**
 * Sign out: revoke the refresh token at OpenAI, then forget the tokens. The
 * client stays, to sign the same account in again. False if OpenAI couldn't
 * be told (the user can disconnect Tabi in ChatGPT's settings).
 */
export async function signOut(store: AuthStore = localAuthStore, fetchFn: Fetch = fetch): Promise<boolean> {
  const auth = await store.get();
  const account = auth.account;
  await store.set({ hostId: auth.hostId, lastClient: auth.lastClient });
  if (!account) return true;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const config = await (await fetchFn(DISCOVERY_URL)).json();
      const response = await fetchFn(config.revocation_endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: account.refreshToken, token_type_hint: 'refresh_token', client_id: account.clientId }).toString(),
      });
      if (response.ok) return true;
      if (response.status < 500) return false;
    } catch { /* network: try again */ }
    await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
  }
  return false;
}

/** For tests: forget the cached signing keys. */
export function resetForTests(): void {
  jwksCache = null;
  queue = Promise.resolve();
}
