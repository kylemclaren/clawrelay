// WebSocket Client - On-demand connection to sprite relay-channel plugin
// Connects when messages need to be sent, disconnects after idle timeout
// to allow sprite compute to suspend.

import WebSocket from 'ws';
import type { RelayConfig } from './config.js';
import type { RelayOutboundMessage, WsEnvelope } from './types.js';

interface PendingResponse {
  resolve: (message: RelayOutboundMessage) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

const IDLE_DISCONNECT_MS = 60_000; // Disconnect after 60s idle

export class WsClient {
  private config: RelayConfig;
  private logger: any;
  private ws: WebSocket | null = null;
  private pending = new Map<string, PendingResponse>();
  private reconnectTimer: NodeJS.Timeout | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private backoff = 1000;
  private stopped = false;
  private connectPromise: Promise<void> | null = null;
  private connectResolve: (() => void) | null = null;
  private intentionalClose = false;

  private static readonly BACKOFF_CAP = 30_000;
  private static readonly BACKOFF_BASE = 1_000;

  constructor(config: RelayConfig, logger?: any) {
    this.config = config;
    this.logger = logger ?? console;
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
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
      this.pending.delete(id);
    }

    this.closeWs();
  }

  /**
   * Connect if not already connected. Resolves when WS is open.
   * Throws if connection cannot be established within timeout.
   */
  async ensureConnected(timeoutMs: number = 30_000): Promise<void> {
    if (this.connected) {
      this.resetIdleTimer();
      return;
    }

    // Start connecting if not already in progress
    if (!this.connectPromise) {
      this.connectPromise = new Promise((resolve) => {
        this.connectResolve = resolve;
      });
      this.doConnect();
    }

    const timeout = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(`WebSocket not connected after ${timeoutMs / 1000}s`)), timeoutMs);
    });

    await Promise.race([this.connectPromise, timeout]);
  }

  /**
   * Send a WS envelope message.
   */
  send(envelope: WsEnvelope): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket not connected');
    }
    this.clearIdleTimer(); // Active send — don't disconnect
    this.ws.send(JSON.stringify(envelope));
  }

  /**
   * Register a pending response BEFORE sending the message (avoids race).
   * Returns a promise that resolves when the matching response arrives over WS.
   */
  waitForResponse(messageId: string, timeoutMs: number = 300_000): Promise<RelayOutboundMessage> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(messageId);
        this.maybeStartIdleTimer();
        reject(new Error(`Response timeout for message ${messageId} (${timeoutMs / 1000}s)`));
      }, timeoutMs);

      this.pending.set(messageId, { resolve, reject, timer });
    });
  }

  private doConnect(): void {
    if (this.stopped) return;

    // Build WS URL from plugin URL
    const baseUrl = this.config.sandbox.pluginUrl
      .replace(/^http:/, 'ws:')
      .replace(/^https:/, 'wss:');
    const wsUrl = `${baseUrl}${this.config.sandbox.wsPath}`;

    this.logger.info(`[ws-client] Connecting to ${wsUrl}`);

    const ws = new WebSocket(wsUrl, {
      headers: {
        'Authorization': `Bearer ${this.config.sandbox.authToken}`,
      },
    });

    ws.on('open', () => {
      this.ws = ws;
      this.backoff = WsClient.BACKOFF_BASE;
      this.intentionalClose = false;
      this.logger.info('[ws-client] Connected');

      // Resolve any waiting ensureConnected calls
      if (this.connectResolve) {
        this.connectResolve();
        this.connectResolve = null;
        this.connectPromise = null;
      }

      // Start idle timer — will disconnect if no messages are sent
      this.resetIdleTimer();
    });

    ws.on('message', (data) => {
      try {
        const envelope: WsEnvelope = JSON.parse(data.toString());
        if (envelope.type === 'response') {
          this.handleResponse(envelope.payload);
        } else {
          this.logger.warn(`[ws-client] Unexpected message type: ${envelope.type}`);
        }
      } catch (err) {
        this.logger.error(`[ws-client] Failed to parse WS message: ${err}`);
      }
    });

    ws.on('close', (code, reason) => {
      this.ws = null;

      if (this.intentionalClose) {
        this.logger.info(`[ws-client] Disconnected (idle)`);
        this.intentionalClose = false;
        return; // Don't reconnect — this was intentional
      }

      this.logger.warn(`[ws-client] Connection closed: ${code} ${reason.toString()}`);

      // Only reconnect if there are pending responses (connection dropped mid-processing)
      if (this.pending.size > 0) {
        this.scheduleReconnect();
      } else {
        // No pending work — just clear state, will reconnect on next message
        this.backoff = WsClient.BACKOFF_BASE;
      }
    });

    ws.on('error', (err) => {
      this.logger.error(`[ws-client] Connection error: ${err.message}`);
      // 'close' event will fire after this
    });
  }

  private handleResponse(message: RelayOutboundMessage): void {
    const entry = this.pending.get(message.messageId);
    if (entry) {
      clearTimeout(entry.timer);
      this.pending.delete(message.messageId);
      entry.resolve(message);
      this.logger.debug(`[ws-client] Response received for message ${message.messageId}`);
    } else {
      this.logger.warn(`[ws-client] Response for unknown/expired message ${message.messageId}`);
    }

    // If no more pending responses, start idle timer
    this.maybeStartIdleTimer();
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
      if (this.pending.size === 0 && this.connected) {
        this.logger.info('[ws-client] Idle timeout — disconnecting to let sprite suspend');
        this.intentionalClose = true;
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
    if (this.connectResolve) {
      this.connectResolve = null;
      this.connectPromise = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;

    this.logger.info(`[ws-client] Reconnecting in ${this.backoff / 1000}s...`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.doConnect();
    }, this.backoff);

    this.backoff = Math.min(this.backoff * 2, WsClient.BACKOFF_CAP);
  }
}
