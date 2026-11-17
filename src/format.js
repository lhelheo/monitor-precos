import { config } from './config.js';
import { REASON_LABEL } from './alerts.ts';
import { fmt } from './stores/common.ts';
import { STORES } from './stores/index.js';

export const esc = (s) => String(s ?? '').replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[c]);

const CONF = { confirmed: '🟢 confirmado', probable: '🟡 provável', unverified: '⚪ não verificado' };

/** Mensagem de alerta (HTML do Telegram). */
export function formatAlert({ product, listing, scraped, eff, reasons, statsAll }) {
  const b = eff.breakdown;
  const lines = [
    `🔥 <b>${esc(product.name)}</b>`,
    `${STORES[listing.store]?.name ?? listing.store}: <b>${fmt(eff.effectiveCents)}</b> ${b.coupon ? `(${CONF[eff.confidence]})` : ''}`,
    '',
    reasons.map((r) => REASON_LABEL[r] ?? r).join('\n'),
    '',
    `💳 Preço: ${fmt(b.priceCents)}${scraped.listCents ? ` <s>${fmt(scraped.listCents)}</s>` : ''}`,
  ];
  if (b.baseCents !== b.priceCents) lines.push(`⚡ ${b.baseKind}: ${fmt(b.baseCents)}`);
  if (b.coupon) lines.push(`🎟️ Cupom: <code>${esc(b.coupon.code ?? '—')}</code> ${esc(b.coupon.label)} → −${fmt(b.coupon.discountCents)}`);
  if (b.cashbackCents) lines.push(`💰 Cashback: ${fmt(b.cashbackCents)}${b.cashbackCounted ? ' (incluído)' : ' (não incluído)'}`);
  for (const h of b.hints.slice(0, 3)) {
    lines.push(`💡 Possível: <code>${esc(h.code ?? '—')}</code> ${esc(h.label)} → ${fmt(h.wouldBeCents)} (${h.blocker ?? CONF[h.confidence]})`);
  }
  if (listing.store === 'zoom') lines.push('⚠️ Preço de comparador (Zoom): confira na loja antes de comprar');
  if (product.target_cents) lines.push(`🎯 Alvo: ${fmt(product.target_cents)}`);
  if (statsAll) lines.push(`📊 Histórico: mín ${fmt(statsAll.min)} · mediana ${fmt(statsAll.median)}`);
  if (scraped.seller) lines.push(`🏪 Vendido por: ${esc(scraped.seller)}`);
  lines.push('', `<a href="${esc(listing.url)}">Abrir oferta</a>${config.web.publicUrl ? ` · <a href="${esc(config.web.publicUrl)}/#p${product.id}">Histórico</a>` : ''}`);
  return lines.join('\n');
}

/**
 * Mensagem de canal de promoção que menciona um produto monitorado.
 * @param {{ product: any, text: string, deal: any, coupons: any[], channel: string, link?: string }} args
 */
export function formatDeal(args) {
  const { product, text, deal, coupons, channel, link } = args;
  const lines = [`📣 <b>${esc(product.name)}</b> apareceu em <b>${esc(channel)}</b>`];
  if (deal?.finalCents) lines.push(`Preço anunciado: <b>${fmt(deal.finalCents)}</b>${product.target_cents ? ` (alvo ${fmt(product.target_cents)})` : ''}`);
  for (const c of coupons) lines.push(`🎟️ <code>${esc(c.code)}</code> (${CONF[c.confidence]})`);
  lines.push('', esc(text.slice(0, 700)));
  if (link) lines.push('', `<a href="${esc(link)}">Ver mensagem</a>`);
  return lines.join('\n');
}
