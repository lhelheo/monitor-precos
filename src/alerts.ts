import { config } from './config.ts';
import { alerts, prices } from './db.ts';
import type { ProductRow } from './types.ts';

/** Estatísticas de preço efetivo de um produto (ver prices.statsForProduct). */
export type PriceStats = { min: number; max: number; median: number; count: number; firstTs: number } | null;

type AlertsCfg = typeof config.alerts;

/**
 * Decide se um novo preço merece alerta. As estatísticas são calculadas ANTES de gravar o ponto novo.
 * Retorna lista de motivos (vazia = não alertar).
 */
export function alertReasons({
  product,
  effectiveCents,
  inStock,
  statsAll,
  statsWindow,
  now = Date.now(),
  cfg = config.alerts,
}: {
  product: ProductRow;
  effectiveCents: number | null;
  inStock: boolean;
  statsAll: PriceStats;
  statsWindow: PriceStats;
  now?: number;
  cfg?: AlertsCfg;
}): string[] {
  if (!inStock || !effectiveCents) return [];
  const reasons: string[] = [];

  if (product.target_cents && effectiveCents <= product.target_cents) reasons.push('alvo');

  const historyOk = statsAll && now - statsAll.firstTs >= cfg.minHistoryDays * 86400_000;
  if (historyOk && statsAll && effectiveCents < statsAll.min) reasons.push('minima_historica');

  if (historyOk && statsWindow && statsWindow.count >= 5) {
    const limit = Math.round(statsWindow.median * (1 - cfg.belowMedianPct / 100));
    if (effectiveCents <= limit) reasons.push('abaixo_mediana');
  }
  return reasons;
}

/** Último alerta enviado de um produto (ou undefined). */
type LastAlert = ReturnType<typeof alerts.lastForProduct>;

/** Evita alertas repetidos: dentro do período de espera só alerta de novo se cair pelo menos 1% a mais. */
export function shouldNotify({
  productId,
  effectiveCents,
  now = Date.now(),
  cfg = config.alerts,
  last = alerts.lastForProduct(productId),
}: {
  productId: number;
  effectiveCents: number | null;
  now?: number;
  cfg?: AlertsCfg;
  last?: LastAlert;
}): boolean {
  const eff = effectiveCents ?? 0;
  if (!last) return true;
  const withinCooldown = now - last.ts < cfg.cooldownHours * 3600_000;
  if (!withinCooldown) return eff < last.effective_cents * 1.05; // não realerta se o preço subiu muito desde então
  return eff <= Math.round(last.effective_cents * 0.99);
}

export function statsFor(productId: number, now = Date.now()): { statsAll: PriceStats; statsWindow: PriceStats } {
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
