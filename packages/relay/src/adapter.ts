// Channel Adapter - Platform-agnostic interface for messaging platforms

import type { RelayInboundMessage } from './types.js';

export type OnInboundMessage = (message: RelayInboundMessage) => void;

export interface ChannelAdapter {
  readonly platform: string;
  readonly maxMessageLength: number;
  login(): Promise<void>;
  destroy(): Promise<void>;
  sendTyping(channelId: string): Promise<void>;
  sendMessage(channelId: string, content: string, replyToMessageId?: string): Promise<string>;
  editMessage(channelId: string, platformMessageId: string, content: string): Promise<void>;
}
