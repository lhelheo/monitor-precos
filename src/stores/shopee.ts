import { renderHtml } from '../http.ts';
import type { CouponInput } from '../types.ts';
import { asString, BlockedError, cleanText, isRecord, loadHtml, productFromJsonLd, type Obj } from './common.ts';

export const id = 'shopee';
export const name = 'Shopee';
export const match = (u: string) => /(^|\.)shopee\.com\.br$/i.test(new URL(u).hostname);

/** shopee.com.br/nome-i.SHOPID.ITEMID  ou  shopee.com.br/product/SHOPID/ITEMID */
export function ids(u: string) {
  const p = new URL(u).pathname;
  const m = p.match(/-i\.(\d+)\.(\d+)/) || p.match(/\/product\/(\d+)\/(\d+)/);
  return m ? { shopId: m[1], itemId: m[2] } : null;
}
export const externalId = (u: string) => {
  const x = ids(u);
  return x ? `${x.shopId}.${x.itemId}` : null;
};

// Preços na API interna da Shopee vêm multiplicados por 100000
const shopeeCents = (v: unknown): number | null => (typeof v === 'number' && v > 0 ? Math.round(v / 1000) : null);

/** Interpreta a resposta da API interna da página de produto (pdp). Exportado para testes. */
export function parseApi(json: unknown) {
  const root: Obj = isRecord(json) ? json : {};
  const data: Obj = isRecord(root.data) ? root.data : {};
  const item: Obj = isRecord(data.item) ? data.item : data;
  if (item.price === undefined && item.price_min === undefined) return null;
  const priceCents = shopeeCents(item.price) ?? shopeeCents(item.price_min);
  const before = shopeeCents(item.price_before_discount) ?? shopeeCents(item.price_min_before_discount);
  const meta: Obj = isRecord(data.product_meta) ? data.product_meta : {};
  const stock = item.stock ?? item.normal_stock ?? meta.stock;
  const shop: Obj = isRecord(data.shop_detailed) ? data.shop_detailed : {};
  return {
    title: asString(item.title) ?? asString(item.name),
    priceCents,
    pixCents: null as number | null,
    listCents: before && before > (priceCents ?? 0) ? before : null,
    inStock: stock === undefined ? true : Number(stock) > 0,
    seller: asString(shop.name),
    pageCoupons: [] as CouponInput[],
  };
}

export async function scrape(url: string) {
  // A Shopee monta a página via API interna assinada; capturamos a resposta dela no navegador.
  let apiData = null as ReturnType<typeof parseApi>;
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
      pixCents: null as number | null,
      listCents: null,
      inStock: ld.inStock ?? true,
      seller: ld.seller,
      pageCoupons: [] as CouponInput[],
      externalId: externalId(url),
    };
  }
  const loginWall = /buyer\/login|Fa[cç]a login/i.test(r.url + cleanText($('title').text()));
  throw new BlockedError(id, loginWall ? 'a Shopee exigiu login' : `HTTP ${r.status}`);
}
