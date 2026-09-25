'use strict';

const schedule = require('./domain/schedule');
const { findBestMatch } = require('./domain/faceMatch');
const { pickNextBroker } = require('./domain/distribution');

class AppError extends Error {
  constructor(message, status = 400, code = 'bad_request') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/**
 * Regras de negócio da aplicação. Recebe dependências por parâmetro
 * (repositório, cliente RD, relógio) para facilitar os testes.
 */
function createServices({ repo, rd, cfg, logger, clock = () => new Date() }) {
  function now() {
    return clock();
  }

  /** Estado atual para o tablet e o painel. */
  function status() {
    const sched = repo.getSchedule();
    const t = now();
    const lp = schedule.localParts(t, sched.timezone);
    const open = schedule.openCheckinShift(sched, t);
    const active = schedule.activeShift(sched, t);
    const next = schedule.nextCheckinShift(sched, t);
    return { now: t.toISOString(), localDate: lp.date, localTime: lp.time, schedule: sched, open, active, next };
  }

  /** Corretores aptos a receber lead neste momento. */
  function eligibleNow() {
    const st = status();
    if (!st.active) return { shift: null, brokers: [] };
    const roster = repo.shiftRoster(st.localDate, st.active.id).filter((r) => r.active);
    return { shift: st.active, brokers: roster };
  }

  /**
   * @param {boolean} allowLate contingência do gerente: permite registrar
   *   depois da janela, enquanto o turno ainda estiver em vigor.
   */
  function registerCheckin({ brokerId, method, distance, note, allowLate = false }) {
    const st = status();
    if (allowLate && !st.open && st.active) st.open = st.active;
    if (!st.open) {
      const msg = st.next
        ? `Check-in fechado. Próxima janela: ${st.next.label} às ${st.next.checkinStart}.`
        : 'Check-in fechado no momento.';
      throw new AppError(msg, 409, 'window_closed');
    }
    const broker = repo.getBroker(brokerId);
    if (!broker || !broker.active) throw new AppError('Corretor não encontrado ou inativo.', 404, 'not_found');

    const existing = repo.findCheckin(broker.id, st.localDate, st.open.id);
    if (existing) {
      return { broker, shift: st.open, checkin: existing, alreadyCheckedIn: true };
    }
    const checkin = repo.insertCheckin({
      broker_id: broker.id,
      shift_id: st.open.id,
      local_date: st.localDate,
      local_time: st.localTime,
      checkin_at: st.now,
      method,
      distance,
      note,
    });
    logger.info('checkin.created', { brokerId: broker.id, shift: st.open.id, method, distance });
    return { broker, shift: st.open, checkin, alreadyCheckedIn: false };
  }

  function faceCheckin(descriptor) {
    // Checa a janela antes de comparar rostos: resposta mais rápida e clara.
    const st = status();
    if (!st.open) return registerCheckin({ brokerId: null, method: 'face' });

    const result = findBestMatch(descriptor, repo.faceGallery(), cfg.face);
    if (!result.match) {
      logger.warn('checkin.face_rejected', { reason: result.reason, best: result.best?.distance });
      const msg =
        result.reason === 'ambiguous'
          ? 'Não foi possível confirmar sua identidade. Tente de novo, olhando para a câmera.'
          : 'Rosto não reconhecido. Procure o gerente para cadastrar.';
      throw new AppError(msg, 404, result.reason);
    }
    return registerCheckin({
      brokerId: result.match.id,
      method: 'face',
      distance: Number(result.match.distance.toFixed(4)),
    });
  }

  /**
   * Distribui um lead recebido do RD para o próximo corretor apto.
   * Idempotente: o mesmo deal só é distribuído uma vez (reentrega do webhook
   * só reprocessa se a tentativa anterior falhou).
   */
  async function assignLead(dealId) {
    const existing = repo.findLead(dealId);
    if (existing && existing.status !== 'error') return { lead: existing, duplicate: true };

    const st = status();
    const reservation = repo.tx(() => {
      const again = repo.findLead(dealId);
      if (again && again.status !== 'error') return { lead: again, duplicate: true };

      const candidates = st.active
        ? repo.shiftRoster(st.localDate, st.active.id).filter((r) => r.active && r.rd_user_id)
        : [];
      const chosen = pickNextBroker(candidates);
      const ownerId = chosen ? chosen.rd_user_id : cfg.rd.fallbackOwnerId || null;

      const row = {
        rd_deal_id: dealId,
        broker_id: chosen ? chosen.broker_id : null,
        owner_id: ownerId,
        shift_id: st.active ? st.active.id : null,
        local_date: st.localDate,
        status: ownerId ? 'pending' : 'error',
        error: ownerId ? null : 'Nenhum corretor apto e nenhum responsável reserva configurado.',
        created_at: st.now,
      };
      if (again) {
        repo.raw.prepare('DELETE FROM lead_assignments WHERE rd_deal_id = ?').run(dealId);
      }
      return { lead: repo.insertLead(row), chosen, duplicate: false };
    });

    if (reservation.duplicate) return reservation;
    const { lead, chosen } = reservation;
    if (lead.status === 'error') {
      logger.error('lead.no_owner', { dealId });
      return { lead, duplicate: false };
    }

    try {
      await rd.assignDealOwner(dealId, lead.owner_id);
      const finalStatus = !chosen ? 'fallback' : rd.dryRun ? 'dry_run' : 'assigned';
      const updated = repo.updateLead(dealId, { status: finalStatus });
      logger.info('lead.assigned', { dealId, brokerId: lead.broker_id, ownerId: lead.owner_id, status: finalStatus });
      return { lead: updated, duplicate: false };
    } catch (e) {
      logger.error('lead.rd_error', { dealId, error: e.message, status: e.status, body: e.body });
      const updated = repo.updateLead(dealId, { status: 'error', error: e.message });
      return { lead: updated, duplicate: false };
    }
  }

  return { status, eligibleNow, registerCheckin, faceCheckin, assignLead };
}

module.exports = { createServices, AppError };
