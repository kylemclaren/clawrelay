// Relay Server - HTTP health + WebSocket server for relay communication

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import type { RelayInboundMessage, RelayOutboundMessage, WsEnvelope, ReplyFn } from './types.js';

export interface InboundServerOptions {
  port: number;
  authToken: string;
  onMessage: (message: RelayInboundMessage, reply: ReplyFn) => void;
  logger?: any;
}

export class InboundServer {
  private server: Server | null = null;
  private wss: WebSocketServer | null = null;
  private options: InboundServerOptions;

  constructor(options: InboundServerOptions) {
    this.options = options;
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = createServer((req, res) => this.handleRequest(req, res));

      // Create WebSocket server attached to the HTTP server
      const wss = new WebSocketServer({ noServer: true });

      wss.on('connection', (ws) => {
        this.options.logger?.info('[relay-channel] WebSocket client connected');

        ws.on('message', (data) => {
          try {
            const envelope: WsEnvelope = JSON.parse(data.toString());

            if (envelope.type === 'message') {
              const message = envelope.payload as RelayInboundMessage;

              if (!message.messageId || !message.content) {
                this.options.logger?.warn('[relay-channel] WS message missing required fields');
                return;
              }

              // Create reply function that sends response back over this WS connection
              const reply: ReplyFn = (response: RelayOutboundMessage) => {
                if (ws.readyState === WebSocket.OPEN) {
                  const responseEnvelope: WsEnvelope = { type: 'response', payload: response };
                  ws.send(JSON.stringify(responseEnvelope));
                } else {
                  this.options.logger?.error(`[relay-channel] Cannot reply — WS not open (state=${ws.readyState})`);
                }
              };

              this.options.onMessage(message, reply);
            } else {
              this.options.logger?.warn(`[relay-channel] Unexpected WS message type: ${(envelope as any).type}`);
            }
          } catch (err) {
            this.options.logger?.error(`[relay-channel] Failed to parse WS message: ${err}`);
          }
        });

        ws.on('close', (code, reason) => {
          this.options.logger?.info(`[relay-channel] WebSocket client disconnected: ${code} ${reason.toString()}`);
        });

        ws.on('error', (err) => {
          this.options.logger?.error(`[relay-channel] WebSocket error: ${err.message}`);
        });
      });

      // Handle HTTP upgrade for WebSocket connections
      server.on('upgrade', (req, socket, head) => {
        const url = req.url ?? '';

        if (url !== '/relay/ws') {
          socket.destroy();
          return;
        }

        // Verify auth token
        const authHeader = req.headers['authorization'];
        const expected = `Bearer ${this.options.authToken}`;
        if (authHeader !== expected) {
          this.options.logger?.warn('[relay-channel] WS upgrade rejected: invalid auth');
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
          socket.destroy();
          return;
        }

        wss.handleUpgrade(req, socket, head, (ws) => {
          wss.emit('connection', ws, req);
        });
      });

      server.on('error', reject);
      server.listen(this.options.port, () => {
        this.server = server;
        this.wss = wss;
        this.options.logger?.info(`[relay-channel] Server listening on port ${this.options.port} (HTTP + WS)`);
        resolve();
      });
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      // Close all WebSocket connections
      if (this.wss) {
        for (const client of this.wss.clients) {
          client.close();
        }
        this.wss.close();
        this.wss = null;
      }

      if (!this.server) {
        resolve();
        return;
      }
      this.server.close(() => {
        this.server = null;
        this.options.logger?.info('[relay-channel] Server stopped');
        resolve();
      });
    });
  }

  private handleRequest(req: IncomingMessage, res: ServerResponse) {
    if (req.method === 'GET' && req.url === '/relay/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'ok',
        ready: true,
        wsClients: this.wss?.clients.size ?? 0,
      }));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  }
}
