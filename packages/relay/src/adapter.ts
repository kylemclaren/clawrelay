// Channel Adapter - Platform-agnostic interface for messaging platforms

import type { RelayInboundMessage } from './types.js';

export type OnInboundMessage = (message: RelayInboundMessage) => void;

export interface ChannelAdapter {
  readonly platform: string;
  login(): Promise<void>;
  destroy(): Promise<void>;
  sendTyping(channelId: string): Promise<void>;
  sendMessage(channelId: string, content: string, replyToMessageId?: string): Promise<void>;
}
