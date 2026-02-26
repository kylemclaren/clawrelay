// Relay - Core orchestration (queue, wake, forward, callback)

import type { Message } from 'discord.js';
import type { RelayConfig } from './config.js';
import type { RelayInboundMessage, QueueEntry } from './types.js';
import { DiscordAdapter } from './discord.js';
import { WakeManager } from './wake.js';
import { CallbackServer } from './callback-server.js';

const QUEUE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const TYPING_REFRESH_MS = 8_000;
const TYPING_MAX_MS = 3 * 60 * 1000; // 3 minutes

export class Relay {
  private discord: DiscordAdapter;
  private wake: WakeManager;
  private callbackServer: CallbackServer;
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
    this.callbackServer = new CallbackServer(config.callbackServer.port, this.logger);
  }

  async start(): Promise<void> {
    await this.callbackServer.start();
    await this.discord.login();
    this.logger.info('[relay] Relay started');
  }

  async stop(): Promise<void> {
    this.logger.info('[relay] Shutting down...');
    await this.discord.destroy();
    await this.callbackServer.stop();
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
      callbackUrl: `${this.config.callbackServer.externalUrl}/callback`,
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

        // Ensure sandbox is ready
        try {
          await this.wake.ensureReady();
        } catch (err) {
          this.logger.error(`[relay] Sandbox not ready, dropping ${this.queue.length} queued messages: ${err}`);
          // Send error to Discord for each queued message
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
      // Register callback FIRST to avoid race condition
      const callbackPromise = this.callbackServer.waitForResponse(message.messageId);

      // Forward to plugin
      const inboundUrl = `${this.config.sandbox.pluginUrl}${this.config.sandbox.inboundPath}`;
      const res = await fetch(inboundUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.config.sandbox.authToken}`,
        },
        body: JSON.stringify(message),
      });

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Plugin rejected message: ${res.status} ${errText}`);
      }

      this.logger.info(`[relay] Forwarded message ${message.messageId} to plugin`);

      // Wait for callback response
      const response = await callbackPromise;

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
