// WebSocket Client - Gateway protocol client for OpenClaw
//
// Connects to the OpenClaw gateway WS, performs the connect handshake,
// and sends relay.inbound method calls. Disconnects after idle timeout
// to allow sprite compute to suspend.

import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import type { RelayConfig } from './config.js';
import type {
  RelayInboundMessage,
  RelayOutboundMessage,
  GatewayReqFrame,
  GatewayResFrame,
  GatewayEventFrame,
  GatewayFrame,
} from './types.js';

interface PendingResponse {
  resolve: (message: RelayOutboundMessage) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  messageId: string;
}

const IDLE_DISCONNECT_MS = 60_000;
const RELAY_CLIENT_VERSION = '0.3.0';

export class WsClient {
  private config: RelayConfig;
  private logger: any;
  private ws: WebSocket | null = null;
  private pending = new Map<string, PendingResponse>(); // requestId -> PendingResponse
  private messageIdToRequestId = new Map<string, string>(); // messageId -> requestId
  private reconnectTimer: NodeJS.Timeout | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private backoff = 1000;
  private stopped = false;
  private connectPromise: Promise<void> | null = null;
  private connectResolve: (() => void) | null = null;
  private connectReject: ((err: Error) => void) | null = null;
  private intentionalClose = false;
  private authenticated = false;
  private connectNonce: string | null = null;

  private static readonly BACKOFF_CAP = 30_000;
  private static readonly BACKOFF_BASE = 1_000;

  constructor(config: RelayConfig, logger?: any) {
    this.config = config;
    this.logger = logger ?? console;
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN && this.authenticated;
  }

  stop(): void {
    this.stopped = true;
    this.clearIdleTimer();

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    // Reject all pending responses
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error('WebSocket client shutting down'));
      this.messageIdToRequestId.delete(entry.messageId);
    }
    this.pending.clear();

    this.closeWs();
  }

  /**
   * Connect if not already connected. Resolves when WS is open and authenticated.
   * Throws if connection cannot be established within timeout.
   */
  async ensureConnected(timeoutMs: number = 30_000): Promise<void> {
    if (this.connected) {
      this.resetIdleTimer();
      return;
    }

    // Start connecting if not already in progress
    if (!this.connectPromise) {
      this.connectPromise = new Promise((resolve, reject) => {
        this.connectResolve = resolve;
        this.connectReject = reject;
      });
      this.doConnect();
    }

    const timeout = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(`Gateway not connected after ${timeoutMs / 1000}s`)), timeoutMs);
    });

    await Promise.race([this.connectPromise, timeout]);
  }

  /**
   * Send a relay.inbound method call to the gateway.
   * The message is wrapped in a gateway request frame.
   */
  sendRelayMessage(message: RelayInboundMessage): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.authenticated) {
      throw new Error('Gateway not connected');
    }
    this.clearIdleTimer(); // Active send — don't disconnect

    const requestId = `req-${randomUUID()}`;
    const frame: GatewayReqFrame = {
      type: 'req',
      id: requestId,
      method: 'relay.inbound',
      params: { message },
    };

    // Store mapping so waitForResponse can find the pending entry
    this.messageIdToRequestId.set(message.messageId, requestId);

    this.ws.send(JSON.stringify(frame));
  }

  /**
   * Register a pending response BEFORE sending the message (avoids race).
   * Returns a promise that resolves when the matching response arrives over WS.
   */
  waitForResponse(messageId: string, timeoutMs: number = 300_000): Promise<RelayOutboundMessage> {
    return new Promise((resolve, reject) => {
      // We don't know the requestId yet — it gets set in sendRelayMessage.
      // Use a placeholder that gets resolved later.
      const placeholderId = `pending-${messageId}`;

      const timer = setTimeout(() => {
        // Clean up both maps
        const requestId = this.messageIdToRequestId.get(messageId);
        if (requestId) {
          this.pending.delete(requestId);
          this.messageIdToRequestId.delete(messageId);
        }
        this.pending.delete(placeholderId);
        this.maybeStartIdleTimer();
        reject(new Error(`Response timeout for message ${messageId} (${timeoutMs / 1000}s)`));
      }, timeoutMs);

      // Store under placeholder — sendRelayMessage will also store messageId -> requestId
      this.pending.set(placeholderId, { resolve, reject, timer, messageId });
    });
  }

  private doConnect(): void {
    if (this.stopped) return;

    // Build WS URL from gateway URL
    const baseUrl = this.config.gateway.url
      .replace(/^http:/, 'ws:')
      .replace(/^https:/, 'wss:');
    const wsUrl = `${baseUrl}/gateway/ws`;

    this.logger.info(`[ws-client] Connecting to ${wsUrl}`);
    this.authenticated = false;
    this.connectNonce = null;

    const wsOptions: WebSocket.ClientOptions = {};
    if (this.config.gateway.spriteToken) {
      wsOptions.headers = {
        Authorization: `Bearer ${this.config.gateway.spriteToken}`,
      };
    }

    const ws = new WebSocket(wsUrl, wsOptions);

    ws.on('open', () => {
      this.ws = ws;
      this.logger.info('[ws-client] WS open, waiting for connect.challenge...');
    });

    ws.on('message', (data) => {
      try {
        const frame: GatewayFrame = JSON.parse(data.toString());
        this.handleFrame(frame);
      } catch (err) {
        this.logger.error(`[ws-client] Failed to parse gateway frame: ${err}`);
      }
    });

    ws.on('close', (code, reason) => {
      this.ws = null;
      this.authenticated = false;

      if (this.intentionalClose) {
        this.logger.info(`[ws-client] Disconnected (idle)`);
        this.intentionalClose = false;
        return;
      }

      this.logger.warn(`[ws-client] Connection closed: ${code} ${reason.toString()}`);

      // Reject pending connect if handshake didn't complete
      if (this.connectReject) {
        this.connectReject(new Error(`Connection closed during handshake: ${code}`));
        this.connectResolve = null;
        this.connectReject = null;
        this.connectPromise = null;
      }

      // Only reconnect if there are pending responses
      if (this.pending.size > 0) {
        this.scheduleReconnect();
      } else {
        this.backoff = WsClient.BACKOFF_BASE;
      }
    });

    ws.on('error', (err) => {
      this.logger.error(`[ws-client] Connection error: ${err.message}`);
    });
  }

  private handleFrame(frame: GatewayFrame): void {
    switch (frame.type) {
      case 'event':
        this.handleEvent(frame as GatewayEventFrame);
        break;
      case 'res':
        this.handleResponse(frame as GatewayResFrame);
        break;
      default:
        this.logger.debug(`[ws-client] Unhandled frame type: ${(frame as any).type}`);
    }
  }

  private handleEvent(frame: GatewayEventFrame): void {
    if (frame.event === 'connect.challenge') {
      const payload = frame.payload as { nonce?: string } | undefined;
      this.connectNonce = payload?.nonce ?? null;
      this.logger.info('[ws-client] Received connect.challenge, sending connect...');
      this.sendConnect();
    } else if (frame.event === 'tick') {
      // Keepalive tick from gateway — ignore
    } else {
      this.logger.debug(`[ws-client] Received event: ${frame.event}`);
    }
  }

  private sendConnect(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const connectFrame: GatewayReqFrame = {
      type: 'req',
      id: 'connect-1',
      method: 'connect',
      params: {
        minProtocol: 3,
        maxProtocol: 3,
        client: {
          id: 'gateway-client',
          displayName: 'ClawRelay',
          version: RELAY_CLIENT_VERSION,
          platform: process.platform,
          mode: 'backend',
        },
        role: 'operator',
        scopes: ['operator.admin'],
        auth: {
          token: this.config.gateway.authToken,
        },
      },
    };

    this.ws.send(JSON.stringify(connectFrame));
  }

  private handleResponse(frame: GatewayResFrame): void {
    // Handle connect response (hello-ok)
    if (frame.id === 'connect-1') {
      if (frame.ok) {
        this.authenticated = true;
        this.backoff = WsClient.BACKOFF_BASE;
        this.logger.info('[ws-client] Authenticated with gateway');

        if (this.connectResolve) {
          this.connectResolve();
          this.connectResolve = null;
          this.connectReject = null;
          this.connectPromise = null;
        }

        this.resetIdleTimer();
      } else {
        const errMsg = frame.error?.message ?? 'Authentication failed';
        this.logger.error(`[ws-client] Connect failed: ${errMsg}`);

        if (this.connectReject) {
          this.connectReject(new Error(`Gateway auth failed: ${errMsg}`));
          this.connectResolve = null;
          this.connectReject = null;
          this.connectPromise = null;
        }

        this.closeWs();
      }
      return;
    }

    // Handle relay.inbound response — look up by requestId
    const entry = this.pending.get(frame.id);
    if (entry) {
      clearTimeout(entry.timer);
      this.pending.delete(frame.id);
      this.messageIdToRequestId.delete(entry.messageId);

      if (frame.ok) {
        const payload = frame.payload as RelayOutboundMessage | undefined;
        if (payload) {
          entry.resolve(payload);
          this.logger.debug(`[ws-client] Response received for request ${frame.id}`);
        } else {
          entry.reject(new Error(`Empty response payload for request ${frame.id}`));
        }
      } else {
        const errMsg = frame.error?.message ?? 'Unknown error';
        entry.reject(new Error(`Gateway error: ${errMsg}`));
      }

      this.maybeStartIdleTimer();
      return;
    }

    // Also check if this matches via messageId -> requestId (for waitForResponse placeholders)
    // The placeholder entries use `pending-{messageId}` as key
    for (const [key, pendingEntry] of this.pending) {
      if (key.startsWith('pending-') && this.messageIdToRequestId.get(pendingEntry.messageId) === frame.id) {
        clearTimeout(pendingEntry.timer);
        this.pending.delete(key);
        this.messageIdToRequestId.delete(pendingEntry.messageId);

        if (frame.ok) {
          const payload = frame.payload as RelayOutboundMessage | undefined;
          if (payload) {
            pendingEntry.resolve(payload);
          } else {
            pendingEntry.reject(new Error(`Empty response payload for request ${frame.id}`));
          }
        } else {
          const errMsg = frame.error?.message ?? 'Unknown error';
          pendingEntry.reject(new Error(`Gateway error: ${errMsg}`));
        }

        this.maybeStartIdleTimer();
        return;
      }
    }

    this.logger.warn(`[ws-client] Response for unknown request ${frame.id}`);
  }

  private maybeStartIdleTimer(): void {
    if (this.pending.size === 0) {
      this.resetIdleTimer();
    }
  }

  private resetIdleTimer(): void {
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.pending.size === 0 && this.ws?.readyState === WebSocket.OPEN) {
        this.logger.info('[ws-client] Idle timeout — disconnecting to let sprite suspend');
        this.intentionalClose = true;
        this.authenticated = false;
        this.ws?.close();
      }
    }, IDLE_DISCONNECT_MS);
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private closeWs(): void {
    if (this.ws) {
      this.intentionalClose = true;
      this.ws.close();
      this.ws = null;
    }
    this.authenticated = false;
    if (this.connectResolve) {
      this.connectResolve = null;
      this.connectReject = null;
      this.connectPromise = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;

    this.logger.info(`[ws-client] Reconnecting in ${this.backoff / 1000}s...`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      // Reset connect promise so ensureConnected works
      this.connectPromise = new Promise((resolve, reject) => {
        this.connectResolve = resolve;
        this.connectReject = reject;
      });
      this.doConnect();
    }, this.backoff);

    this.backoff = Math.min(this.backoff * 2, WsClient.BACKOFF_CAP);
  }
}
