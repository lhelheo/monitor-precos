import { config } from '../config.js';
import { fetchHtml, fetchJson, renderHtml } from '../http.ts';
import { parseCoupons } from '../coupons/parser.ts';
import { log } from '../log.js';
import { BlockedError, cleanText, loadHtml, metaPrice, productFromJsonLd, toCents } from './common.ts';

export const id = 'mercadolivre';
export const name = 'Mercado Livre';
export const match = (u) => /(^|\.)mercadoli(vre|bre)\.com(\.br)?$/i.test(new URL(u).hostname);

/** { item: 'MLB123...' } para anúncio, { product: 'MLB123...' } para página de catálogo (/p/). */
export function ids(u) {
  const url = new URL(u);
  const q = url.searchParams.get('wid') || url.searchParams.get('item_id') ||
    url.searchParams.get('pdp_filters')?.match(/item_id[:%3A]+(MLB\d+)/i)?.[1];
  const item = q || url.pathname.match(/\/(MLB)-?(\d{6,})/i)?.slice(1).join('');
  const product = url.pathname.match(/\/p\/(MLB\d+)/i)?.[1];
  return { item: item ? item.toUpperCase() : null, product: product ? product.toUpperCase() : null };
}
export const externalId = (u) => {
  const { item, product } = ids(u);
  return product || item;
};

// ---------------- API oficial (recomendada) ----------------
let token = null;
let tokenExp = 0;

async function getToken() {
  const { clientId, clientSecret } = config.mercadoLivre;
  if (!clientId || !clientSecret) return null;
  if (token && Date.now() < tokenExp - 60_000) return token;
  const res = await fetch('https://api.mercadolibre.com/oauth/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret }),
    signal: AbortSignal.timeout(15000),
  });
  /** @type {any} */
  const j: any = await res.json().catch(() => ({}));
  if (!res.ok || !j.access_token) throw new Error(`Mercado Livre OAuth falhou: HTTP ${res.status} ${j.message || ''}`);
  token = j.access_token;
  tokenExp = Date.now() + (j.expires_in || 21600) * 1000;
  return token;
}

async function api(path) {
  const t = await getToken();
  const r = await fetchJson(`https://api.mercadolibre.com${path}`, {
    headers: t ? { authorization: `Bearer ${t}` } : {},
  });
  if (r.status !== 200) throw new Error(`API ML ${path}: HTTP ${r.status} ${r.json?.message || ''}`);
  return r.json;
}

async function viaApi(u) {
  const { item, product } = ids(u);
  if (product && !item) {
    const p = await api(`/products/${product}`);
    const bb = p.buy_box_winner;
    if (!bb) return { title: p.name, priceCents: null, inStock: false, seller: null, pageCoupons: [] };
    return {
      title: p.name,
      priceCents: toCents(bb.price),
      pixCents: null,
      listCents: bb.original_price ? toCents(bb.original_price) : null,
      inStock: true,
      seller: bb.seller_id ? `seller ${bb.seller_id}` : null,
      pageCoupons: [],
    };
  }
  const it = await api(`/items/${item}`);
  return {
    title: it.title,
    priceCents: toCents(it.price),
    pixCents: null,
    listCents: it.original_price ? toCents(it.original_price) : null,
    inStock: it.status === 'active' && (it.available_quantity ?? 1) > 0,
    seller: it.seller_id ? `seller ${it.seller_id}` : null,
    pageCoupons: [],
  };
}

// ---------------- HTML (alternativa) ----------------
const isBlockedPage = (html) => /suspicious-traffic|account-verification|captcha/i.test(html.slice(0, 5000));

export function parse(html) {
  if (isBlockedPage(html)) return { blocked: true };
  const $ = loadHtml(html);
  const ld = productFromJsonLd($);
  const priceCents =
    toCents($('meta[itemprop="price"]').attr('content')) ?? ld?.priceCents ?? metaPrice($);
  if (!priceCents) return null;
  const listTxt = $('.ui-pdp-price__original-value .andes-money-amount__fraction').first().text();
  const listCents = listTxt ? toCents(listTxt + ',' + ($('.ui-pdp-price__original-value .andes-money-amount__cents').first().text() || '00')) : null;
  const couponText = cleanText($('[class*="coupon"], .ui-pdp-promotions-pill-label, .ui-vpp-coupons').text());
  return {
    title: ld?.title || cleanText($('h1.ui-pdp-title').text()) || null,
    priceCents,
    pixCents: null,
    listCents: listCents && listCents > priceCents ? listCents : null,
    inStock: ld?.inStock ?? !/indispon[ií]vel|pausad/i.test($('.ui-pdp-stock-information, .ui-pdp-message').text()),
    seller: ld?.seller || cleanText($('.ui-pdp-seller__link-trigger').first().text()) || null,
    pageCoupons: parseCoupons(couponText, { store: id }).map((c) => ({ ...c, confidence: c.kind ? 'confirmed' : 'probable' })),
  };
}

export async function scrape(url) {
  if (config.mercadoLivre.clientId) {
    try {
      return { ...(await viaApi(url)), externalId: externalId(url) };
    } catch (e) {
      log.warn(`ML API falhou, tentando página: ${e.message}`);
    }
  }
  let r = await fetchHtml(url);
  let data = r.status === 200 ? parse(r.html) : null;
  if (!data || data.blocked) {
    r = await renderHtml(url);
    data = parse(r.html);
  }
  if (!data || data.blocked) {
    throw new BlockedError(id, 'configure ML_CLIENT_ID/ML_CLIENT_SECRET para usar a API oficial');
  }
  return { ...data, externalId: externalId(url) };
}
