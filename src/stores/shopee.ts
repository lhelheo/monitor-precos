import { renderHtml } from '../http.ts';
import { BlockedError, cleanText, loadHtml, productFromJsonLd } from './common.ts';

export const id = 'shopee';
export const name = 'Shopee';
export const match = (u) => /(^|\.)shopee\.com\.br$/i.test(new URL(u).hostname);

/** shopee.com.br/nome-i.SHOPID.ITEMID  ou  shopee.com.br/product/SHOPID/ITEMID */
export function ids(u) {
  const p = new URL(u).pathname;
  const m = p.match(/-i\.(\d+)\.(\d+)/) || p.match(/\/product\/(\d+)\/(\d+)/);
  return m ? { shopId: m[1], itemId: m[2] } : null;
}
export const externalId = (u) => {
  const x = ids(u);
  return x ? `${x.shopId}.${x.itemId}` : null;
};

// Preços na API interna da Shopee vêm multiplicados por 100000
const shopeeCents = (v) => (typeof v === 'number' && v > 0 ? Math.round(v / 1000) : null);

/** Interpreta a resposta da API interna da página de produto (pdp). Exportado para testes. */
export function parseApi(json) {
  const item = json?.data?.item || json?.data;
  if (!item || (item.price === undefined && item.price_min === undefined)) return null;
  const priceCents = shopeeCents(item.price) ?? shopeeCents(item.price_min);
  const before = shopeeCents(item.price_before_discount) ?? shopeeCents(item.price_min_before_discount);
  const stock = item.stock ?? item.normal_stock ?? json?.data?.product_meta?.stock;
  return {
    title: item.title || item.name || null,
    priceCents,
    pixCents: null,
    listCents: before && before > priceCents ? before : null,
    inStock: stock === undefined ? true : stock > 0,
    seller: json?.data?.shop_detailed?.name || null,
    pageCoupons: [],
  };
}

export async function scrape(url) {
  // A Shopee monta a página via API interna assinada; capturamos a resposta dela no navegador.
  /** @type {any} */
  let apiData = null;
  const r = await renderHtml(url, {
    waitMs: 6000,
    onResponse: async (res) => {
      if (apiData || !/\/api\/v4\/pdp\/get|\/api\/v4\/item\/get/.test(res.url())) return;
      try {
        apiData = parseApi(await res.json());
      } catch {
        /* ignora */
      }
    },
  });
  if (apiData?.priceCents) return { ...apiData, externalId: externalId(url) };

  const $ = loadHtml(r.html);
  const ld = productFromJsonLd($);
  if (ld?.priceCents) {
    return {
      title: ld.title,
      priceCents: ld.priceCents,
      pixCents: null,
      listCents: null,
      inStock: ld.inStock ?? true,
      seller: ld.seller,
      pageCoupons: [],
      externalId: externalId(url),
    };
  }
  const loginWall = /buyer\/login|Fa[cç]a login/i.test(r.url + cleanText($('title').text()));
  throw new BlockedError(id, loginWall ? 'a Shopee exigiu login' : `HTTP ${r.status}`);
}
