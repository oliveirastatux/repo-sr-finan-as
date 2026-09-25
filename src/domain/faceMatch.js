'use strict';

/**
 * Comparação de "assinaturas faciais" (descritores de 128 números gerados
 * pelo face-api no navegador). Não guardamos fotos, só esses vetores.
 *
 * Distância euclidiana < ~0.6 costuma indicar a mesma pessoa; usamos um
 * limite mais rígido por padrão (0.5) para reduzir falsos positivos.
 */

const DESCRIPTOR_LENGTH = 128;

function isValidDescriptor(d) {
  return (
    Array.isArray(d) &&
    d.length === DESCRIPTOR_LENGTH &&
    d.every((x) => typeof x === 'number' && Number.isFinite(x))
  );
}

function euclidean(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) {
    const diff = a[i] - b[i];
    sum += diff * diff;
  }
  return Math.sqrt(sum);
}

/**
 * @param {number[]} probe descritor capturado agora
 * @param {{id:number, descriptors:number[][]}[]} people cadastrados ativos
 * @param {{threshold:number, margin:number}} opts
 *   threshold: distância máxima aceita
 *   margin: diferença mínima entre o 1º e o 2º colocado (evita confundir
 *           pessoas parecidas — se ficar ambíguo, recusamos)
 */
function findBestMatch(probe, people, { threshold = 0.5, margin = 0.05 } = {}) {
  const ranked = people
    .map((p) => ({
      id: p.id,
      distance: Math.min(...p.descriptors.map((d) => euclidean(probe, d))),
    }))
    .filter((r) => Number.isFinite(r.distance))
    .sort((a, b) => a.distance - b.distance);

  const [best, second] = ranked;
  if (!best || best.distance > threshold) return { match: null, reason: 'not_recognized', best };
  if (second && second.distance - best.distance < margin && second.distance <= threshold) {
    return { match: null, reason: 'ambiguous', best };
  }
  return { match: best, reason: null, best };
}

module.exports = { DESCRIPTOR_LENGTH, isValidDescriptor, euclidean, findBestMatch };
