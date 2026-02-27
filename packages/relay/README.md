# @openclaw/relay

Always-on Discord relay service. Maintains a persistent Discord WebSocket connection, queues incoming messages, optionally wakes a sleeping sandbox, forwards messages to the OpenClaw gateway for AI processing, and delivers responses back to Discord.

## How it works

1. Discord message arrives via WebSocket
2. Message is queued and typing indicator starts
3. Wake manager checks gateway health (and wakes it if needed)
4. Relay connects to the OpenClaw gateway WS and authenticates via the gateway protocol
5. Message is sent as a `relay.inbound` gateway method call
6. Gateway response is delivered back to Discord as a reply

## Quick start

```bash
bun install
cp relay.config.example.json relay.config.json
# Edit relay.config.json with your values
bun start
```

## Configuration

Config is loaded from `relay.config.json` (or `RELAY_CONFIG` env) with environment variable overrides taking priority.

| Setting | Env var | Default |
|---|---|---|
| Discord token | `DISCORD_TOKEN` | required |
| Gateway URL | `GATEWAY_URL` | `http://localhost:18789` |
| Gateway auth token | `GATEWAY_AUTH_TOKEN` | required |
| Health path | `GATEWAY_HEALTH_PATH` | `/relay/health` |
| Wake enabled | `WAKE_ENABLED` | `false` |
| Wake URL | `WAKE_URL` | - |
| Health server port | `HEALTH_PORT` | `8080` |

## Deploy to Fly.io

```bash
fly launch --no-deploy
fly secrets set \
  DISCORD_TOKEN="..." \
  GATEWAY_AUTH_TOKEN="..."
fly deploy
```

The `fly.toml` is configured with `auto_stop_machines = "off"` and `min_machines_running = 1` since the Discord WebSocket must stay connected. Keep it at 1 machine to avoid duplicate message processing.

## Source files

| File | Purpose |
|---|---|
| `src/index.ts` | Entry point, logger, graceful shutdown |
| `src/config.ts` | Config loader (file + env vars) |
| `src/relay.ts` | Core orchestration: queue, forward, typing |
| `src/discord.ts` | discord.js adapter: connection, send, typing, message splitting |
| `src/ws-client.ts` | Gateway protocol WS client (connect handshake, method calls) |
| `src/wake.ts` | Health polling and wake-on-message |
| `src/health-server.ts` | Local health server for Fly.io checks |
| `src/types.ts` | Shared protocol and gateway frame types |
