// Relay Outbound - POST response back to relay callback URL

import type { RelayOutboundMessage } from './types.js';

export interface SendResult {
  ok: boolean;
  error?: string;
}

export async function sendToRelay(
  callbackUrl: string,
  message: RelayOutboundMessage,
  logger?: any,
): Promise<SendResult> {
  try {
    const response = await fetch(callbackUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(message),
    });

    if (!response.ok) {
      const errorText = await response.text();
      logger?.error(`[relay-channel] Callback failed: ${response.status} ${errorText}`);
      return { ok: false, error: `HTTP ${response.status}: ${errorText}` };
    }

    logger?.debug(`[relay-channel] Callback sent for message ${message.messageId}`);
    return { ok: true };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logger?.error(`[relay-channel] Callback failed: ${error}`);
    return { ok: false, error };
  }
}
