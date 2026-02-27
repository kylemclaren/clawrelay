// HTTP health route handler for /relay/health
//
// Registered on the gateway's HTTP server via api.registerHttpRoute.

import type { IncomingMessage, ServerResponse } from 'node:http';

export function relayHealthHandler(_req: IncomingMessage, res: ServerResponse): void {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ status: 'ok', ready: true }));
}
