# clawrelay

OpenClaw channel plugin that receives forwarded messages from an always-on relay proxy (ClawRelay), dispatches them through the agent pipeline, and sends responses back via the gateway protocol.

## How it works

1. Plugin registers a `relay.inbound` gateway method and a `/relay/health` HTTP route on the gateway's existing server
2. The relay service connects to the gateway via WebSocket and authenticates using the gateway protocol
3. Inbound messages arrive as `relay.inbound` method calls (with an optional `streaming` flag)
4. Messages are dispatched through the OpenClaw agent pipeline
5. In streaming mode, partial text is sent back to the relay client as `relay.stream.delta` events via `onPartialReply`, followed by a `relay.stream.done` event with the final response
6. In non-streaming mode, the complete response is returned in the gateway method response

## Installation

Install from npm:

```bash
openclaw plugins install clawrelay
```

Or install from a local path during development:

```bash
openclaw plugins install ./packages/relay-channel
```

Update to the latest version:

```bash
openclaw plugins update clawrelay
```

Or install from a tarball:

```bash
cd packages/relay-channel && npm pack
openclaw plugins install clawrelay-0.4.0.tgz
```

## Gateway configuration

Add to `~/.openclaw/openclaw.json`:

```json
{
  "channels": {
    "relay": {
      "enabled": true
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

Authentication is handled by the gateway's own auth token (`gateway.auth.token`).

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
| Gateway event | `relay.stream.delta` | Streaming partial text back to the relay client |
| Gateway event | `relay.stream.done` | Final response (or error) sent when streaming completes |

## Source files

| File | Purpose |
|---|---|
| `src/index.ts` | Plugin entry point, gateway method + HTTP route registration |
| `src/channel.ts` | Channel definition, config resolution, onboarding |
| `src/gateway-handler.ts` | `relay.inbound` gateway method handler |
| `src/health-handler.ts` | HTTP health route handler |
| `src/onboarding.ts` | Setup wizard (enable channel, sprite gateway service) |
| `src/runtime.ts` | OpenClaw runtime accessor |
| `src/types.ts` | Protocol and config types |

## Links

- [ClawRelay](https://github.com/kylemclaren/clawrelay) — relay proxy + plugin monorepo
- [OpenClaw Plugin Docs](https://docs.openclaw.ai/tools/plugin#plugins)
