import { loadConfig } from './config';
import { createRuntime } from './runtime';
import { AbortedError } from './util';

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    process.exit(78); // EX_CONFIG: a supervisor should not hot-loop on bad config
  }

  const runtime = createRuntime(config);
  const { logger } = runtime;
  let shuttingDown = false;

  const shutdown = async (signal: string, code = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`Received ${signal}; shutting down`, { component: 'process' });
    const force = setTimeout(() => {
      logger.error('Graceful shutdown timed out; forcing exit', { component: 'process' });
      process.exit(1);
    }, config.SHUTDOWN_TIMEOUT_MS);
    force.unref();
    try {
      await runtime.stop();
      logger.info('Shutdown complete', { component: 'process' });
    } catch (err) {
      logger.error('Error during shutdown', { component: 'process', err });
      code = 1;
    }
    process.exit(code);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  // PM2 graceful reload sends a 'shutdown' message on Windows and when shutdown_with_message is set.
  process.on('message', (msg) => {
    if (msg === 'shutdown') void shutdown('pm2 shutdown');
  });
  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled promise rejection', { component: 'process', reason: reason instanceof Error ? reason.stack : String(reason) });
  });
  process.on('uncaughtException', (err) => {
    // State may be corrupt: crash and let the supervisor restart from persisted state.
    logger.error('Uncaught exception; exiting', { component: 'process', err });
    void shutdown('uncaughtException', 1);
  });

  try {
    await runtime.start();
    // Tell PM2 (wait_ready: true) that this instance is accepting traffic.
    process.send?.('ready');
  } catch (err) {
    if (err instanceof AbortedError) return; // shutdown requested while waiting for the lease
    logger.error('Startup failed', { component: 'process', err });
    await shutdown('startup failure', 1);
  }
}

void main();
