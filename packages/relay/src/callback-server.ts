// Callback Server - HTTP server for receiving plugin response callbacks

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import type { RelayOutboundMessage } from './types.js';

export interface PendingCallback {
  resolve: (message: RelayOutboundMessage) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export class CallbackServer {
  private server: Server | null = null;
  private pending = new Map<string, PendingCallback>();
  private port: number;
  private logger?: any;

  constructor(port: number, logger?: any) {
    this.port = port;
    this.logger = logger;
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = createServer((req, res) => this.handleRequest(req, res));

      server.on('error', reject);
      server.listen(this.port, () => {
        this.server = server;
        this.logger?.info(`[relay] Callback server listening on port ${this.port}`);
        resolve();
      });
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      // Reject all pending callbacks
      for (const [id, entry] of this.pending) {
        clearTimeout(entry.timer);
        entry.reject(new Error('Callback server shutting down'));
        this.pending.delete(id);
      }

      if (!this.server) {
        resolve();
        return;
      }
      this.server.close(() => {
        this.server = null;
        this.logger?.info('[relay] Callback server stopped');
        resolve();
      });
    });
  }

  /**
   * Register a pending callback BEFORE forwarding to plugin (avoids race).
   * Returns a promise that resolves when the plugin POSTs the response.
   */
  waitForResponse(messageId: string, timeoutMs: number = 300_000): Promise<RelayOutboundMessage> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(messageId);
        reject(new Error(`Callback timeout for message ${messageId} (${timeoutMs / 1000}s)`));
      }, timeoutMs);

      this.pending.set(messageId, { resolve, reject, timer });
    });
  }

  private handleRequest(req: IncomingMessage, res: ServerResponse) {
    const url = req.url ?? '';

    if (req.method === 'GET' && url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', pending: this.pending.size }));
      return;
    }

    if (req.method === 'POST' && url === '/callback') {
      this.handleCallback(req, res);
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  }

  private handleCallback(req: IncomingMessage, res: ServerResponse) {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try {
        const message: RelayOutboundMessage = JSON.parse(body);

        if (!message.messageId || !message.content) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing required fields: messageId, content' }));
          return;
        }

        const pending = this.pending.get(message.messageId);
        if (pending) {
          clearTimeout(pending.timer);
          this.pending.delete(message.messageId);
          pending.resolve(message);
          this.logger?.debug(`[relay] Callback received for message ${message.messageId}`);
        } else {
          this.logger?.warn(`[relay] Callback for unknown/expired message ${message.messageId}`);
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }
    });
  }
}
