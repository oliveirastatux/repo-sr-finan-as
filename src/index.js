'use strict';

const { loadConfig } = require('./config');
const { openDb } = require('./db');
const { createLogger } = require('./lib/logger');
const { createRdClient } = require('./integrations/rdCrm');
const { createServices } = require('./services');
const { createApp } = require('./app');

function main() {
  const logger = createLogger();
  let cfg;
  try {
    cfg = loadConfig();
  } catch (e) {
    logger.error('config.invalid', { error: e.message });
    process.exit(1);
  }

  const repo = openDb(cfg.dbPath);
  const rd = createRdClient(cfg.rd, { logger });
  const services = createServices({ repo, rd, cfg, logger });
  const app = createApp({ cfg, repo, services, logger });

  const server = app.listen(cfg.port, () => {
    logger.info('server.started', { port: cfg.port, rdDryRun: cfg.rd.dryRun });
  });

  const shutdown = (signal) => {
    logger.info('server.stopping', { signal });
    server.close(() => {
      repo.close();
      process.exit(0);
    });
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main();
