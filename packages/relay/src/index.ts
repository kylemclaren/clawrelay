// Relay Service - Entry point

import { loadConfig } from './config.js';
import { Relay } from './relay.js';

const logger = {
  info: (...args: any[]) => console.log(new Date().toISOString(), '[INFO]', ...args),
  warn: (...args: any[]) => console.warn(new Date().toISOString(), '[WARN]', ...args),
  error: (...args: any[]) => console.error(new Date().toISOString(), '[ERROR]', ...args),
  debug: (...args: any[]) => {
    if (process.env.DEBUG) console.log(new Date().toISOString(), '[DEBUG]', ...args);
  },
};

async function main() {
  logger.info('[relay] Loading config...');
  const config = loadConfig();

  const relay = new Relay(config, logger);

  // Graceful shutdown
  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.info(`[relay] Received ${signal}, shutting down...`);
    await relay.stop();
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  await relay.start();
}

main().catch((err) => {
  logger.error(`[relay] Fatal error: ${err}`);
  process.exit(1);
});
