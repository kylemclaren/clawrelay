// Relay Channel Plugin Definition
//
// The relay channel no longer runs its own server. Inbound messages arrive via
// the `relay.inbound` gateway method registered in index.ts. This file defines
// the channel metadata, config resolution, and onboarding adapter.

import type { RelayAccount } from './types.js';
import { relayOnboardingAdapter } from './onboarding.js';

const CHANNEL_ID = 'relay' as const;

export function createRelayChannel(api: any) {
  const logger = api.logger;

  const channel = {
    id: CHANNEL_ID,

    meta: {
      id: CHANNEL_ID,
      label: 'Channel Relay',
      selectionLabel: 'Relay (Discord/Telegram via proxy)',
      docsPath: '/channels/relay',
      blurb: 'Wake-on-message proxy for Discord/Telegram via always-on relay',
      aliases: ['relay'],
    },

    onboarding: relayOnboardingAdapter,

    capabilities: {
      chatTypes: ['direct', 'group'],
      media: {
        images: false,
        audio: false,
        video: false,
        documents: false,
      },
      reactions: false,
      threads: false,
      mentions: false,
    },

    config: {
      listAccountIds: (cfg: any) => {
        return Object.keys(cfg.channels?.relay?.accounts ?? {});
      },

      resolveAccount: (cfg: any, accountId?: string): RelayAccount | undefined => {
        const accounts = cfg.channels?.relay?.accounts ?? {};
        const id = accountId ?? 'default';
        const account = accounts[id];
        if (!account) return undefined;

        return {
          accountId: id,
          authToken: account.authToken,
          enabled: account.enabled !== false,
        };
      },
    },

    gateway: {
      startAccount: async (ctx: any) => {
        const account = ctx.account as RelayAccount;
        const accountId = account.accountId ?? 'default';
        logger.info(`[clawrelay] Account ${accountId} started (relay.inbound via gateway)`);
      },

      stopAccount: async (ctx: any) => {
        const accountId = ctx.account?.accountId ?? 'default';
        logger.info(`[clawrelay] Account ${accountId} stopped`);
      },
    },

    outbound: {
      deliveryMode: 'direct' as const,

      sendText: async ({
        text,
        chatId,
        accountId,
        cfg,
      }: {
        text: string;
        chatId: string;
        accountId?: string;
        cfg: any;
      }) => {
        logger.warn(`[clawrelay] sendText called for chatId=${chatId} — relay-channel uses gateway method for responses`);
        return { ok: false, error: 'Relay channel uses gateway method for responses, not sendText' };
      },
    },

    status: {
      getHealth: (accountId: string) => {
        return { status: 'connected', message: 'Listening via gateway method (relay.inbound)' };
      },
    },
  };

  return channel;
}
