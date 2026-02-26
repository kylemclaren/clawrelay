// Relay Protocol Types (shared with relay-channel plugin)

// Inbound message from relay -> plugin
export interface RelayInboundMessage {
  messageId: string;
  platform: string;
  channelId: string;
  guildId?: string;
  senderId: string;
  senderName: string;
  content: string;
  chatType: 'group' | 'direct';
  groupName?: string;
  callbackUrl: string;
  timestamp: number;
}

// Outbound response from plugin -> relay
export interface RelayOutboundMessage {
  messageId: string;
  content: string;
  replyToMessageId?: string;
}

// Internal queue entry
export interface QueueEntry {
  message: RelayInboundMessage;
  discordChannelId: string;
  discordMessageId: string;
  enqueuedAt: number;
}
