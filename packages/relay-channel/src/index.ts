// clawrelay - Channel Relay Plugin
//
// Receives forwarded messages from an always-on relay service and processes
// them through the standard OpenClaw channel pipeline.
//
// Instead of running a standalone HTTP+WS server, this plugin registers a
// gateway method (`relay.inbound`) and an HTTP health route (`/relay/health`)
// on the gateway's existing server.

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { createRelayChannel } from './channel.js';
import { setRelayRuntime } from './runtime.js';
import { createRelayInboundHandler } from './gateway-handler.js';
import { relayHealthHandler } from './health-handler.js';

const plugin = {
  id: 'clawrelay',
  name: 'clawrelay',
  description: 'Channel relay plugin — receives messages from an always-on relay proxy',
  configSchema: emptyPluginConfigSchema(),

  register(api: OpenClawPluginApi) {
    const logger = api.logger;

    logger.info('[clawrelay] Registering relay channel plugin');

    // Store runtime for use across modules
    setRelayRuntime(api.runtime);

    // Create and register the channel
    const channel = createRelayChannel(api);
    api.registerChannel({ plugin: channel });

    // Register gateway method for relay.inbound calls
    const relayInboundHandler = createRelayInboundHandler(api);
    api.registerGatewayMethod('relay.inbound', relayInboundHandler);

    // Register HTTP health route on the gateway's HTTP server
    api.registerHttpRoute({ path: '/relay/health', handler: relayHealthHandler });

    logger.info('[clawrelay] Relay channel plugin registered (gateway method + HTTP health)');
  },
};

export default plugin;
