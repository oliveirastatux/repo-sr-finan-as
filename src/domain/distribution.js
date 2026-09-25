'use strict';

/**
 * Rodízio justo entre os corretores aptos.
 *
 * Critério (em ordem):
 *   1. Quem recebeu MENOS leads no turno atual.
 *   2. Empate: quem recebeu o último lead há mais tempo (ou nunca).
 *   3. Empate: quem fez check-in primeiro (premia quem chegou cedo).
 *
 * Função pura: recebe os dados prontos e devolve o escolhido.
 *
 * @param {{broker_id:number, checkin_at:string, leads_in_shift:number, last_assigned_at:string|null}[]} candidates
 */
function pickNextBroker(candidates) {
  if (!candidates.length) return null;
  const ts = (v) => (v ? Date.parse(v) : -Infinity);
  return [...candidates].sort(
    (a, b) =>
      a.leads_in_shift - b.leads_in_shift ||
      ts(a.last_assigned_at) - ts(b.last_assigned_at) ||
      Date.parse(a.checkin_at) - Date.parse(b.checkin_at) ||
      a.broker_id - b.broker_id,
  )[0];
}

module.exports = { pickNextBroker };
