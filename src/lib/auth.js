'use strict';

const crypto = require('node:crypto');

const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function sign(payload, secret) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${mac}`;
}

function verify(token, secret) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [body, mac] = token.split('.');
  const expected = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  if (!safeEqual(mac, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
    return payload.exp > Date.now() ? payload : null;
  } catch {
    return null;
  }
}

function issueAdminToken(secret, now = Date.now()) {
  return sign({ role: 'admin', exp: now + SESSION_TTL_MS }, secret);
}

function bearer(req) {
  const h = req.get('authorization') || '';
  return h.startsWith('Bearer ') ? h.slice(7) : '';
}

function requireAdmin(cfg) {
  return (req, res, next) => {
    const payload = verify(bearer(req), cfg.sessionSecret);
    if (!payload || payload.role !== 'admin') return res.status(401).json({ error: 'Sessão expirada. Entre novamente.' });
    return next();
  };
}

function requireKiosk(cfg) {
  return (req, res, next) => {
    if (!safeEqual(bearer(req), cfg.kioskToken)) return res.status(401).json({ error: 'Tablet não autorizado.' });
    return next();
  };
}

/** Limitador simples em memória (suficiente para uma instância). */
function rateLimit({ windowMs, max }) {
  const hits = new Map();
  return (req, res, next) => {
    const now = Date.now();
    const key = req.ip;
    const entry = hits.get(key);
    if (!entry || now - entry.start > windowMs) {
      hits.set(key, { start: now, count: 1 });
      return next();
    }
    entry.count += 1;
    if (entry.count > max) return res.status(429).json({ error: 'Muitas tentativas. Aguarde um pouco.' });
    return next();
  };
}

module.exports = { safeEqual, sign, verify, issueAdminToken, requireAdmin, requireKiosk, rateLimit };
