// Telegram Adapter - grammY connection management with long-polling

import { Bot } from 'grammy';
import type { ChannelAdapter, OnInboundMessage } from './adapter.js';
import type { RelayInboundMessage } from './types.js';
import { splitMessage } from './split-message.js';

export interface TelegramAdapterOptions {
  botToken: string;
  allowedChats?: string[];
  onMessage: OnInboundMessage;
  logger?: any;
}

export class TelegramAdapter implements ChannelAdapter {
  readonly platform = 'telegram';

  private bot: Bot;
  private options: TelegramAdapterOptions;

  constructor(options: TelegramAdapterOptions) {
    this.options = options;
    this.bot = new Bot(options.botToken);

    this.bot.on('message:text', (ctx) => this.handleMessage(ctx));

    this.bot.catch((err) => {
      options.logger?.error(`[relay] Telegram error: ${err.message}`);
    });
  }

  private handleMessage(ctx: any) {
    const message = ctx.message;
    if (!message) return;

    // Skip bots
    if (message.from?.is_bot) return;

    // Skip empty messages
    if (!message.text?.trim()) return;

    // Chat allowlist
    const chatId = String(message.chat.id);
    if (this.options.allowedChats?.length) {
      if (!this.options.allowedChats.includes(chatId)) return;
    }

    const isGroup = message.chat.type === 'group' || message.chat.type === 'supergroup';
    const groupName = isGroup
      ? (message.chat.title ?? undefined)
      : undefined;

    const senderName = [message.from?.first_name, message.from?.last_name]
      .filter(Boolean)
      .join(' ') || message.from?.username || 'Unknown';

    const inbound: RelayInboundMessage = {
      messageId: String(message.message_id),
      platform: 'telegram',
      channelId: chatId,
      senderId: String(message.from?.id ?? ''),
      senderName,
      content: message.text,
      chatType: isGroup ? 'group' : 'direct',
      groupName,
      timestamp: message.date * 1000, // Telegram uses Unix seconds
    };

    this.options.onMessage(inbound);
  }

  async sendTyping(channelId: string): Promise<void> {
    try {
      await this.bot.api.sendChatAction(channelId, 'typing');
    } catch (err) {
      this.options.logger?.debug(`[relay] Failed to send typing to Telegram chat ${channelId}: ${err}`);
    }
  }

  async sendMessage(channelId: string, content: string, replyToMessageId?: string): Promise<void> {
    // Split messages exceeding Telegram's 4096 char limit
    const chunks = splitMessage(content, 4096);

    for (let i = 0; i < chunks.length; i++) {
      const options: any = {};

      // Only reply to the original message on the first chunk
      if (i === 0 && replyToMessageId) {
        options.reply_parameters = { message_id: Number(replyToMessageId) };
      }

      await this.bot.api.sendMessage(channelId, chunks[i], options);
    }
  }

  async login(): Promise<void> {
    // Start long-polling in the background (non-blocking)
    this.bot.start({
      onStart: (botInfo) => {
        this.options.logger?.info(`[relay] Telegram connected as @${botInfo.username}`);
      },
    });
  }

  async destroy(): Promise<void> {
    await this.bot.stop();
    this.options.logger?.info('[relay] Telegram bot stopped');
  }
}
