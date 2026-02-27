# @openclaw/relay

Always-on Discord relay service. Maintains a persistent Discord WebSocket connection, queues incoming messages, optionally wakes a sleeping sandbox, forwards messages for AI processing, and delivers responses back to Discord.

## How it works

1. Discord message arrives via WebSocket
2. Message is queued and typing indicator starts
3. Wake manager checks sandbox health (and wakes it if needed)
4. Message is POSTed to the sandbox's `/relay/inbound` endpoint
5. Callback server waits for the sandbox to POST the response back to `/callback`
6. Response is sent to Discord as a reply

## Quick start

```bash
npm install
cp relay.config.example.json relay.config.json
# Edit relay.config.json with your values
npm start
```

## Configuration

Config is loaded from `relay.config.json` (or `RELAY_CONFIG` env) with environment variable overrides taking priority.

| Setting | Env var | Default |
|---|---|---|
| Discord token | `DISCORD_TOKEN` | required |
| Sandbox URL | `SANDBOX_PLUGIN_URL` | `http://localhost:7600` |
| Sandbox auth token | `SANDBOX_AUTH_TOKEN` | required |
| Health path | `SANDBOX_HEALTH_PATH` | `/relay/health` |
| Inbound path | `SANDBOX_INBOUND_PATH` | `/relay/inbound` |
| Wake enabled | `WAKE_ENABLED` | `false` |
| Wake URL | `WAKE_URL` | - |
| Callback port | `CALLBACK_PORT` | `7601` |
| Callback external URL | `CALLBACK_EXTERNAL_URL` | required |

## Deploy to Fly.io

```bash
fly launch --no-deploy
fly secrets set \
  DISCORD_TOKEN="..." \
  SANDBOX_AUTH_TOKEN="..." \
  CALLBACK_EXTERNAL_URL="https://your-app.fly.dev"
fly deploy
```

The `fly.toml` is configured with `auto_stop_machines = "off"` and `min_machines_running = 1` since the Discord WebSocket must stay connected. Keep it at 1 machine to avoid duplicate message processing.

## Source files

| File | Purpose |
|---|---|
| `src/index.ts` | Entry point, logger, graceful shutdown |
| `src/config.ts` | Config loader (file + env vars) |
| `src/relay.ts` | Core orchestration: queue, forward, callback, typing |
| `src/discord.ts` | discord.js adapter: connection, send, typing, message splitting |
| `src/callback-server.ts` | HTTP server receiving sandbox responses on `/callback` |
| `src/wake.ts` | Health polling and wake-on-message |
| `src/types.ts` | Shared protocol types |
