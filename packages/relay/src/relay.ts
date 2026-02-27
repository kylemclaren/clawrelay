// Relay - Core orchestration (queue, wake, WS forwarding)

import type { Message } from 'discord.js';
import type { RelayConfig } from './config.js';
import type { RelayInboundMessage, QueueEntry } from './types.js';
import { DiscordAdapter } from './discord.js';
import { WakeManager } from './wake.js';
import { WsClient } from './ws-client.js';
import { HealthServer } from './health-server.js';

const QUEUE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const TYPING_REFRESH_MS = 8_000;
const TYPING_MAX_MS = 3 * 60 * 1000; // 3 minutes

export class Relay {
  private discord: DiscordAdapter;
  private wake: WakeManager;
  private ws: WsClient;
  private healthServer: HealthServer;
  private config: RelayConfig;
  private logger: any;

  private queue: QueueEntry[] = [];
  private processing = false;

  constructor(config: RelayConfig, logger?: any) {
    this.config = config;
    this.logger = logger ?? console;

    this.discord = new DiscordAdapter({
      token: config.discord.token,
      allowedGuilds: config.discord.allowedGuilds,
      allowedChannels: config.discord.allowedChannels,
      onMessage: (msg) => this.onDiscordMessage(msg),
      logger: this.logger,
    });

    this.wake = new WakeManager(config, this.logger);
    this.ws = new WsClient(config, this.logger);
    this.healthServer = new HealthServer(config.healthServer.port, this.ws, this.logger);
  }

  async start(): Promise<void> {
    await this.healthServer.start();
    // WS connects on-demand when first message arrives — no persistent connection
    await this.discord.login();
    this.logger.info('[relay] Relay started');
  }

  async stop(): Promise<void> {
    this.logger.info('[relay] Shutting down...');
    await this.discord.destroy();
    this.ws.stop();
    await this.healthServer.stop();
    this.logger.info('[relay] Relay stopped');
  }

  private onDiscordMessage(message: Message) {
    const isDM = !message.guild;
    const guildId = message.guild?.id;
    const guildName = message.guild?.name;
    const channelName = 'name' in message.channel ? (message.channel as any).name : 'DM';

    const groupName = isDM
      ? undefined
      : `${guildName} #${channelName}`;

    const inbound: RelayInboundMessage = {
      messageId: message.id,
      platform: 'discord',
      channelId: message.channelId,
      guildId,
      senderId: message.author.id,
      senderName: message.member?.displayName ?? message.author.displayName ?? message.author.username,
      content: message.content,
      chatType: isDM ? 'direct' : 'group',
      groupName,
      timestamp: message.createdTimestamp,
    };

    const entry: QueueEntry = {
      message: inbound,
      discordChannelId: message.channelId,
      discordMessageId: message.id,
      enqueuedAt: Date.now(),
    };

    this.queue.push(entry);
    this.logger.info(`[relay] Queued message ${message.id} from ${inbound.senderName} in ${groupName ?? 'DM'}`);

    // Start typing immediately
    this.discord.sendTyping(message.channelId);

    this.processQueue();
  }

  private async processQueue(): Promise<void> {
    if (this.processing) return;
    this.processing = true;

    try {
      while (this.queue.length > 0) {
        // Prune expired entries
        const now = Date.now();
        this.queue = this.queue.filter((e) => {
          if (now - e.enqueuedAt > QUEUE_TTL_MS) {
            this.logger.warn(`[relay] Dropping expired message ${e.message.messageId}`);
            return false;
          }
          return true;
        });

        if (this.queue.length === 0) break;

        // Ensure WS is connected (wake sprite if needed)
        try {
          await this.ensureWsConnected();
        } catch (err) {
          this.logger.error(`[relay] Cannot connect to sprite, dropping ${this.queue.length} queued messages: ${err}`);
          for (const entry of this.queue) {
            await this.sendError(entry.discordChannelId, 'Sandbox is not available. Please try again later.', entry.discordMessageId);
          }
          this.queue = [];
          break;
        }

        // Process FIFO
        const entry = this.queue.shift()!;
        await this.forwardAndRespond(entry);
      }
    } finally {
      this.processing = false;
    }
  }

  /**
   * Ensure the WS connection is established. If not connected, wake the sprite
   * first (if wake is enabled), then wait for the WS to connect.
   */
  private async ensureWsConnected(): Promise<void> {
    if (this.ws.connected) return;

    // Try waking the sprite first so the WS server is available
    await this.wake.ensureReady();

    // Now wait for WS to connect (it auto-reconnects in background)
    await this.ws.ensureConnected();
  }

  private async forwardAndRespond(entry: QueueEntry): Promise<void> {
    const { message, discordChannelId, discordMessageId } = entry;

    // Typing indicator with refresh
    let typingActive = true;
    const typingInterval = setInterval(() => {
      if (typingActive) this.discord.sendTyping(discordChannelId);
    }, TYPING_REFRESH_MS);
    const typingTimeout = setTimeout(() => {
      typingActive = false;
      clearInterval(typingInterval);
    }, TYPING_MAX_MS);

    const stopTyping = () => {
      typingActive = false;
      clearInterval(typingInterval);
      clearTimeout(typingTimeout);
    };

    try {
      // Register response handler FIRST to avoid race condition
      const responsePromise = this.ws.waitForResponse(message.messageId);

      // Send as gateway method call
      this.ws.sendRelayMessage(message);

      this.logger.info(`[relay] Sent relay.inbound for message ${message.messageId}`);

      // Wait for response over WS
      const response = await responsePromise;

      stopTyping();

      // Send to Discord
      await this.discord.sendMessage(discordChannelId, response.content, discordMessageId);
      this.logger.info(`[relay] Delivered response for message ${message.messageId}`);
    } catch (err) {
      stopTyping();
      const errMsg = err instanceof Error ? err.message : String(err);
      this.logger.error(`[relay] Failed to process message ${message.messageId}: ${errMsg}`);
      this.wake.markUnknown();
      await this.sendError(discordChannelId, `Something went wrong processing your message.`, discordMessageId);
    }
  }

  private async sendError(channelId: string, text: string, replyTo?: string): Promise<void> {
    try {
      await this.discord.sendMessage(channelId, text, replyTo);
    } catch (err) {
      this.logger.error(`[relay] Failed to send error message: ${err}`);
    }
  }
}
