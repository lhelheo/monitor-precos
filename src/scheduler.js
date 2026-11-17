import { config } from './config.js';
import { coupons, listings } from './db.js';
import { checkListing } from './checker.js';
import { log } from './log.js';
import { runPelandoAlerts, runSearchDiscovery } from './discovery/index.js';

/**
 * Agendador simples e econômico (pensado para 1 vCPU):
 * - a cada 15 s procura anúncios "vencidos";
 * - respeita um intervalo mínimo entre requisições à mesma loja;
 * - limita quantas verificações rodam ao mesmo tempo.
 */
export function startScheduler() {
  const lastHitByStore = new Map();
  const running = new Set();
  let stopped = false;

  async function tick() {
    if (stopped) return;
    const now = Date.now();
    for (const l of listings.due(now)) {
      if (running.size >= config.scheduler.concurrency) break;
      if (running.has(l.id)) continue;
      const busyStore = [...running].some((id) => listings.get(id)?.store === l.store);
      if (busyStore) continue;
      if (now - (lastHitByStore.get(l.store) ?? 0) < config.scheduler.perStoreGapSec * 1000) continue;

      lastHitByStore.set(l.store, now);
      running.add(l.id);
      checkListing(l)
        .catch((e) => log.error(`Erro inesperado ao verificar #${l.id}: ${e.stack || e.message}`))
        .finally(() => running.delete(l.id));
    }
  }

  const timer = setInterval(tick, 15_000);
  const housekeeping = setInterval(() => coupons.expireStale(48), 3600_000);
  const safe = (name, fn) => fn().catch((e) => log.warn(`${name}: ${e.message}`));
  const pelandoTimer = setInterval(() => safe('Pelando', runPelandoAlerts), 10 * 60_000);
  const searchTimer = setInterval(() => safe('Busca automática', runSearchDiscovery), 60 * 60_000);
  setTimeout(() => safe('Busca automática', runSearchDiscovery), 30_000);
  setTimeout(() => safe('Pelando', runPelandoAlerts), 20_000);
  setTimeout(tick, 2000);
  log.info(
    `Agendador iniciado: intervalo padrão ${config.scheduler.defaultIntervalMin} min, ` +
      `${config.scheduler.concurrency} verificação(ões) em paralelo, ${config.scheduler.perStoreGapSec}s entre acessos à mesma loja`,
  );

  return {
    stop() {
      stopped = true;
      clearInterval(timer);
      clearInterval(housekeeping);
      clearInterval(pelandoTimer);
      clearInterval(searchTimer);
    },
    get running() {
      return running.size;
    },
  };
}
