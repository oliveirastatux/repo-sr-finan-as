'use strict';

const path = require('node:path');
const express = require('express');
const { isValidDescriptor } = require('./domain/faceMatch');
const { AppError } = require('./services');
const auth = require('./lib/auth');
const { extractDealId } = require('./integrations/rdCrm');
const demo = require('./demo');

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_FACE_SAMPLES = 10;

function str(v, max = 200) {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

function brokerInput(body) {
  const name = str(body.name, 120);
  if (!name) throw new AppError('Nome é obrigatório.');
  const email = str(body.email, 200);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new AppError('E-mail inválido.');
  return {
    name,
    email,
    manager_name: str(body.manager_name, 120),
    rd_user_id: str(body.rd_user_id, 100),
    active: body.active === undefined ? true : Boolean(body.active),
  };
}

/** CSV no padrão do Excel brasileiro: separador ";" e BOM UTF-8. */
function toCsv(rows, columns) {
  const esc = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    // Evita injeção de fórmula ao abrir no Excel.
    const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
    return /[";\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  const head = columns.map((c) => esc(c.label)).join(';');
  const body = rows.map((r) => columns.map((c) => esc(r[c.key])).join(';'));
  return `﻿${[head, ...body].join('\r\n')}\r\n`;
}

function createApp({ cfg, repo, services, logger }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Permissions-Policy': 'camera=(self), microphone=(), geolocation=()',
    });
    next();
  });
  app.use(express.json({ limit: '256kb' }));

  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

  // ---------------- páginas e arquivos estáticos ----------------
  const faceApiDir = path.dirname(require.resolve('@vladmandic/face-api/package.json'));
  app.use('/vendor/face-api', express.static(path.join(faceApiDir, 'dist'), { maxAge: '7d' }));
  app.use('/models', express.static(path.join(faceApiDir, 'model'), { maxAge: '30d' }));
  app.use(express.static(path.join(__dirname, '..', 'public'), { extensions: ['html'] }));

  app.get('/healthz', (req, res) => res.json({ ok: true }));

  // ---------------- tablet (quiosque) ----------------
  const kiosk = express.Router();
  kiosk.use(auth.requireKiosk(cfg));
  kiosk.get('/status', (req, res) => {
    const st = services.status();
    res.json({
      timezone: st.schedule.timezone,
      demo: st.demo,
      localTime: st.localTime,
      localDate: st.localDate,
      open: st.open,
      active: st.active,
      next: st.next,
    });
  });
  kiosk.post(
    '/checkin',
    auth.rateLimit({ windowMs: 60_000, max: 60 }),
    (req, res) => {
      const { descriptor, liveness } = req.body || {};
      if (!isValidDescriptor(descriptor)) throw new AppError('Leitura facial inválida.');
      if (liveness !== true) throw new AppError('Prova de vida não concluída. Pisque olhando para a câmera.');
      const r = services.faceCheckin(descriptor);
      res.json({
        name: r.broker.name,
        shift: r.shift,
        time: r.checkin.local_time,
        alreadyCheckedIn: r.alreadyCheckedIn,
      });
    },
  );
  app.use('/api/kiosk', kiosk);

  // ---------------- webhook do RD CRM ----------------
  app.post(
    '/api/webhooks/rd/:secret',
    wrap(async (req, res) => {
      if (!auth.safeEqual(req.params.secret, cfg.webhookSecret)) return res.status(404).end();
      const dealId = extractDealId(req.body);
      if (!dealId) {
        logger.warn('webhook.no_deal_id', { keys: Object.keys(req.body || {}) });
        return res.status(202).json({ ignored: true });
      }
      const r = await services.assignLead(dealId);
      return res.json({ status: r.lead.status, duplicate: r.duplicate });
    }),
  );

  // ---------------- painel do gestor ----------------
  app.post('/api/admin/login', auth.rateLimit({ windowMs: 15 * 60_000, max: 10 }), (req, res) => {
    if (!auth.safeEqual(str(req.body?.password, 200), cfg.adminPassword)) {
      logger.warn('admin.login_failed', { ip: req.ip });
      throw new AppError('Senha incorreta.', 401, 'unauthorized');
    }
    res.json({ token: auth.issueAdminToken(cfg.sessionSecret) });
  });

  const admin = express.Router();
  admin.use(auth.requireAdmin(cfg));

  admin.get('/overview', (req, res) => {
    const st = services.status();
    const shifts = st.schedule.shifts.map((sh) => ({
      ...sh,
      roster: repo.shiftRoster(st.localDate, sh.id),
    }));
    const eligible = services.eligibleNow();
    res.json({
      ...st,
      shifts,
      eligibleShift: eligible.shift,
      eligibleIds: eligible.brokers.map((b) => b.broker_id),
      leads: repo.recentLeads(30),
      leadsToday: repo.countLeads(st.localDate),
      rdDryRun: cfg.rd.dryRun,
    });
  });

  admin.get('/brokers', (req, res) => res.json(repo.listBrokers()));
  admin.post('/brokers', (req, res) => {
    const b = repo.createBroker(brokerInput(req.body || {}));
    repo.audit('admin', 'broker.create', { id: b.id });
    res.status(201).json(b);
  });
  admin.put('/brokers/:id', (req, res) => {
    const id = Number(req.params.id);
    if (!repo.getBroker(id)) throw new AppError('Corretor não encontrado.', 404);
    const b = repo.updateBroker(id, brokerInput(req.body || {}));
    repo.audit('admin', 'broker.update', { id });
    res.json(b);
  });

  admin.post('/brokers/:id/face', (req, res) => {
    const id = Number(req.params.id);
    if (!repo.getBroker(id)) throw new AppError('Corretor não encontrado.', 404);
    const { descriptors, consent } = req.body || {};
    if (consent !== true) throw new AppError('É necessário o consentimento do corretor (LGPD).');
    if (!Array.isArray(descriptors) || descriptors.length < 1 || descriptors.length > MAX_FACE_SAMPLES) {
      throw new AppError(`Envie de 1 a ${MAX_FACE_SAMPLES} amostras do rosto.`);
    }
    if (!descriptors.every(isValidDescriptor)) throw new AppError('Amostra facial inválida.');
    const b = repo.setFace(id, descriptors, new Date().toISOString());
    repo.audit('admin', 'broker.face_enrolled', { id, samples: descriptors.length });
    res.json(b);
  });
  admin.delete('/brokers/:id/face', (req, res) => {
    const id = Number(req.params.id);
    if (!repo.getBroker(id)) throw new AppError('Corretor não encontrado.', 404);
    const b = repo.clearFace(id);
    repo.audit('admin', 'broker.face_deleted', { id });
    res.json(b);
  });

  admin.post('/checkins/manual', (req, res) => {
    const note = str(req.body?.note, 300);
    if (!note) throw new AppError('Informe o motivo do check-in manual.');
    const r = services.registerCheckin({
      brokerId: Number(req.body?.brokerId),
      method: 'manual',
      note,
      allowLate: true,
    });
    repo.audit('admin', 'checkin.manual', { brokerId: r.broker.id, shift: r.shift.id, note });
    res.json(r);
  });
  admin.delete('/checkins/:id', (req, res) => {
    const id = Number(req.params.id);
    if (!repo.deleteCheckin(id)) throw new AppError('Check-in não encontrado.', 404);
    repo.audit('admin', 'checkin.delete', { id });
    res.json({ ok: true });
  });

  admin.get('/schedule', (req, res) => res.json(repo.getSchedule()));
  admin.put('/schedule', (req, res) => {
    const s = repo.saveSchedule(req.body);
    repo.audit('admin', 'schedule.update', s);
    res.json(s);
  });

  admin.get('/report', (req, res) => {
    const today = services.status().localDate;
    const from = DATE.test(req.query.from) ? req.query.from : today;
    const to = DATE.test(req.query.to) ? req.query.to : today;
    if (from > to) throw new AppError('Data inicial maior que a final.');
    const rows = repo.checkinReport(from, to);
    if (req.query.format === 'csv') {
      const csv = toCsv(rows, [
        { key: 'local_date', label: 'Data' },
        { key: 'shift_id', label: 'Turno' },
        { key: 'local_time', label: 'Horário' },
        { key: 'name', label: 'Corretor' },
        { key: 'manager_name', label: 'Gerente' },
        { key: 'method', label: 'Método' },
        { key: 'leads', label: 'Leads recebidos' },
        { key: 'note', label: 'Observação' },
      ]);
      res.set('Content-Type', 'text/csv; charset=utf-8');
      res.set('Content-Disposition', `attachment; filename="plantao_${from}_a_${to}.csv"`);
      return res.send(csv);
    }
    return res.json({ from, to, rows });
  });

  admin.post(
    '/leads/simulate',
    wrap(async (req, res) => {
      const r = await services.assignLead(`SIMULADO-${Date.now()}`);
      res.json(r);
    }),
  );

  // ---------------- demonstração ----------------
  const onlyDemo = (req, res, next) => {
    if (!cfg.demoMode) throw new AppError('Disponível apenas com DEMO_MODE=true.', 403, 'forbidden');
    next();
  };
  admin.post('/demo/seed', onlyDemo, (req, res) => {
    const st = services.status();
    const r = demo.seedDemo(repo, { now: new Date(st.now), currentShift: st.active });
    repo.audit('admin', 'demo.seed', r);
    res.json(r);
  });
  admin.post('/demo/clear', (req, res) => {
    const removed = demo.clearDemo(repo);
    repo.audit('admin', 'demo.clear', { removed });
    res.json({ removed });
  });

  app.use('/api/admin', admin);

  app.use('/api', (req, res) => res.status(404).json({ error: 'Rota não encontrada.' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'JSON inválido.' });
    const status = err.status || 500;
    if (status >= 500) logger.error('http.error', { path: req.path, error: err.message, stack: err.stack });
    return res.status(status).json({ error: status >= 500 ? 'Erro interno. Tente novamente.' : err.message, code: err.code });
  });

  return app;
}

module.exports = { createApp, toCsv };
