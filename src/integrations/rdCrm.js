'use strict';

/**
 * Cliente mínimo da API do RD Station CRM (v2).
 *
 * ATENÇÃO — validar com a documentação oficial antes de desligar o RD_DRY_RUN:
 *   https://developers.rdstation.com/reference/crm-v2-update-deal
 *   - Formato do corpo do PUT (assumido: { data: { owner_id } })
 *   - Tipo de autenticação (assumido: Bearer token OAuth)
 * Toda a dependência do formato do RD está isolada neste arquivo.
 */

class RdCrmError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = 'RdCrmError';
    this.status = status;
    this.body = body;
  }
}

function createRdClient({ apiBase, accessToken, dryRun }, { fetchImpl = fetch, logger } = {}) {
  async function request(method, path, body, attempt = 1) {
    const res = await fetchImpl(`${apiBase}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10_000),
    });
    const text = await res.text();
    if (res.ok) return text ? JSON.parse(text) : null;

    const retryable = res.status === 429 || res.status >= 500;
    if (retryable && attempt < 3) {
      const wait = 500 * 2 ** (attempt - 1);
      logger?.warn('rd.retry', { status: res.status, attempt, wait });
      await new Promise((r) => setTimeout(r, wait));
      return request(method, path, body, attempt + 1);
    }
    throw new RdCrmError(`RD CRM respondeu ${res.status}`, res.status, text.slice(0, 500));
  }

  return {
    dryRun,
    /** Troca o responsável (dono) da negociação. */
    async assignDealOwner(dealId, ownerId) {
      if (dryRun) {
        logger?.info('rd.dry_run.assign', { dealId, ownerId });
        return { dryRun: true };
      }
      return request('PUT', `/deals/${encodeURIComponent(dealId)}`, { data: { owner_id: ownerId } });
    },
  };
}

/**
 * Extrai o ID da negociação do corpo do webhook. Aceita os formatos mais
 * comuns para não quebrar se o RD mudar o envelope.
 */
function extractDealId(body) {
  if (!body || typeof body !== 'object') return null;
  const candidates = [
    body.document?.id,
    body.deal?.id,
    body.data?.id,
    body.deal_id,
    body.id,
  ];
  const id = candidates.find((v) => typeof v === 'string' || typeof v === 'number');
  return id === undefined ? null : String(id);
}

module.exports = { createRdClient, extractDealId, RdCrmError };
