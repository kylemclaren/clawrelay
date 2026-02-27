// Relay Channel Protocol Types

export interface RelayAccount {
  accountId: string;
  authToken: string;
  enabled?: boolean;
}

// Inbound message from relay service -> plugin
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
  timestamp: number;
}

// Outbound response from plugin -> relay service
export interface RelayOutboundMessage {
  messageId: string;
  content: string;
  replyToMessageId?: string;
}
