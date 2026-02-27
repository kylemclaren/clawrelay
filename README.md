<h1 align="center">🦞 ClawRelay 📡</h1>

A wake-on-message relay bridge that keeps Discord and Telegram bots permanently online while letting the AI backend (an OpenClaw sandbox/sprite) sleep to save costs.

The relay stays connected to Discord and Telegram 24/7, queues incoming messages, optionally wakes a stopped sandbox, connects to the OpenClaw gateway via WebSocket, forwards messages as `relay.inbound` method calls, and delivers responses back to the originating platform.

## Architecture

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/arch-dark.png">
  <source media="(prefers-color-scheme: light)" srcset="docs/arch-light.png">
  <img alt="Architecture diagram" src="docs/arch-light.png" width="700">
</picture>

## Packages

| Package | Description |
|---|---|
| [`packages/relay`](packages/relay) | Always-on relay service — Discord & Telegram adapters, message queue, wake manager, gateway WS client |
| [`packages/relay-channel`](packages/relay-channel) | OpenClaw channel plugin — registers `relay.inbound` gateway method and `/relay/health` HTTP route |

## How it works

1. Message arrives from Discord (WebSocket) or Telegram (long-polling)
2. The platform adapter normalizes the message into a common format
3. Message is queued; typing indicator starts on the originating platform
4. Wake manager checks gateway health at `/relay/health` (wakes sprite if needed)
5. Relay connects to the OpenClaw gateway WS and authenticates via the gateway protocol
6. Message is sent as a `relay.inbound` gateway method call
7. The channel plugin dispatches the message through the OpenClaw agent pipeline
8. Agent response is returned in the gateway method response
9. Relay delivers the response back to the originating platform as a reply

## Features

- **Multi-platform** — Supports Discord and Telegram via a shared adapter interface; run one or both simultaneously
- **Gateway protocol** — Relay authenticates as a gateway client and sends messages as method calls (no separate server port needed)
- **Wake-on-message** — Wakes a sleeping sprite on first message, polls `/relay/health` until ready
- **Message queue** — In-memory FIFO with 5-minute TTL, serial processing
- **DM support** — Handles both guild channels and direct messages (Discord) and private/group chats (Telegram)
- **Typing indicators** — Shows typing while waiting for AI response (refreshed every 8s, max 3 min)
- **Message splitting** — Splits responses respecting platform limits (Discord 2000 chars, Telegram 4096 chars)
- **Allowlists** — Restrict which Discord servers/channels or Telegram chats the bot responds in
- **Graceful shutdown** — Clean teardown on SIGINT/SIGTERM

## Configuration

Config is loaded from `relay.config.json` (or `RELAY_CONFIG` env) with environment variable overrides. See [`relay.config.example.json`](packages/relay/relay.config.example.json) for all options.

| Setting | Env var | Default |
|---|---|---|
| Discord token | `DISCORD_TOKEN` | — |
| Telegram bot token | `TELEGRAM_BOT_TOKEN` | — |
| Gateway URL | `GATEWAY_URL` | `http://localhost:18789` |
| Gateway auth token | `GATEWAY_AUTH_TOKEN` | — (required) |
| Health path | `GATEWAY_HEALTH_PATH` | `/relay/health` |
| Wake enabled | `WAKE_ENABLED` | `false` |
| Wake URL | `WAKE_URL` | — |
| Health server port | `HEALTH_PORT` | `8080` |

At least one platform token (Discord or Telegram) is required. Both can be configured to run simultaneously.

## Deployment

### Fly.io + Sprites

The relay runs on Fly.io, connected to an OpenClaw gateway running on a sprite.

```bash
# Deploy the relay
cd packages/relay
fly deploy
fly secrets set DISCORD_TOKEN="..." TELEGRAM_BOT_TOKEN="..." GATEWAY_AUTH_TOKEN="..."
```

The gateway URL is set in `fly.toml` via the `GATEWAY_URL` env var, pointing to the sprite's public URL (e.g. `https://my-app.sprites.app`).

On the sprite, install the channel plugin and start the gateway:

```bash
openclaw plugins install clawrelay    # First install
openclaw plugins update clawrelay     # Update to latest
openclaw onboard    # Configure the relay channel auth token
openclaw gateway --allow-unconfigured
```

### Docker Compose (local)

```bash
export DISCORD_TOKEN=your-token
export TELEGRAM_BOT_TOKEN=your-bot-token
export OPENCLAW_GATEWAY_TOKEN=your-gateway-token

docker compose --profile discord up
```

This starts both the OpenClaw gateway and the relay service. Omit either token to run only one platform.

## Development

Requires Bun. TypeScript is run directly (no build step).

```bash
cd packages/relay
bun install
bun start
```

## License

MIT
