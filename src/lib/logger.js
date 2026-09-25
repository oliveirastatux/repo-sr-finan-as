'use strict';

/** Logger JSON em uma linha — fácil de filtrar em qualquer serviço de logs. */
function createLogger({ silent = false } = {}) {
  const write = (level, msg, meta) => {
    if (silent) return;
    const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...meta });
    (level === 'error' ? process.stderr : process.stdout).write(`${line}\n`);
  };
  return {
    info: (msg, meta) => write('info', msg, meta),
    warn: (msg, meta) => write('warn', msg, meta),
    error: (msg, meta) => write('error', msg, meta),
  };
}

module.exports = { createLogger };
