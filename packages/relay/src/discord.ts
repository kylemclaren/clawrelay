// Discord Adapter - discord.js connection management

import {
  Client,
  GatewayIntentBits,
  Partials,
  type Message,
  type TextChannel,
  type DMChannel,
} from 'discord.js';
import type { ChannelAdapter, OnInboundMessage } from './adapter.js';
import type { RelayInboundMessage } from './types.js';
import { splitMessage } from './split-message.js';

export interface DiscordAdapterOptions {
  token: string;
  allowedGuilds?: string[];
  allowedChannels?: string[];
  onMessage: OnInboundMessage;
  logger?: any;
}

export class DiscordAdapter implements ChannelAdapter {
  readonly platform = 'discord';

  private client: Client;
  private options: DiscordAdapterOptions;

  constructor(options: DiscordAdapterOptions) {
    this.options = options;

    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
      partials: [
        Partials.Channel,  // Required for DM events
        Partials.Message,
      ],
    });

    this.client.on('messageCreate', (msg) => this.handleMessage(msg));

    this.client.on('clientReady', () => {
      options.logger?.info(`[relay] Discord connected as ${this.client.user?.tag}`);
    });

    this.client.on('error', (err) => {
      options.logger?.error(`[relay] Discord error: ${err.message}`);
    });
  }

  private handleMessage(message: Message) {
    // Skip own messages
    if (message.author.id === this.client.user?.id) return;

    // Skip bots
    if (message.author.bot) return;

    // Skip empty messages (e.g. image-only)
    if (!message.content?.trim()) return;

    // Guild allowlist
    if (message.guild && this.options.allowedGuilds?.length) {
      if (!this.options.allowedGuilds.includes(message.guild.id)) return;
    }

    // Channel allowlist
    if (this.options.allowedChannels?.length) {
      if (!this.options.allowedChannels.includes(message.channelId)) return;
    }

    // Convert Discord Message to RelayInboundMessage
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

    this.options.onMessage(inbound);
  }

  async sendTyping(channelId: string): Promise<void> {
    try {
      const channel = await this.client.channels.fetch(channelId);
      if (channel && 'sendTyping' in channel) {
        await (channel as TextChannel | DMChannel).sendTyping();
      }
    } catch (err) {
      this.options.logger?.debug(`[relay] Failed to send typing to ${channelId}: ${err}`);
    }
  }

  async sendMessage(channelId: string, content: string, replyToMessageId?: string): Promise<void> {
    const channel = await this.client.channels.fetch(channelId);
    if (!channel || !('send' in channel)) {
      throw new Error(`Cannot send to channel ${channelId}`);
    }

    const textChannel = channel as TextChannel | DMChannel;

    // Split messages exceeding Discord's 2000 char limit
    const chunks = splitMessage(content, 2000);

    for (let i = 0; i < chunks.length; i++) {
      const options: any = { content: chunks[i] };

      // Only reply to the original message on the first chunk
      if (i === 0 && replyToMessageId) {
        options.reply = { messageReference: replyToMessageId, failIfNotExists: false };
      }

      await textChannel.send(options);
    }
  }

  async login(): Promise<void> {
    await this.client.login(this.options.token);
  }

  async destroy(): Promise<void> {
    this.client.destroy();
    this.options.logger?.info('[relay] Discord client destroyed');
  }

  get botUserId(): string | undefined {
    return this.client.user?.id;
  }
}
