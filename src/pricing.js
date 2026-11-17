import { config } from './config.js';

const RANK = { confirmed: 3, probable: 2, unverified: 1 };

const norm = (s) =>
  String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');

/**
 * Motivo pelo qual um cupom não se aplica (ou null se aplica).
 * @param {any} coupon
 * @param {{ priceCents: number, title?: any, user?: { firstPurchase?: boolean, amazonPrime?: boolean } }} options
 */
export function couponBlocker(coupon, options) {
  const { priceCents, title, user = config.user } = options;
  if (!coupon.kind || !coupon.value) return 'sem valor conhecido';
  if (coupon.conditions?.firstPurchase && !user.firstPurchase) return 'só primeira compra';
  if (coupon.minCents && priceCents < coupon.minCents) return 'abaixo do valor mínimo';
  if (coupon.keywords?.length) {
    const t = norm(title);
    if (!coupon.keywords.some((k) => t.includes(norm(k)))) return 'categoria/produto diferente';
  }
  return null;
}

export function couponDiscount(coupon, baseCents) {
  let d = coupon.kind === 'pct' ? Math.round((baseCents * coupon.value) / 100) : Math.round(coupon.value * 100);
  if (coupon.maxDiscountCents) d = Math.min(d, coupon.maxDiscountCents);
  return Math.max(0, Math.min(d, baseCents));
}

/**
 * Calcula o menor preço efetivo de um anúncio.
 *   base   = menor entre preço normal e preço Pix (da página ou regra da loja)
 *   cupom  = o melhor cupom aplicável (cupons normalmente não acumulam)
 *   cashback (opcional, por loja)
 * Confiança do resultado = confiança do cupom usado (ou "confirmed" se nenhum).
 *
 * @param {any} scraped  resultado do coletor
 * @param {any[]} [coupons]  cupons da loja (página + canais + manuais)
 * @param {{ minConfidence?: string, user?: { firstPurchase?: boolean, amazonPrime?: boolean }, rules?: any }} [options]
 *   minConfidence: menor confiança aceita para entrar no preço efetivo
 */
export function effectivePrice(scraped, coupons = [], options = {}) {
  const { minConfidence = 'probable', user = config.user, rules } = options;
  const r = rules ?? config.stores[scraped.store] ?? {};
  const price = scraped.priceCents;
  if (!price) return null;

  let base = price;
  let baseKind = 'preço';
  if (scraped.pixCents && scraped.pixCents < base) {
    base = scraped.pixCents;
    baseKind = 'Pix/à vista';
  } else if (r.pixExtraPct > 0) {
    base = Math.round(price * (1 - r.pixExtraPct / 100));
    baseKind = `Pix (-${r.pixExtraPct}%)`;
  }

  const evaluated = coupons.map((c) => {
    const blocker = couponBlocker(c, { priceCents: price, title: scraped.title, user });
    return { coupon: c, blocker, discountCents: blocker ? 0 : couponDiscount(c, base) };
  });

  const usable = evaluated.filter((e) => !e.blocker && RANK[e.coupon.confidence] >= RANK[minConfidence]);
  // melhor desconto; empate => maior confiança
  usable.sort((a, b) => b.discountCents - a.discountCents || RANK[b.coupon.confidence] - RANK[a.coupon.confidence]);
  const best = usable[0] && usable[0].discountCents > 0 ? usable[0] : null;

  let effective = base - (best?.discountCents ?? 0);
  let cashbackCents = 0;
  if (r.cashbackPct > 0) {
    cashbackCents = Math.round((effective * r.cashbackPct) / 100);
    if (r.countCashback) effective -= cashbackCents;
  }

  // Cupons que dariam preço ainda menor, mas com confiança baixa ou condição — mostrados como "dica"
  const hints = evaluated
    .filter((e) => e !== best && e.coupon.kind && e.coupon.value)
    .map((e) => ({
      code: e.coupon.code,
      label: couponLabel(e.coupon),
      confidence: e.coupon.confidence,
      blocker: e.blocker || (RANK[e.coupon.confidence] < RANK[minConfidence] ? 'confiança baixa' : null),
      wouldBeCents: base - couponDiscount(e.coupon, base),
    }))
    .filter((h) => h.wouldBeCents < effective);

  return {
    effectiveCents: effective,
    confidence: best ? best.coupon.confidence : 'confirmed',
    breakdown: {
      priceCents: price,
      baseCents: base,
      baseKind,
      coupon: best
        ? {
            code: best.coupon.code,
            label: couponLabel(best.coupon),
            source: best.coupon.source,
            confidence: best.coupon.confidence,
            discountCents: best.discountCents,
            conditions: best.coupon.conditions,
          }
        : null,
      cashbackCents,
      cashbackCounted: Boolean(r.countCashback && cashbackCents),
      hints,
    },
  };
}

export function couponLabel(c) {
  const v = c.kind === 'pct' ? `${c.value}%` : `R$ ${Number(c.value).toFixed(2).replace('.', ',')}`;
  const parts = [c.code ? `${c.code} (${v})` : `cupom ${v}`];
  if (c.conditions?.clipCoupon) parts.push('marcar cupom na página');
  if (c.conditions?.appOnly) parts.push('só no app');
  if (c.conditions?.payment) parts.push(`pagando com ${c.conditions.payment}`);
  if (c.minCents) parts.push(`mín. R$ ${(c.minCents / 100).toFixed(0)}`);
  return parts.join(', ');
}
