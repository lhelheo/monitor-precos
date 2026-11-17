import { config } from './config.ts';
import { coupons, listings, prices, products, alerts } from './db.ts';
import { effectivePrice } from './pricing.ts';
import { alertReasons, shouldNotify, statsFor } from './alerts.ts';
import { scrape, STORES } from './stores/index.ts';
import { BlockedError } from './stores/common.ts';
import { esc, formatAlert } from './format.ts';
import { notify } from './notifier.ts';
import { log } from './log.ts';

const HEARTBEAT_MS = 6 * 3600_000; // grava ponto mesmo sem mudança a cada 6h (gráfico contínuo)

function nextCheck(listing: any, now = Date.now()) {
  const min = listing.interval_min || config.scheduler.defaultIntervalMin;
  const jitter = 1 + (Math.random() * 2 - 1) * config.scheduler.jitterPct;
  return now + Math.round(min * 60_000 * jitter);
}

function backoff(listing: any, err: any, now = Date.now()) {
  const min = listing.interval_min || config.scheduler.defaultIntervalMin;
  const fails = (listing.fail_count || 0) + 1;
  const factor = err instanceof BlockedError ? 3 : 2;
  return now + Math.min(min * 60_000 * factor ** Math.min(fails, 5), 6 * 3600_000);
}

/** Verifica um anúncio: coleta, calcula preço efetivo, grava histórico e dispara alertas. */
export async function checkListing(listing: any, { silent = false } = {}) {
  const product = products.get(listing.product_id);
  if (!product) throw new Error(`produto ${listing.product_id} não existe`);
  const startedAt = Date.now();
  let scraped;
  try {
    scraped = await scrape(listing.url);
  } catch (err: any) {
    listings.markFail(listing.id, err.message, backoff(listing, err));
    log.warn(`#${listing.id} ${listing.store}: ${err.message}`);
    // avisa uma única vez quando um anúncio começa a falhar seguidamente
    if (listing.fail_count + 1 === 5 && !silent) {
      await notify(`⚠️ <b>${esc(product?.name)}</b> (${STORES[listing.store]?.name}) falhou 5 vezes seguidas:\n<code>${esc(err.message)}</code>`);
    }
    return { ok: false, error: err.message };
  }

  // cupons que aparecem na própria página do anúncio
  for (const c of scraped.pageCoupons || []) {
    if (!c.kind || !c.value) continue;
    coupons.upsert({ ...c, store: listing.store, listingId: listing.id, source: 'page' });
  }
  coupons.expirePageCoupons(listing.id, startedAt);

  const active = coupons.activeFor(listing.store, listing.id);
  const minConfidence = config.alerts.includeProbableCoupons ? 'probable' : 'confirmed';
  const eff = effectivePrice(scraped, active, { minConfidence });
  const effectiveCents = eff?.effectiveCents ?? null;
  const inStock = Boolean(scraped.inStock && scraped.priceCents);

  // estatísticas ANTES de gravar o ponto novo
  const { statsAll, statsWindow } = statsFor(product.id);

  const last = prices.last(listing.id);
  const changed =
    !last ||
    last.price_cents !== (scraped.priceCents ?? null) ||
    last.pix_cents !== (scraped.pixCents ?? null) ||
    last.effective_cents !== effectiveCents ||
    Boolean(last.in_stock) !== inStock;
  if (changed || Date.now() - last.ts > HEARTBEAT_MS) {
    prices.insert({
      listingId: listing.id,
      priceCents: scraped.priceCents,
      pixCents: scraped.pixCents,
      listCents: scraped.listCents,
      effectiveCents,
      effectiveConfidence: eff?.confidence,
      inStock,
      seller: scraped.seller,
      breakdown: eff?.breakdown,
    });
  }

  listings.markOk(listing.id, {
    title: scraped.title,
    externalId: scraped.externalId,
    priceCents: scraped.priceCents,
    effectiveCents,
    inStock,
    nextCheckAt: nextCheck(listing),
  });

  if (changed) {
    log.info(
      `#${listing.id} ${listing.store}: ${inStock ? '' : '(sem estoque) '}preço ${scraped.priceCents / 100} → efetivo ${effectiveCents / 100}` +
        (eff?.breakdown.coupon ? ` [${eff.breakdown.coupon.label}]` : ''),
    );
  }

  const reasons = alertReasons({ product, effectiveCents, inStock, statsAll, statsWindow });
  let notified = false;
  if (reasons.length && !silent && shouldNotify({ productId: product.id, effectiveCents })) {
    alerts.insert({ productId: product.id, listingId: listing.id, effectiveCents, reasons });
    await notify(formatAlert({ product, listing, scraped, eff, reasons, statsAll }), { disablePreview: false });
    notified = true;
  }
  return { ok: true, scraped, eff, reasons, notified, changed };
}

