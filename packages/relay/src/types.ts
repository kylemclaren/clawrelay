// Relay Protocol Types

// Inbound message from relay -> plugin (sent as params.message in relay.inbound)
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

// Outbound response from plugin -> relay (returned in gateway response payload)
export interface RelayOutboundMessage {
  messageId: string;
  content: string;
  replyToMessageId?: string;
}

// --- Gateway protocol frame types ---

export interface GatewayReqFrame {
  type: 'req';
  id: string;
  method: string;
  params?: unknown;
}

export interface GatewayResFrame {
  type: 'res';
  id: string;
  ok: boolean;
  payload?: unknown;
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export interface GatewayEventFrame {
  type: 'event';
  event: string;
  payload?: unknown;
  seq?: number;
}

export type GatewayFrame = GatewayReqFrame | GatewayResFrame | GatewayEventFrame;

// Internal queue entry
export interface QueueEntry {
  message: RelayInboundMessage;
  discordChannelId: string;
  discordMessageId: string;
  enqueuedAt: number;
}
