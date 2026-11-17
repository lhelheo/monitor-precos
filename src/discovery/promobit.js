import { fetchHtml, renderHtml } from '../http.js';
import { BlockedError, findDeep, loadHtml, nextData, toCents } from '../stores/common.js';

/**
 * Promobit: agregador de ofertas. A busca só funciona com a página renderizada no navegador;
 * os detalhes de cada oferta vêm dos dados embutidos na própria página da oferta (sem navegador).
 */
const BASE = 'https://www.promobit.com.br';

/** Links de ofertas de uma busca. Devolve [{ id, url }] (id = número no fim do endereço). */
export async function searchPromobit(term) {
  const r = await renderHtml(`${BASE}/buscar/?q=${encodeURIComponent(term)}`, { waitMs: 5000 });
  if (!r.html || r.html.length < 5000) throw new BlockedError('promobit', 'busca vazia');
  const out = new Map();
  for (const m of r.html.matchAll(/href="(\/oferta\/[^"]+)"/g)) {
    const id = m[1].match(/-(\d+)\/?$/)?.[1];
    if (id && !out.has(id)) out.set(id, { id, url: BASE + m[1] });
  }
  return [...out.values()];
}

/** Texto legível do endereço da oferta ("controle-sem-fio-dualsense-3200281/" -> "controle sem fio dualsense"). */
export function slugText(url) {
  const slug = decodeURIComponent(url.split('/oferta/')[1] ?? '').replace(/\/$/, '');
  return slug.replace(/-\d+$/, '').replace(/-/g, ' ');
}

/** Dados de uma oferta, a partir da página da oferta. Exportado para testes. */
export function parseOffer(html, offerId) {
  const nd = nextData(loadHtml(html));
  const o = nd ? findDeep(nd.props, (x) => String(x.offerId) === String(offerId) && 'offerTitle' in x) : null;
  if (!o) return null;
  return {
    title: o.offerTitle,
    priceCents: toCents(o.offerPrice),
    oldCents: toCents(o.offerOldPrice),
    store: o.storeName ?? null,
    status: o.offerStatusName ?? null,
    coupon: typeof o.offerCoupon === 'string' && o.offerCoupon ? o.offerCoupon : null,
    published: o.offerPublished ?? null,
  };
}

export async function fetchOffer(url, id) {
  const r = await fetchHtml(url);
  if (r.status !== 200) throw new BlockedError('promobit', `oferta HTTP ${r.status}`);
  return parseOffer(r.html, id);
}

/** Nome da loja do Promobit -> id interno (ou 'any' se não reconhecer). */
export function storeIdFromName(name) {
  const n = String(name || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  if (n.includes('kabum')) return 'kabum';
  if (n.includes('amazon')) return 'amazon';
  if (n.includes('magalu') || n.includes('magazine')) return 'magalu';
  if (n.includes('mercado')) return 'mercadolivre';
  if (n.includes('shopee')) return 'shopee';
  return 'any';
}
