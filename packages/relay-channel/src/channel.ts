// Relay Channel Plugin Definition

import type { RelayAccount, RelayInboundMessage, RelayOutboundMessage, ReplyFn } from './types.js';
import { InboundServer } from './inbound-server.js';
import { getRelayRuntime } from './runtime.js';

const CHANNEL_ID = 'relay' as const;

// Store active inbound servers per account
const servers = new Map<string, InboundServer>();

export function createRelayChannel(api: any) {
  const logger = api.logger;

  const channel = {
    id: CHANNEL_ID,

    meta: {
      id: CHANNEL_ID,
      label: 'Channel Relay',
      selectionLabel: 'Relay (Discord/Telegram via proxy)',
      docsPath: '/channels/relay',
      blurb: 'Wake-on-message proxy for Discord/Telegram via always-on relay',
      aliases: ['relay'],
    },

    capabilities: {
      chatTypes: ['direct', 'group'],
      media: {
        images: false,
        audio: false,
        video: false,
        documents: false,
      },
      reactions: false,
      threads: false,
      mentions: false,
    },

    config: {
      listAccountIds: (cfg: any) => {
        return Object.keys(cfg.channels?.relay?.accounts ?? {});
      },

      resolveAccount: (cfg: any, accountId?: string): RelayAccount | undefined => {
        const accounts = cfg.channels?.relay?.accounts ?? {};
        const id = accountId ?? 'default';
        const account = accounts[id];
        if (!account) return undefined;

        return {
          accountId: id,
          authToken: account.authToken,
          port: account.port ?? 7600,
          enabled: account.enabled !== false,
        };
      },
    },

    gateway: {
      startAccount: async (ctx: any) => {
        const account = ctx.account as RelayAccount;
        const accountId = account.accountId ?? 'default';

        logger.info(`[relay-channel] startAccount called for ${accountId}`);

        if (!account.enabled) {
          logger.info(`[relay-channel] Account ${accountId} not enabled, skipping`);
          return;
        }

        if (servers.has(accountId)) {
          logger.warn(`[relay-channel] Server already running for ${accountId}, skipping`);
          return;
        }

        const server = new InboundServer({
          port: account.port,
          authToken: account.authToken,
          logger: ctx.log ?? logger,
          onMessage: (message: RelayInboundMessage, reply: ReplyFn) => {
            handleRelayInbound({
              message,
              reply,
              account,
              config: ctx.cfg,
              log: ctx.log ?? logger,
            }).catch((err) => {
              const errMsg = err instanceof Error ? err.message : String(err);
              (ctx.log ?? logger).error(`[relay-channel] Failed to process inbound: ${errMsg}`);
              // Best-effort error response over WS
              reply({
                messageId: message.messageId,
                content: `[Relay Plugin] Error processing message: ${errMsg}`,
                replyToMessageId: message.messageId,
              });
            });
          },
        });

        servers.set(accountId, server);

        // Listen for abort signal
        if (ctx.abortSignal) {
          ctx.abortSignal.addEventListener('abort', () => {
            (ctx.log ?? logger).info(`[relay-channel] Received abort signal for ${accountId}`);
            const srv = servers.get(accountId);
            if (srv) {
              srv.stop();
              servers.delete(accountId);
            }
          }, { once: true });
        }

        try {
          await server.start();
          (ctx.log ?? logger).info(`[relay-channel] Server started for ${accountId} on port ${account.port}`);
        } catch (err) {
          (ctx.log ?? logger).error(`[relay-channel] Failed to start server for ${accountId}: ${err}`);
          servers.delete(accountId);
        }
      },

      stopAccount: async (ctx: any) => {
        const accountId = ctx.account?.accountId ?? 'default';
        const server = servers.get(accountId);
        if (server) {
          await server.stop();
          servers.delete(accountId);
          (ctx.log ?? logger).info(`[relay-channel] Server stopped for ${accountId}`);
        }
      },
    },

    outbound: {
      deliveryMode: 'direct' as const,

      sendText: async ({
        text,
        chatId,
        accountId,
        cfg,
      }: {
        text: string;
        chatId: string;
        accountId?: string;
        cfg: any;
      }) => {
        // Outbound via sendText is not the primary path for relay-channel.
        // The main response path is via WebSocket reply.
        // This exists for completeness if OpenClaw core needs to send proactively.
        logger.warn(`[relay-channel] sendText called for chatId=${chatId} — relay-channel uses WS for responses`);
        return { ok: false, error: 'Relay channel uses WebSocket for responses, not sendText' };
      },
    },

    status: {
      getHealth: (accountId: string) => {
        const server = servers.get(accountId);
        if (!server) {
          return { status: 'disconnected', message: 'Server not running' };
        }
        return { status: 'connected', message: 'Server listening (HTTP + WS)' };
      },
    },
  };

  return channel;
}


// --- Inbound message handler using OpenClaw runtime ---

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

async function handleRelayInbound(params: {
  message: RelayInboundMessage;
  reply: ReplyFn;
  account: RelayAccount;
  config: any;
  log: any;
}): Promise<void> {
  const { message, reply, account, config, log } = params;

  let core;
  try {
    core = getRelayRuntime();
  } catch (err) {
    log?.error(`[relay-channel] Runtime not initialized: ${err}`);
    return;
  }

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
      log?.error(`[relay-channel] Failed updating session meta: ${String(err)}`);
    },
  });

  // Dispatch reply — triggers agent processing and delivers response via WS
  await core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: ctxPayload,
    cfg: config,
    dispatcherOptions: {
      deliver: async (payload: { text?: string }) => {
        const text = payload.text ?? '';
        if (!text.trim()) return;

        reply({
          messageId: message.messageId,
          content: text,
          replyToMessageId: message.messageId,
        });
      },
      onError: (err: unknown, info: { kind: string }) => {
        log?.error(`[relay-channel] ${info.kind} reply failed: ${String(err)}`);
      },
    },
  });

  log?.info(`[relay-channel] Processed message ${message.messageId} from ${message.senderName}`);
}
