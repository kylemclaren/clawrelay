// @openclaw/relay-channel - Channel Relay Plugin
//
// Receives forwarded messages from an always-on relay service and processes
// them through the standard OpenClaw channel pipeline.

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { createRelayChannel } from './channel.js';
import { setRelayRuntime } from './runtime.js';

const plugin = {
  id: 'relay-channel',
  name: '@openclaw/relay-channel',
  description: 'Channel relay plugin — receives messages from an always-on relay proxy',
  configSchema: emptyPluginConfigSchema(),

  register(api: OpenClawPluginApi) {
    const logger = api.logger;

    logger.info('[relay-channel] Registering relay channel plugin');

    // Store runtime for use across modules
    setRelayRuntime(api.runtime);

    // Create and register the channel
    const channel = createRelayChannel(api);
    api.registerChannel({ plugin: channel });

    logger.info('[relay-channel] Relay channel plugin registered');
  },
};

export default plugin;
