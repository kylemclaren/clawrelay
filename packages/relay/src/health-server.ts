// Health Server - Minimal HTTP server for Fly.io health checks

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import type { WsClient } from './ws-client.js';

export class HealthServer {
  private server: Server | null = null;
  private port: number;
  private wsClient: WsClient;
  private logger: any;

  constructor(port: number, wsClient: WsClient, logger?: any) {
    this.port = port;
    this.wsClient = wsClient;
    this.logger = logger ?? console;
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = createServer((req, res) => this.handleRequest(req, res));

      server.on('error', reject);
      server.listen(this.port, () => {
        this.server = server;
        this.logger.info(`[relay] Health server listening on port ${this.port}`);
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
        this.logger.info('[relay] Health server stopped');
        resolve();
      });
    });
  }

  private handleRequest(req: IncomingMessage, res: ServerResponse) {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'ok',
        wsConnected: this.wsClient.connected,
      }));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  }
}
