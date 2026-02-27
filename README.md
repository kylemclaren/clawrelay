<h1 align="center">🦞 ClawRelay 📡</h1>

A wake-on-message relay bridge that keeps a Discord bot permanently online while letting the AI backend (an OpenClaw sandbox/sprite) sleep to save costs.

The relay stays connected to Discord 24/7, queues incoming messages, optionally wakes a stopped sandbox, connects to the OpenClaw gateway via WebSocket, forwards messages as `relay.inbound` method calls, and delivers responses back to Discord.

## Architecture

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/arch-dark.png">
  <source media="(prefers-color-scheme: light)" srcset="docs/arch-light.png">
  <img alt="Architecture diagram" src="docs/arch-light.png" width="700">
</picture>

## Packages

| Package | Description |
|---|---|
| [`packages/relay`](packages/relay) | Always-on relay service — Discord gateway, message queue, wake manager, gateway WS client |
| [`packages/relay-channel`](packages/relay-channel) | OpenClaw channel plugin — registers `relay.inbound` gateway method and `/relay/health` HTTP route |

## How it works

1. Discord message arrives at the relay service via Discord WebSocket
2. Message is queued; typing indicator starts in Discord
3. Wake manager checks gateway health at `/relay/health` (wakes sprite if needed)
4. Relay connects to the OpenClaw gateway WS and authenticates via the gateway protocol
5. Message is sent as a `relay.inbound` gateway method call
6. The channel plugin dispatches the message through the OpenClaw agent pipeline
7. Agent response is returned in the gateway method response
8. Relay delivers the response back to Discord as a reply

## Features

- **Gateway protocol** — Relay authenticates as a gateway client and sends messages as method calls (no separate server port needed)
- **Wake-on-message** — Wakes a sleeping sprite on first message, polls `/relay/health` until ready
- **Message queue** — In-memory FIFO with 5-minute TTL, serial processing
- **DM support** — Handles both guild channels and direct messages
- **Typing indicators** — Shows typing while waiting for AI response (refreshed every 8s, max 3 min)
- **Message splitting** — Splits responses exceeding Discord's 2000-char limit at newlines/spaces
- **Guild/channel allowlists** — Restrict which servers and channels the bot responds in
- **Graceful shutdown** — Clean teardown on SIGINT/SIGTERM

## Configuration

Config is loaded from `relay.config.json` (or `RELAY_CONFIG` env) with environment variable overrides. See [`relay.config.example.json`](packages/relay/relay.config.example.json) for all options.

| Setting | Env var | Default |
|---|---|---|
| Discord token | `DISCORD_TOKEN` | — (required) |
| Gateway URL | `GATEWAY_URL` | `http://localhost:18789` |
| Gateway auth token | `GATEWAY_AUTH_TOKEN` | — (required) |
| Health path | `GATEWAY_HEALTH_PATH` | `/relay/health` |
| Wake enabled | `WAKE_ENABLED` | `false` |
| Wake URL | `WAKE_URL` | — |
| Health server port | `HEALTH_PORT` | `8080` |

## Deployment

### Fly.io + Sprites

The relay runs on Fly.io, connected to an OpenClaw gateway running on a sprite.

```bash
# Deploy the relay
cd packages/relay
fly deploy
fly secrets set DISCORD_TOKEN="..." GATEWAY_AUTH_TOKEN="..."
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
export OPENCLAW_GATEWAY_TOKEN=your-gateway-token

docker compose --profile discord up
```

This starts both the OpenClaw gateway and the relay service.

## Development

Requires Bun. TypeScript is run directly (no build step).

```bash
cd packages/relay
bun install
bun start
```

## License

MIT
