import type {
  ChannelOnboardingAdapter,
  OpenClawConfig,
  WizardPrompter,
} from "openclaw/plugin-sdk";
import {
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId,
  promptAccountId,
} from "openclaw/plugin-sdk";
import { execSync } from "node:child_process";
import path from "node:path";

const channel = "relay" as const;

const SPRITE_ENV_BIN = "/.sprite/bin/sprite-env";
const DEFAULT_GATEWAY_PORT = 18789;
const GATEWAY_SERVICE_NAME = "openclaw-gateway";

function isOnSprite(): boolean {
  try {
    execSync(`test -x ${SPRITE_ENV_BIN}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function getExistingGatewayService(): Record<string, unknown> | undefined {
  try {
    const out = execSync(`${SPRITE_ENV_BIN} services list`, {
      encoding: "utf-8",
      timeout: 5000,
    }).trim();
    const services: Record<string, unknown>[] = JSON.parse(out);
    return services.find(
      (s) => (s as any).name === GATEWAY_SERVICE_NAME,
    );
  } catch {
    return undefined;
  }
}

function findOpenclawBinary(): string | undefined {
  const binDir = path.dirname(process.execPath);
  const candidate = path.join(binDir, "openclaw");
  try {
    execSync(`test -x "${candidate}"`, { stdio: "ignore" });
    return candidate;
  } catch {
    return undefined;
  }
}

async function ensureSpriteGatewayService(
  cfg: OpenClawConfig,
  prompter: WizardPrompter,
): Promise<void> {
  if (!isOnSprite()) return;

  const existing = getExistingGatewayService();
  if (existing) {
    await prompter.note(
      `Sprite gateway service already exists (${GATEWAY_SERVICE_NAME}).`,
      "Sprite",
    );
    return;
  }

  const openclawBin = findOpenclawBinary();
  if (!openclawBin) {
    await prompter.note(
      "Could not locate the openclaw binary to create the gateway service. You may need to create it manually:\n" +
        `  sprite-env services create ${GATEWAY_SERVICE_NAME} --cmd openclaw --args "gateway,--port,${DEFAULT_GATEWAY_PORT}" --http-port ${DEFAULT_GATEWAY_PORT}`,
      "Sprite",
    );
    return;
  }

  const gwCfg = (cfg as any).gateway;
  const port = gwCfg?.port ?? DEFAULT_GATEWAY_PORT;

  const shouldCreate = await prompter.confirm({
    message: `Create sprite gateway service (${GATEWAY_SERVICE_NAME} on port ${port})?`,
    initialValue: true,
  });

  if (!shouldCreate) return;

  try {
    execSync(
      `${SPRITE_ENV_BIN} services create ${GATEWAY_SERVICE_NAME} --cmd "${openclawBin}" --args "gateway,--port,${port}" --http-port ${port}`,
      { encoding: "utf-8", timeout: 10000 },
    );
    await prompter.note(
      `Gateway service created: ${GATEWAY_SERVICE_NAME} → ${openclawBin} gateway --port ${port}`,
      "Sprite",
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await prompter.note(
      `Failed to create gateway service: ${msg}\n\nYou can create it manually:\n` +
        `  sprite-env services create ${GATEWAY_SERVICE_NAME} --cmd "${openclawBin}" --args "gateway,--port,${port}" --http-port ${port}`,
      "Sprite",
    );
  }
}

function setRelayAccountConfig(
  cfg: OpenClawConfig,
  accountId: string,
): OpenClawConfig {
  if (accountId === DEFAULT_ACCOUNT_ID) {
    return {
      ...cfg,
      channels: {
        ...cfg.channels,
        relay: {
          ...cfg.channels?.relay,
          enabled: true,
        },
      },
    } as OpenClawConfig;
  }
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      relay: {
        ...cfg.channels?.relay,
        enabled: true,
        accounts: {
          ...cfg.channels?.relay?.accounts,
          [accountId]: {
            ...cfg.channels?.relay?.accounts?.[accountId],
            enabled: cfg.channels?.relay?.accounts?.[accountId]?.enabled ?? true,
          },
        },
      },
    },
  } as OpenClawConfig;
}

function listRelayAccountIds(cfg: OpenClawConfig): string[] {
  return Object.keys((cfg.channels as any)?.relay?.accounts ?? {});
}

function resolveDefaultRelayAccountId(cfg: OpenClawConfig): string {
  const ids = listRelayAccountIds(cfg);
  if (ids.includes(DEFAULT_ACCOUNT_ID)) return DEFAULT_ACCOUNT_ID;
  return ids[0] ?? DEFAULT_ACCOUNT_ID;
}

export const relayOnboardingAdapter: ChannelOnboardingAdapter = {
  channel,

  getStatus: async ({ cfg }) => {
    const relay = (cfg.channels as any)?.relay;
    const configured = relay?.enabled === true;

    return {
      channel,
      configured,
      statusLines: [
        `Channel Relay: ${configured ? "configured" : "needs setup"}`,
      ],
      selectionHint: configured
        ? "configured"
        : "proxy for Discord/Telegram",
      quickstartScore: configured ? 1 : 20,
    };
  },

  configure: async ({
    cfg,
    prompter,
    accountOverrides,
    shouldPromptAccountIds,
  }) => {
    await prompter.note(
      [
        "ClawRelay bridges Discord/Telegram to OpenClaw via a",
        "lightweight always-on relay service. This wizard enables",
        "the channel plugin and configures the gateway service.",
        "",
        "The relay service connects to the OpenClaw gateway via WS",
        "and authenticates using the gateway auth token.",
        "",
        "You'll deploy the relay service separately afterwards.",
      ].join("\n"),
      "Channel Relay Setup",
    );

    // --- Account ID ---
    const relayOverride = (accountOverrides as any).relay?.trim();
    const defaultAccountId = resolveDefaultRelayAccountId(cfg);
    let accountId = relayOverride
      ? normalizeAccountId(relayOverride)
      : defaultAccountId;

    if (shouldPromptAccountIds && !relayOverride) {
      accountId = await promptAccountId({
        cfg,
        prompter,
        label: "Channel Relay",
        currentId: accountId,
        listAccountIds: listRelayAccountIds,
        defaultAccountId,
      });
    }

    // --- Write config ---
    const next = setRelayAccountConfig(cfg, accountId);

    // --- Sprite gateway service ---
    await ensureSpriteGatewayService(next, prompter);

    await prompter.note(
      "Relay channel enabled. Select Finished below, then deploy the relay service.",
      "Relay",
    );

    return { cfg: next, accountId };
  },
};
