import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  DYNAMIC_CLIENT, accessToken, completeSignIn, parseCallback, resetForTests, signOut, startSignIn,
  type AuthStore, type ChatGPTAuth, type ChatGPTAccount, type PendingSignIn,
} from '@/lib/api/chatgptAuth';

const HOST = 'urn:uuid:7c1e7a64-1d2b-4c43-9a51-2f3f8d0d8e11';
const CLIENT = 'oaiapp_test123';

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64json = (o: unknown) => b64url(new TextEncoder().encode(JSON.stringify(o)));

let keys: CryptoKeyPair;
let jwk: JsonWebKey;
beforeEach(async () => {
  resetForTests();
  keys ??= await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']) as CryptoKeyPair;
  jwk ??= await crypto.subtle.exportKey('jwk', keys.publicKey);
});

/** An ID token signed with the test key (or with `key`, to fake a bad signature). */
async function idToken(claims: Record<string, unknown>, key = keys.privateKey): Promise<string> {
  const head = b64json({ alg: 'RS256', kid: 'k1', typ: 'JWT' });
  const body = b64json({ iss: 'https://auth.openai.com', sub: 'user-1', aud: CLIENT, exp: Math.floor(Date.now() / 1000) + 3600, email: 'ada@example.com', ...claims });
  const sig = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(`${head}.${body}`)));
  return `${head}.${body}.${b64url(sig)}`;
}

/** OpenAI's auth server: discovery, keys, tokens and revocation, recording each request. */
function authServer(token: (form: URLSearchParams) => { status?: number; body: unknown }) {
  const calls: { url: string; form?: URLSearchParams }[] = [];
  const fetchFn = vi.fn(async (input: string, init?: RequestInit) => {
    const form = init?.body ? new URLSearchParams(String(init.body)) : undefined;
    calls.push({ url: input, form });
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (input.endsWith('/.well-known/openid-configuration')) return json({ jwks_uri: 'https://auth.openai.com/jwks', revocation_endpoint: 'https://auth.openai.com/oauth/revoke' });
    if (input === 'https://auth.openai.com/jwks') return json({ keys: [{ ...jwk, kid: 'k1' }] });
    if (input.endsWith('/oauth/token')) { const r = token(form!); return json(r.body, r.status); }
    if (input.endsWith('/oauth/revoke')) return new Response('', { status: 200 });
    return json({}, 404);
  });
  return { fetchFn: fetchFn as unknown as typeof fetch, calls };
}

const memoryStore = (auth: ChatGPTAuth): AuthStore & { auth: ChatGPTAuth } => {
  const store = { auth, get: async () => store.auth, set: async (next: ChatGPTAuth) => { store.auth = next; } };
  return store;
};

const account = (over: Partial<ChatGPTAccount> = {}): ChatGPTAccount => ({
  clientId: CLIENT, sub: 'user-1', email: 'ada@example.com', planUsage: true, scopes: ['chatgpt.tokens.use.direct'],
  accessToken: 'at-1', refreshToken: 'rt-1', idToken: 'id', expiresAt: Date.now() + 3_600_000, savedAt: Date.now(), ...over,
});

describe('starting a sign-in', () => {
  it('registers Tabi on the first sign-in, with this browser’s host ID', async () => {
    const { url, pending } = await startSignIn({ hostId: HOST });
    const q = new URL(url).searchParams;
    expect(url.startsWith('https://auth.openai.com/api/accounts/authorize?')).toBe(true);
    expect(q.get('client_id')).toBe(DYNAMIC_CLIENT);
    expect(q.get('agent_name_hint')).toBe('Tabi');
    expect(q.get('ext_agent_host_id')).toBe(HOST);
    expect(q.get('scope')).toBe('openid profile email offline_access resource.invoke chatgpt.tokens.use.direct');
    expect(q.get('resource')).toBe('https://api.openai.com/v1');
    expect(q.get('code_challenge_method')).toBe('S256');
    expect(q.get('redirect_uri')).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/);
    expect(q.get('state')).toBe(pending.state);
    expect(q.get('nonce')).toBe(pending.nonce);
    // The challenge is the verifier's SHA-256, never the verifier itself
    expect(url).not.toContain(pending.verifier);
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(pending.verifier)));
    expect(q.get('code_challenge')).toBe(b64url(digest));
  });

  it('signs the last account in again with its own client, and a new one when asked', async () => {
    const auth: ChatGPTAuth = { hostId: HOST, lastClient: { clientId: CLIENT, sub: 'user-1', email: 'ada@example.com' } };
    const again = new URL((await startSignIn(auth)).url).searchParams;
    expect(again.get('client_id')).toBe(CLIENT);
    expect(again.get('login_hint')).toBe('ada@example.com');
    expect(again.has('agent_name_hint')).toBe(false);
    expect(new URL((await startSignIn(auth, { fresh: true })).url).searchParams.get('client_id')).toBe(DYNAMIC_CLIENT);
  });
});

describe('the callback', () => {
  const pending: PendingSignIn = { state: 's1', nonce: 'n1', verifier: 'v', redirectUri: 'http://127.0.0.1:50123/auth/callback', clientId: DYNAMIC_CLIENT, hostId: HOST, started: 0 };
  const cb = (q: string) => `${pending.redirectUri}?${q}`;

  it('takes the code and the client OpenAI issued', () => {
    expect(parseCallback(cb(`code=c1&state=s1&client_id=${CLIENT}`), pending)).toEqual({ code: 'c1', clientId: CLIENT });
  });

  it('refuses another sign-in’s answer, a cancelled one, and an unfinished registration', () => {
    expect(() => parseCallback(cb('code=c1&state=other'), pending)).toThrow(/didn’t match/);
    expect(() => parseCallback(cb('error=access_denied&state=s1'), pending)).toThrow(/cancelled/);
    expect(() => parseCallback(cb('code=c1&state=s1'), pending)).toThrow(/didn’t finish registering/);
    expect(() => parseCallback(cb(`code=c1&state=s1&client_id=${DYNAMIC_CLIENT}`), pending)).toThrow(/didn’t finish registering/);
  });

  it('refuses a different client when signing an account in again', () => {
    const again = { ...pending, clientId: CLIENT };
    expect(parseCallback(cb('code=c1&state=s1'), again).clientId).toBe(CLIENT);
    expect(() => parseCallback(cb('code=c1&state=s1&client_id=oaiapp_other'), again)).toThrow(/different app/);
  });
});

describe('finishing a sign-in', () => {
  const start = async () => startSignIn({ hostId: HOST });
  const callbackFor = (p: PendingSignIn) => `${p.redirectUri}?code=c1&state=${p.state}&client_id=${CLIENT}`;

  it('exchanges the code with PKCE, checks the ID token and keeps the account', async () => {
    const { pending } = await start();
    const token = await idToken({ nonce: pending.nonce });
    const { fetchFn, calls } = authServer(() => ({ body: { access_token: 'at-1', refresh_token: 'rt-1', id_token: token, expires_in: 3600, scope: 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct' } }));
    const next = await completeSignIn({ hostId: HOST }, pending, callbackFor(pending), fetchFn);
    const form = calls.find((c) => c.url.endsWith('/oauth/token'))!.form!;
    expect(Object.fromEntries(form)).toEqual({
      grant_type: 'authorization_code', client_id: CLIENT, code: 'c1', code_verifier: pending.verifier, redirect_uri: pending.redirectUri, resource: 'https://api.openai.com/v1',
    });
    expect(next.account).toMatchObject({ clientId: CLIENT, sub: 'user-1', email: 'ada@example.com', planUsage: true, accessToken: 'at-1', refreshToken: 'rt-1' });
    expect(next.lastClient).toEqual({ clientId: CLIENT, sub: 'user-1', email: 'ada@example.com' });
    expect(next.hostId).toBe(HOST);
  });

  it('signs in without plan usage when that scope wasn’t granted', async () => {
    const { pending } = await start();
    const token = await idToken({ nonce: pending.nonce });
    const { fetchFn } = authServer(() => ({ body: { access_token: 'a', refresh_token: 'r', id_token: token, scope: 'openid profile email offline_access' } }));
    expect((await completeSignIn({ hostId: HOST }, pending, callbackFor(pending), fetchFn)).account?.planUsage).toBe(false);
  });

  it('refuses an ID token that’s forged, for another app, from elsewhere, or for another sign-in', async () => {
    const { pending } = await start();
    const other = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']) as CryptoKeyPair;
    const cases: [Promise<string>, RegExp][] = [
      [idToken({ nonce: pending.nonce }, other.privateKey), /signature/],
      [idToken({ nonce: pending.nonce, aud: 'oaiapp_someone_else' }), /another app/],
      [idToken({ nonce: pending.nonce, iss: 'https://evil.example' }), /wasn’t issued by ChatGPT/],
      [idToken({ nonce: 'wrong' }), /didn’t match this sign-in/],
      [idToken({ nonce: pending.nonce, exp: Math.floor(Date.now() / 1000) - 600 }), /expired/],
    ];
    for (const [token, error] of cases) {
      const t = await token;
      const { fetchFn } = authServer(() => ({ body: { access_token: 'a', refresh_token: 'r', id_token: t, scope: '' } }));
      await expect(completeSignIn({ hostId: HOST }, pending, callbackFor(pending), fetchFn)).rejects.toThrow(error);
    }
  });

  it('won’t swap in a different account when signing the last one in again', async () => {
    const auth: ChatGPTAuth = { hostId: HOST, lastClient: { clientId: CLIENT, sub: 'user-1', email: 'ada@example.com' } };
    const { pending } = await startSignIn(auth);
    const token = await idToken({ nonce: pending.nonce, sub: 'user-2', email: 'bob@example.com' });
    const { fetchFn } = authServer(() => ({ body: { access_token: 'a', refresh_token: 'r', id_token: token, scope: '' } }));
    await expect(completeSignIn(auth, pending, `${pending.redirectUri}?code=c1&state=${pending.state}`, fetchFn)).rejects.toThrow(/different ChatGPT account from ada@example.com/);
  });
});

describe('access tokens', () => {
  it('uses the saved token while it lasts', async () => {
    const store = memoryStore({ hostId: HOST, account: account() });
    const { fetchFn } = authServer(() => ({ body: {} }));
    expect(await accessToken(store, fetchFn)).toBe('at-1');
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('refreshes near expiry, once for requests at the same time, and keeps the replacement refresh token', async () => {
    const store = memoryStore({ hostId: HOST, account: account({ expiresAt: Date.now() + 30_000 }) });
    const { fetchFn, calls } = authServer(() => ({ body: { access_token: 'at-2', refresh_token: 'rt-2', expires_in: 3600, scope: 'chatgpt.tokens.use.direct' } }));
    const tokens = await Promise.all([accessToken(store, fetchFn), accessToken(store, fetchFn), accessToken(store, fetchFn)]);
    expect(tokens).toEqual(['at-2', 'at-2', 'at-2']);
    const refreshes = calls.filter((c) => c.url.endsWith('/oauth/token'));
    expect(refreshes).toHaveLength(1);
    expect(Object.fromEntries(refreshes[0].form!)).toEqual({ grant_type: 'refresh_token', client_id: CLIENT, refresh_token: 'rt-1', resource: 'https://api.openai.com/v1' });
    expect(store.auth.account).toMatchObject({ accessToken: 'at-2', refreshToken: 'rt-2' });
  });

  it('asks to sign in again when the refresh token is gone, and keeps the client for it', async () => {
    const store = memoryStore({ hostId: HOST, account: account({ expiresAt: 0 }), lastClient: { clientId: CLIENT, sub: 'user-1', email: 'ada@example.com' } });
    const { fetchFn } = authServer(() => ({ status: 400, body: { error: 'invalid_grant', error_description: 'Refresh token expired' } }));
    await expect(accessToken(store, fetchFn)).rejects.toMatchObject({ kind: 'auth', message: expect.stringMatching(/Sign in with ChatGPT again/) });
    expect(store.auth.account).toBeUndefined();
    expect(store.auth.needsSignIn).toBe(true);
    expect(store.auth.lastClient?.clientId).toBe(CLIENT);
    await expect(accessToken(store, fetchFn)).rejects.toThrow(/signed Tabi out/);
  });

  it('keeps the sign-in when the auth server is down', async () => {
    const store = memoryStore({ hostId: HOST, account: account({ expiresAt: 0 }) });
    const { fetchFn } = authServer(() => ({ status: 503, body: { error: 'temporarily_unavailable' } }));
    await expect(accessToken(store, fetchFn)).rejects.toMatchObject({ kind: 'unavailable' });
    expect(store.auth.account?.refreshToken).toBe('rt-1');
  });
});

describe('signing out', () => {
  it('revokes the refresh token and forgets the tokens, keeping the client', async () => {
    const store = memoryStore({ hostId: HOST, account: account(), lastClient: { clientId: CLIENT, sub: 'user-1', email: 'ada@example.com' } });
    const { fetchFn, calls } = authServer(() => ({ body: {} }));
    expect(await signOut(store, fetchFn)).toBe(true);
    const revoke = calls.find((c) => c.url.endsWith('/oauth/revoke'))!;
    expect(Object.fromEntries(revoke.form!)).toEqual({ token: 'rt-1', token_type_hint: 'refresh_token', client_id: CLIENT });
    expect(store.auth).toEqual({ hostId: HOST, lastClient: { clientId: CLIENT, sub: 'user-1', email: 'ada@example.com' } });
  });
});
