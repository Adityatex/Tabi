// The server end of the bridge: a WebSocket server on 127.0.0.1 that the
// Tabi extension connects to. See protocol.ts for the handshake.

import { WebSocketServer, type WebSocket } from 'ws';
import type { IncomingMessage } from 'node:http';
import {
  PROTOCOL_VERSION, randomHex, serverProof, clientProof, sameString,
  type BridgeMessage, type BridgeMethod,
} from './protocol.js';

/** How long a browser action may take before the AI app gets an error. */
const REQUEST_TIMEOUT_MS = 120_000;
/** A connection that hasn't finished the handshake by then is dropped. */
const HANDSHAKE_TIMEOUT_MS = 10_000;

export const NOT_CONNECTED =
  'The Tabi extension is not connected. In Chrome, open Tabi Settings, turn on "Let AI apps control this browser" '
  + 'and paste the pairing token (run `tabi-mcp token` to see it).';

/** Only browser extensions may connect: web pages can open WebSockets to localhost too. */
export function allowedOrigin(origin: string | undefined): boolean {
  return !!origin && /^(chrome|moz)-extension:\/\/[a-z0-9-]+$/i.test(origin);
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class ExtensionBridge {
  private wss?: WebSocketServer;
  /** The extension's authenticated connection, if any. */
  private socket?: WebSocket;
  private pending = new Map<number, Pending>();
  private nextId = 1;

  constructor(private token: string, private port: number, private log: (msg: string) => void = () => {}) {}

  get connected(): boolean {
    return !!this.socket;
  }

  /** Start listening. Rejects with a readable error if the port is taken. */
  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const wss = new WebSocketServer({
        host: '127.0.0.1',
        port: this.port,
        verifyClient: (info: { origin: string; req: IncomingMessage }) => allowedOrigin(info.origin || info.req.headers.origin),
      });
      wss.once('listening', () => {
        this.wss = wss;
        resolve();
      });
      wss.once('error', (err: NodeJS.ErrnoException) => {
        reject(err.code === 'EADDRINUSE'
          ? new Error(`Port ${this.port} is in use: another tabi-mcp may be running (only one AI app can use Tabi at a time), or set TABI_MCP_PORT.`)
          : err);
      });
      wss.on('connection', (socket) => this.accept(socket));
    });
  }

  /** Port actually listened on (useful when started with port 0). */
  get address(): number {
    const addr = this.wss?.address();
    return typeof addr === 'object' && addr ? addr.port : this.port;
  }

  async stop(): Promise<void> {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error('The server is shutting down'));
    }
    this.pending.clear();
    this.socket?.close();
    await new Promise<void>((resolve) => (this.wss ? this.wss.close(() => resolve()) : resolve()));
  }

  private send(socket: WebSocket, message: BridgeMessage): void {
    socket.send(JSON.stringify(message));
  }

  private accept(socket: WebSocket): void {
    let nonce = '';
    let authed = false;
    const timer = setTimeout(() => { if (!authed) socket.close(); }, HANDSHAKE_TIMEOUT_MS);

    socket.on('message', async (data) => {
      let msg: BridgeMessage;
      try {
        msg = JSON.parse(String(data));
      } catch {
        return;
      }
      if (!authed) {
        if (msg.type === 'hello') {
          if (msg.version !== PROTOCOL_VERSION) {
            this.send(socket, { type: 'denied', reason: `Protocol version ${msg.version} isn't supported; update Tabi or tabi-mcp` });
            socket.close();
            return;
          }
          nonce = randomHex();
          this.send(socket, { type: 'challenge', proof: await serverProof(this.token, msg.nonce), nonce });
        } else if (msg.type === 'answer' && nonce) {
          if (!sameString(msg.proof, await clientProof(this.token, nonce))) {
            this.send(socket, { type: 'denied', reason: 'Wrong pairing token' });
            this.log('An extension tried to connect with the wrong pairing token.');
            socket.close();
            return;
          }
          authed = true;
          clearTimeout(timer);
          // A newer connection (e.g. after the service worker restarted) replaces the old one
          if (this.socket && this.socket !== socket) this.socket.close();
          this.socket = socket;
          this.send(socket, { type: 'ready' });
          this.log('Tabi extension connected.');
        }
        return;
      }
      if (msg.type === 'ping') this.send(socket, { type: 'pong' });
      if (msg.type === 'response') {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.error !== undefined) p.reject(new Error(msg.error));
        else p.resolve(msg.result);
      }
    });

    socket.on('close', () => {
      clearTimeout(timer);
      if (this.socket !== socket) return;
      this.socket = undefined;
      this.log('Tabi extension disconnected.');
      for (const [id, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error('The Tabi extension disconnected before answering'));
        this.pending.delete(id);
      }
    });
  }

  /** Ask the extension to do something and wait for its answer. */
  request<T = unknown>(method: BridgeMethod, params: Record<string, unknown> = {}, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> {
    const socket = this.socket;
    if (!socket) return Promise.reject(new Error(NOT_CONNECTED));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`The browser didn't answer within ${Math.round(timeoutMs / 1000)} seconds`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.send(socket, { type: 'request', id, method, params });
    });
  }
}
