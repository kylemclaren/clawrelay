// Discord Adapter - discord.js connection management

import {
  Client,
  GatewayIntentBits,
  type Message,
  type TextChannel,
  type DMChannel,
} from 'discord.js';

export interface DiscordAdapterOptions {
  token: string;
  allowedGuilds?: string[];
  allowedChannels?: string[];
  onMessage: (message: Message) => void;
  logger?: any;
}

export class DiscordAdapter {
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
    });

    this.client.on('messageCreate', (msg) => this.handleMessage(msg));

    this.client.on('ready', () => {
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

    this.options.onMessage(message);
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

function splitMessage(content: string, maxLength: number): string[] {
  if (content.length <= maxLength) return [content];

  const chunks: string[] = [];
  let remaining = content;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    // Try to split at a newline near the limit
    let splitIdx = remaining.lastIndexOf('\n', maxLength);
    if (splitIdx < maxLength * 0.5) {
      // No good newline break, split at space
      splitIdx = remaining.lastIndexOf(' ', maxLength);
    }
    if (splitIdx < maxLength * 0.5) {
      // No good break at all, hard split
      splitIdx = maxLength;
    }

    chunks.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx).trimStart();
  }

  return chunks;
}
