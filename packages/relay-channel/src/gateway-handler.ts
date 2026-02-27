// Gateway method handler for relay.inbound
//
// Registered as a gateway method so the relay service can call it via the
// gateway WS protocol instead of needing a standalone HTTP+WS server.

import type { RelayAccount, RelayInboundMessage } from './types.js';
import { getRelayRuntime } from './runtime.js';

const CHANNEL_ID = 'relay' as const;

/**
 * Creates the `relay.inbound` gateway method handler.
 * The handler receives params `{ accountId?, message }`, processes the message
 * through the agent pipeline, and responds with the agent's reply.
 */
export function createRelayInboundHandler(api: any) {
  const logger = api.logger;

  return async (opts: {
    req: any;
    params: Record<string, unknown>;
    client: any;
    respond: (ok: boolean, payload?: unknown, error?: unknown) => void;
    context: any;
  }) => {
    const { params, respond } = opts;

    const message = params.message as RelayInboundMessage | undefined;
    if (!message || !message.messageId || !message.content) {
      respond(false, undefined, {
        code: 'INVALID_PARAMS',
        message: 'Missing or invalid "message" in params',
      });
      return;
    }

    // Resolve the account — use accountId from params or fall back to default
    const accountId = (params.accountId as string) ?? 'default';
    const config = api.config;
    const accounts = config.channels?.relay?.accounts ?? {};
    const accountData = accounts[accountId] ?? config.channels?.relay;

    if (!accountData) {
      respond(false, undefined, {
        code: 'NOT_FOUND',
        message: `Relay account "${accountId}" not configured`,
      });
      return;
    }

    const account: RelayAccount = {
      accountId,
      authToken: accountData.authToken ?? '',
      enabled: accountData.enabled !== false,
    };

    if (!account.enabled) {
      respond(false, undefined, {
        code: 'UNAVAILABLE',
        message: `Relay account "${accountId}" is not enabled`,
      });
      return;
    }

    try {
      const responseContent = await processRelayMessage({
        message,
        account,
        config,
        log: logger,
      });

      respond(true, {
        messageId: message.messageId,
        content: responseContent,
        replyToMessageId: message.messageId,
      });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.error(`[clawrelay] Failed to process inbound: ${errMsg}`);
      respond(false, undefined, {
        code: 'INTERNAL_ERROR',
        message: `Error processing message: ${errMsg}`,
      });
    }
  };
}


// --- Inbound message processing (extracted from channel.ts) ---

function resolveSessionKey(message: RelayInboundMessage): string {
  if (message.chatType === 'direct') {
    return `relay:${message.platform}:dm:${message.senderId}`;
  }
  return `relay:${message.platform}:${message.guildId ?? 'unknown'}:${message.channelId}`;
}

function resolvePeerId(message: RelayInboundMessage): string {
  if (message.chatType === 'direct') {
    return `relay:${message.platform}:dm:${message.senderId}`;
  }
  return `relay:${message.platform}:${message.guildId ?? 'unknown'}:${message.channelId}`;
}

async function processRelayMessage(params: {
  message: RelayInboundMessage;
  account: RelayAccount;
  config: any;
  log: any;
}): Promise<string> {
  const { message, account, config, log } = params;

  const core = getRelayRuntime();
  const peerId = resolvePeerId(message);

  // Resolve agent route
  const route = core.channel.routing.resolveAgentRoute({
    cfg: config,
    channel: CHANNEL_ID,
    accountId: account.accountId,
    peer: {
      kind: message.chatType === 'direct' ? 'direct' : 'group',
      id: peerId,
    },
  });

  // Resolve session store path
  const storePath = core.channel.session.resolveStorePath(config.session?.store, {
    agentId: route.agentId,
  });

  // Format envelope
  const envelopeOptions = core.channel.reply.resolveEnvelopeFormatOptions(config);
  const previousTimestamp = core.channel.session.readSessionUpdatedAt({
    storePath,
    sessionKey: route.sessionKey,
  });

  const fromLabel = `${message.platform}:${message.senderName}`;
  const body = core.channel.reply.formatAgentEnvelope({
    channel: `relay:${message.platform}`,
    from: fromLabel,
    timestamp: message.timestamp,
    previousTimestamp,
    envelope: envelopeOptions,
    body: message.content,
  });

  // Build finalized message context
  const ctxPayload = core.channel.reply.finalizeInboundContext({
    Body: body,
    BodyForAgent: body,
    RawBody: message.content,
    CommandBody: message.content,
    From: peerId,
    To: peerId,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: message.chatType,
    ConversationLabel: fromLabel,
    SenderName: message.senderName,
    SenderId: message.senderId,
    GroupSubject: message.groupName ?? message.channelId,
    Provider: CHANNEL_ID,
    Surface: CHANNEL_ID,
    Timestamp: message.timestamp,
    OriginatingChannel: CHANNEL_ID,
    OriginatingTo: peerId,
  });

  // Record inbound session
  await core.channel.session.recordInboundSession({
    storePath,
    sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
    ctx: ctxPayload,
    onRecordError: (err: unknown) => {
      log?.error(`[clawrelay] Failed updating session meta: ${String(err)}`);
    },
  });

  // Dispatch reply — collect all deliver() calls into a single buffer
  const parts: string[] = [];

  await core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: ctxPayload,
    cfg: config,
    dispatcherOptions: {
      deliver: async (payload: { text?: string }) => {
        const text = payload.text ?? '';
        if (text.trim()) {
          parts.push(text);
        }
      },
      onError: (err: unknown, info: { kind: string }) => {
        log?.error(`[clawrelay] ${info.kind} reply failed: ${String(err)}`);
      },
    },
  });

  log?.info(`[clawrelay] Processed message ${message.messageId} from ${message.senderName}`);

  return parts.join('\n');
}
