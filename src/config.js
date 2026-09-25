'use strict';

const path = require('node:path');

function bool(v, def) {
  if (v === undefined || v === '') return def;
  return ['1', 'true', 'yes', 'sim'].includes(String(v).toLowerCase());
}

function num(v, def) {
  const n = Number(v);
  return v === undefined || v === '' || Number.isNaN(n) ? def : n;
}

function loadConfig(env = process.env) {
  const cfg = {
    port: num(env.PORT, 3000),
    dbPath: env.DB_PATH || path.join(process.cwd(), 'data', 'plantao.db'),
    adminPassword: env.ADMIN_PASSWORD || '',
    sessionSecret: env.SESSION_SECRET || '',
    kioskToken: env.KIOSK_TOKEN || '',
    webhookSecret: env.RD_WEBHOOK_SECRET || '',
    demoMode: bool(env.DEMO_MODE, false),
    face: {
      threshold: num(env.FACE_MATCH_THRESHOLD, 0.5),
      margin: num(env.FACE_MATCH_MARGIN, 0.05),
    },
    rd: {
      apiBase: env.RD_API_BASE || 'https://api.rd.services/crm/v2',
      accessToken: env.RD_ACCESS_TOKEN || '',
      dryRun: bool(env.RD_DRY_RUN, true),
      fallbackOwnerId: env.RD_FALLBACK_OWNER_ID || '',
    },
  };

  // Demonstração nunca altera nada no RD.
  if (cfg.demoMode) cfg.rd.dryRun = true;

  const missing = [];
  if (!cfg.adminPassword) missing.push('ADMIN_PASSWORD');
  if (!cfg.sessionSecret || cfg.sessionSecret.length < 32) missing.push('SESSION_SECRET (mín. 32 caracteres)');
  if (!cfg.kioskToken || cfg.kioskToken.length < 16) missing.push('KIOSK_TOKEN (mín. 16 caracteres)');
  if (!cfg.webhookSecret || cfg.webhookSecret.length < 16) missing.push('RD_WEBHOOK_SECRET (mín. 16 caracteres)');
  if (!cfg.rd.dryRun && !cfg.rd.accessToken) missing.push('RD_ACCESS_TOKEN (obrigatório com RD_DRY_RUN=false)');
  if (missing.length) {
    throw new Error(`Configuração ausente/inválida: ${missing.join(', ')}. Veja .env.example.`);
  }
  return cfg;
}

module.exports = { loadConfig };
