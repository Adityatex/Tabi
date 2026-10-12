// The extension end of the tabi-mcp bridge (background service worker).
// It connects to the tabi-mcp server on 127.0.0.1, checks the server knows
// the pairing token before accepting any command, then runs the requests it
// gets (see mcp/src/protocol.ts).

import {
  PROTOCOL_VERSION, randomHex, serverProof, clientProof, sameString,
  type BridgeMessage, type BridgeMethod,
} from '@/mcp/src/protocol';

/**
 * off: turned off. waiting: tabi-mcp isn't running (no AI app has started
 * it). connected: ready. rejected: a server answered but the tokens don't match.
 */
export type BridgeStatus = 'off' | 'waiting' | 'connected' | 'rejected';

export interface BridgeClientDeps {
  /** WebSocket constructor (the global one in the extension; a fake in tests). */
  WebSocket: new (url: string) => WebSocket;
  handle(method: BridgeMethod, params: Record<string, unknown>): Promise<unknown>;
  onStatus(status: BridgeStatus, detail?: string): void;
}

/** Keeps the service worker awake (Chrome counts WebSocket traffic) and spots dead connections. */
const PING_MS = 20_000;
const RETRY_MS = [1_000, 2_000, 5_000, 10_000, 30_000];
/** After a token mismatch, retry slowly: the user has to fix a setting first. */
const REJECTED_RETRY_MS = 60_000;

export class BridgeClient {
  private socket?: WebSocket;
  private status: BridgeStatus = 'off';
  private retries = 0;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private pingTimer?: ReturnType<typeof setInterval>;
  private config?: { port: number; token: string };

  constructor(private deps: BridgeClientDeps) {}

  get current(): BridgeStatus {
    return this.status;
  }

  private setStatus(status: BridgeStatus, detail?: string): void {
    this.status = status;
    this.deps.onStatus(status, detail);
  }

  /** Connect (or reconnect with new settings). */
  start(port: number, token: string): void {
    this.stop();
    this.config = { port, token };
    this.setStatus('waiting');
    this.connect();
  }

  stop(): void {
    this.config = undefined;
    clearTimeout(this.retryTimer);
    clearInterval(this.pingTimer);
    const socket = this.socket;
    this.socket = undefined;
    socket?.close();
    if (this.status !== 'off') this.setStatus('off');
  }

  /** Reconnect now if it should be connected and isn't (e.g. from an alarm after the worker slept). */
  ensureConnected(): void {
    if (this.config && !this.socket) {
      clearTimeout(this.retryTimer);
      this.connect();
    }
  }

  private scheduleRetry(delay?: number): void {
    if (!this.config) return;
    clearTimeout(this.retryTimer);
    const wait = delay ?? RETRY_MS[Math.min(this.retries++, RETRY_MS.length - 1)];
    this.retryTimer = setTimeout(() => this.connect(), wait);
  }

  private connect(): void {
    const config = this.config;
    if (!config) return;
    let socket: WebSocket;
    try {
      socket = new this.deps.WebSocket(`ws://127.0.0.1:${config.port}`);
    } catch {
      this.scheduleRetry();
      return;
    }
    this.socket = socket;
    const nonce = randomHex();
    let ready = false;
    let rejected = false;
    const send = (message: BridgeMessage) => socket.send(JSON.stringify(message));

    socket.onopen = () => send({ type: 'hello', version: PROTOCOL_VERSION, nonce });

    socket.onmessage = async (event: MessageEvent) => {
      let msg: BridgeMessage;
      try {
        msg = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (!ready) {
        if (msg.type === 'challenge') {
          // The server must show it knows the token before we act on anything it says
          if (!sameString(msg.proof, await serverProof(config.token, nonce))) {
            rejected = true;
            this.setStatus('rejected', 'The tabi-mcp server has a different pairing token');
            socket.close();
            return;
          }
          send({ type: 'answer', proof: await clientProof(config.token, msg.nonce) });
        } else if (msg.type === 'ready') {
          ready = true;
          this.retries = 0;
          this.setStatus('connected');
          this.pingTimer = setInterval(() => send({ type: 'ping' }), PING_MS);
        } else if (msg.type === 'denied') {
          rejected = true;
          this.setStatus('rejected', msg.reason);
          socket.close();
        }
        return;
      }
      if (msg.type !== 'request') return;
      try {
        const result = await this.deps.handle(msg.method, msg.params ?? {});
        send({ type: 'response', id: msg.id, result });
      } catch (err) {
        send({ type: 'response', id: msg.id, error: String((err as Error)?.message ?? err) });
      }
    };

    socket.onclose = () => {
      if (this.socket !== socket) return; // replaced or stopped
      this.socket = undefined;
      clearInterval(this.pingTimer);
      if (!this.config) return;
      if (!rejected) this.setStatus('waiting');
      this.scheduleRetry(rejected ? REJECTED_RETRY_MS : undefined);
    };
    socket.onerror = () => { /* onclose follows */ };
  }
}
