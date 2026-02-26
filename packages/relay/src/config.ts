// Relay Config - Types and loader

import { readFileSync } from 'node:fs';

export interface RelayConfig {
  discord: {
    token: string;
    allowedGuilds?: string[];
    allowedChannels?: string[];
  };
  sandbox: {
    pluginUrl: string;
    healthPath: string;
    wsPath: string;
    authToken: string;
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

  const config: RelayConfig = {
    discord: {
      token: process.env.DISCORD_TOKEN ?? fileConfig.discord?.token ?? '',
      allowedGuilds: fileConfig.discord?.allowedGuilds,
      allowedChannels: fileConfig.discord?.allowedChannels,
    },
    sandbox: {
      pluginUrl: process.env.SANDBOX_PLUGIN_URL ?? fileConfig.sandbox?.pluginUrl ?? 'http://localhost:7600',
      healthPath: process.env.SANDBOX_HEALTH_PATH ?? fileConfig.sandbox?.healthPath ?? '/relay/health',
      wsPath: process.env.SANDBOX_WS_PATH ?? fileConfig.sandbox?.wsPath ?? '/relay/ws',
      authToken: process.env.SANDBOX_AUTH_TOKEN ?? fileConfig.sandbox?.authToken ?? '',
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
  if (!config.discord.token) {
    throw new Error('Discord token is required (DISCORD_TOKEN env or discord.token in config)');
  }
  if (!config.sandbox.authToken) {
    throw new Error('Sandbox auth token is required (SANDBOX_AUTH_TOKEN env or sandbox.authToken in config)');
  }

  return config;
}
