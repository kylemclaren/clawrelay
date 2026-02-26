// Relay Inbound Server - HTTP server for /relay/inbound and /relay/health

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import type { RelayInboundMessage } from './types.js';

export interface InboundServerOptions {
  port: number;
  authToken: string;
  onMessage: (message: RelayInboundMessage) => void;
  logger?: any;
}

export class InboundServer {
  private server: Server | null = null;
  private options: InboundServerOptions;

  constructor(options: InboundServerOptions) {
    this.options = options;
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = createServer((req, res) => this.handleRequest(req, res));

      server.on('error', reject);
      server.listen(this.options.port, () => {
        this.server = server;
        this.options.logger?.info(`[relay-channel] Inbound server listening on port ${this.options.port}`);
        resolve();
      });
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.server) {
        resolve();
        return;
      }
      this.server.close(() => {
        this.server = null;
        this.options.logger?.info('[relay-channel] Inbound server stopped');
        resolve();
      });
    });
  }

  private handleRequest(req: IncomingMessage, res: ServerResponse) {
    const url = req.url ?? '';

    if (req.method === 'GET' && url === '/relay/health') {
      this.handleHealth(res);
      return;
    }

    if (req.method === 'POST' && url === '/relay/inbound') {
      this.handleInbound(req, res);
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  }

  private handleHealth(res: ServerResponse) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', ready: true }));
  }

  private handleInbound(req: IncomingMessage, res: ServerResponse) {
    // Check auth
    const authHeader = req.headers['authorization'];
    const expected = `Bearer ${this.options.authToken}`;
    if (authHeader !== expected) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }

    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try {
        const message: RelayInboundMessage = JSON.parse(body);

        if (!message.messageId || !message.content || !message.callbackUrl) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing required fields: messageId, content, callbackUrl' }));
          return;
        }

        // Accept immediately, process async
        res.writeHead(202, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ accepted: true, messageId: message.messageId }));

        // Fire and forget — errors handled by the channel
        this.options.onMessage(message);
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }
    });
  }
}
