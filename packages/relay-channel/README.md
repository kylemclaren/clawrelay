# clawrelay

OpenClaw channel plugin that receives forwarded messages from an always-on relay proxy (ClawRelay), dispatches them through the agent pipeline, and sends responses back via the gateway protocol.

## How it works

1. Plugin registers a `relay.inbound` gateway method and a `/relay/health` HTTP route on the gateway's existing server
2. The relay service connects to the gateway via WebSocket and authenticates using the gateway protocol
3. Inbound messages arrive as `relay.inbound` method calls
4. Messages are dispatched through the OpenClaw agent pipeline
5. Agent responses are returned in the gateway method response

## Installation

Install from npm:

```bash
openclaw plugins install clawrelay
```

Or install from a local path during development:

```bash
openclaw plugins install ./packages/relay-channel
```

Or install from a tarball:

```bash
cd packages/relay-channel && npm pack
openclaw plugins install clawrelay-0.3.0.tgz
```

## Gateway configuration

Add to `~/.openclaw/openclaw.json`:

```json
{
  "channels": {
    "relay": {
      "accounts": {
        "default": {
          "authToken": "optional-per-account-token"
        }
      }
    }
  },
  "plugins": {
    "allow": ["clawrelay"],
    "entries": {
      "clawrelay": { "enabled": true }
    }
  }
}
```

The gateway's own auth token (in `gateway.auth.token`) is used for authentication. The relay account `authToken` is an optional per-account verification token.

## Verify installation

```bash
openclaw plugins list
openclaw plugins info clawrelay
openclaw plugins doctor
```

## Endpoints

| Type | Path/Method | Description |
|---|---|---|
| HTTP | `GET /relay/health` | Health check — returns `{"status":"ok","ready":true}` |
| Gateway | `relay.inbound` | Gateway method for receiving relay messages |

## Source files

| File | Purpose |
|---|---|
| `src/index.ts` | Plugin entry point, gateway method + HTTP route registration |
| `src/channel.ts` | Channel definition, config resolution, onboarding |
| `src/gateway-handler.ts` | `relay.inbound` gateway method handler |
| `src/health-handler.ts` | HTTP health route handler |
| `src/onboarding.ts` | Setup wizard (auth token, sprite service) |
| `src/runtime.ts` | OpenClaw runtime accessor |
| `src/types.ts` | Protocol and config types |

## Links

- [ClawRelay](https://github.com/kylemclaren/clawrelay) — relay proxy + plugin monorepo
- [OpenClaw Plugin Docs](https://docs.openclaw.ai/tools/plugin#plugins)
