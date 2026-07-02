// QA-07 (bugfix) · Lógica PURA (sin DB) del día calendario en America/Lima
// (UTC-5, fijo, sin horario de verano — CLAUDE.md §6). Deliberadamente NO se
// importa `reports/report-window.util.ts` (cross-module import prohibido,
// `no-restricted-imports`): se replica el mismo cálculo mínimo dentro de
// `billing`, mismo criterio ya usado en `ingestion` (ver TRACEABILITY.md
// HU-11-03: "ventana ISO opcional, default 'hoy' Lima — lógica replicada
// inline para no acoplar `reports`").
//
// Root cause de QA-07: la card "Hoy" de Comprobantes sumaba `GET /api/sales`
// COMPLETO (histórico all-time, sin ventana de fecha — por diseño: es el
// listado del módulo) en vez de filtrar por el día. Este util resuelve la
// ventana correcta de "hoy" para un endpoint DEDICADO a ese agregado.

const LIMA_OFFSET_MINUTES = -5 * 60;
const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 24 * 60 * MS_PER_MINUTE;

/** Instante UTC de la medianoche (00:00) del día local (Lima) que contiene `at`. */
export function startOfLimaDay(at: Date): Date {
  const localMs = at.getTime() + LIMA_OFFSET_MINUTES * MS_PER_MINUTE;
  const localMidnightMs = Math.floor(localMs / MS_PER_DAY) * MS_PER_DAY;
  return new Date(localMidnightMs - LIMA_OFFSET_MINUTES * MS_PER_MINUTE);
}

/** Clave de día local (Lima) `YYYY-MM-DD` para un instante UTC. */
export function limaDayKey(at: Date): string {
  const local = new Date(at.getTime() + LIMA_OFFSET_MINUTES * MS_PER_MINUTE);
  const year = local.getUTCFullYear();
  const month = String(local.getUTCMonth() + 1).padStart(2, '0');
  const day = String(local.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
