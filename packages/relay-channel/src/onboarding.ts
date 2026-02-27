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
import crypto from "node:crypto";

const channel = "relay" as const;

function generateAuthToken(): string {
  const bytes = crypto.randomBytes(24);
  return `crly_${bytes.toString("base64url")}`;
}

function setRelayAccountConfig(
  cfg: OpenClawConfig,
  accountId: string,
  defaultPatch: Record<string, unknown>,
  accountPatch: Record<string, unknown> = defaultPatch,
): OpenClawConfig {
  if (accountId === DEFAULT_ACCOUNT_ID) {
    return {
      ...cfg,
      channels: {
        ...cfg.channels,
        relay: {
          ...cfg.channels?.relay,
          enabled: true,
          ...defaultPatch,
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
            ...accountPatch,
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

function getExistingToken(cfg: OpenClawConfig, accountId: string): string | undefined {
  const relay = (cfg.channels as any)?.relay;
  if (accountId === DEFAULT_ACCOUNT_ID) {
    return relay?.authToken;
  }
  return relay?.accounts?.[accountId]?.authToken;
}

export const relayOnboardingAdapter: ChannelOnboardingAdapter = {
  channel,

  getStatus: async ({ cfg }) => {
    const ids = listRelayAccountIds(cfg);
    const relay = (cfg.channels as any)?.relay;

    // Check default account (top-level authToken) or any named account
    let configured = Boolean(relay?.authToken);
    if (!configured) {
      for (const id of ids) {
        if (relay?.accounts?.[id]?.authToken) {
          configured = true;
          break;
        }
      }
    }

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
        "lightweight always-on relay service. This wizard configures",
        "the channel plugin side (auth token).",
        "",
        "The relay service connects to the OpenClaw gateway via WS",
        "and calls the relay.inbound method. No separate port needed.",
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

    let next = cfg;

    // --- Auth Token (optional per-account verification token) ---
    const existingToken = getExistingToken(next, accountId);
    let authToken: string;

    if (existingToken) {
      const keepToken = await prompter.confirm({
        message: `Auth token already set (${existingToken.slice(0, 12)}...). Keep it?`,
        initialValue: true,
      });
      if (keepToken) {
        authToken = existingToken;
      } else {
        authToken = await promptAuthToken(prompter);
      }
    } else {
      authToken = await promptAuthToken(prompter);
    }

    // --- Write config ---
    next = setRelayAccountConfig(next, accountId, {
      authToken,
    });

    await prompter.note(
      `Relay channel configured (token: ${authToken.slice(0, 12)}...). Select Finished below, then deploy the relay service.`,
      "Relay",
    );

    return { cfg: next, accountId };
  },
};

async function promptAuthToken(prompter: WizardPrompter): Promise<string> {
  const generated = generateAuthToken();
  const useGenerated = await prompter.confirm({
    message: `Use auto-generated token? (${generated})`,
    initialValue: true,
  });

  if (useGenerated) {
    return generated;
  }

  const custom = await prompter.text({
    message: "Enter your auth token",
    validate: (value) =>
      String(value ?? "").trim().length >= 8
        ? undefined
        : "Token must be at least 8 characters",
  });
  return String(custom).trim();
}
