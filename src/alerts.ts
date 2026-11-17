import { config } from './config.ts';
import { alerts, prices } from './db.ts';

/**
 * Decide se um novo preço merece alerta. `statsBefore` são estatísticas calculadas ANTES de gravar o ponto novo.
 * Retorna lista de motivos (vazia = não alertar).
 */
export function alertReasons({ product, effectiveCents, inStock, statsAll, statsWindow, now = Date.now(), cfg = config.alerts }: any) {
  if (!inStock || !effectiveCents) return [];
  const reasons = [];

  if (product.target_cents && effectiveCents <= product.target_cents) reasons.push('alvo');

  const historyOk = statsAll && now - statsAll.firstTs >= cfg.minHistoryDays * 86400_000;
  if (historyOk && effectiveCents < statsAll.min) reasons.push('minima_historica');

  if (historyOk && statsWindow && statsWindow.count >= 5) {
    const limit = Math.round(statsWindow.median * (1 - cfg.belowMedianPct / 100));
    if (effectiveCents <= limit) reasons.push('abaixo_mediana');
  }
  return reasons;
}

/** Evita alertas repetidos: dentro do período de espera só alerta de novo se cair pelo menos 1% a mais. */
export function shouldNotify({ productId, effectiveCents, now = Date.now(), cfg = config.alerts, last = alerts.lastForProduct(productId) }: any) {
  if (!last) return true;
  const withinCooldown = now - last.ts < cfg.cooldownHours * 3600_000;
  if (!withinCooldown) return effectiveCents < last.effective_cents * 1.05; // não realerta se o preço subiu muito desde então
  return effectiveCents <= Math.round(last.effective_cents * 0.99);
}

export function statsFor(productId: any, now = Date.now()) {
  return {
    statsAll: prices.statsForProduct(productId, 0),
    statsWindow: prices.statsForProduct(productId, now - config.alerts.medianWindowDays * 86400_000),
  };
}

export const REASON_LABEL: Record<string, string> = {
  alvo: '🎯 atingiu seu preço-alvo',
  minima_historica: '📉 menor preço já registrado',
  abaixo_mediana: '🔻 bem abaixo da mediana recente',
};
