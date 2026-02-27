// Relay Config - Types and loader

import { readFileSync } from 'node:fs';

export interface RelayConfig {
  discord?: {
    token: string;
    allowedGuilds?: string[];
    allowedChannels?: string[];
  };
  telegram?: {
    botToken: string;
    allowedChats?: string[];
  };
  gateway: {
    url: string;
    authToken: string;
    healthPath: string;
    spriteToken?: string;
  };
  wake: {
    enabled: boolean;
    url?: string;
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    timeoutMs?: number;
    pollIntervalMs?: number;
  };
  healthServer: {
    port: number;
  };
}

const DEFAULTS: Partial<RelayConfig> = {
  wake: {
    enabled: false,
    method: 'POST',
    timeoutMs: 120_000,
    pollIntervalMs: 3_000,
  },
};

export function loadConfig(configPath?: string): RelayConfig {
  const path = configPath ?? process.env.RELAY_CONFIG ?? 'relay.config.json';

  let fileConfig: any = {};
  try {
    const raw = readFileSync(path, 'utf-8');
    fileConfig = JSON.parse(raw);
  } catch (err) {
    // Config file is optional if all env vars are set
    if (configPath) {
      throw new Error(`Failed to read config file ${path}: ${err}`);
    }
  }

  // Build discord config if token is available
  const discordToken = process.env.DISCORD_TOKEN ?? fileConfig.discord?.token;
  const discord = discordToken
    ? {
        token: discordToken,
        allowedGuilds: fileConfig.discord?.allowedGuilds as string[] | undefined,
        allowedChannels: fileConfig.discord?.allowedChannels as string[] | undefined,
      }
    : undefined;

  // Build telegram config if token is available
  const telegramToken = process.env.TELEGRAM_BOT_TOKEN ?? fileConfig.telegram?.botToken;
  const telegram = telegramToken
    ? {
        botToken: telegramToken,
        allowedChats: fileConfig.telegram?.allowedChats as string[] | undefined,
      }
    : undefined;

  const config: RelayConfig = {
    discord,
    telegram,
    gateway: {
      url: process.env.GATEWAY_URL ?? fileConfig.gateway?.url ?? 'http://localhost:18789',
      authToken: process.env.GATEWAY_AUTH_TOKEN ?? fileConfig.gateway?.authToken ?? '',
      healthPath: process.env.GATEWAY_HEALTH_PATH ?? fileConfig.gateway?.healthPath ?? '/relay/health',
      spriteToken: process.env.SPRITE_TOKEN ?? fileConfig.gateway?.spriteToken,
    },
    wake: {
      enabled: process.env.WAKE_ENABLED !== undefined
        ? process.env.WAKE_ENABLED === 'true'
        : fileConfig.wake?.enabled ?? DEFAULTS.wake!.enabled,
      url: process.env.WAKE_URL ?? fileConfig.wake?.url,
      method: fileConfig.wake?.method ?? DEFAULTS.wake!.method,
      headers: fileConfig.wake?.headers,
      body: fileConfig.wake?.body,
      timeoutMs: fileConfig.wake?.timeoutMs ?? DEFAULTS.wake!.timeoutMs,
      pollIntervalMs: fileConfig.wake?.pollIntervalMs ?? DEFAULTS.wake!.pollIntervalMs,
    },
    healthServer: {
      port: Number(process.env.HEALTH_PORT ?? fileConfig.healthServer?.port ?? 8080),
    },
  };

  // Validate required fields
  if (!config.discord && !config.telegram) {
    throw new Error('At least one channel must be configured (DISCORD_TOKEN or TELEGRAM_BOT_TOKEN)');
  }
  if (!config.gateway.authToken) {
    throw new Error('Gateway auth token is required (GATEWAY_AUTH_TOKEN env or gateway.authToken in config)');
  }

  return config;
}
