import { fetchHtml, renderHtml } from '../http.js';
import { parseCoupons } from '../coupons/parser.ts';
import { BlockedError, findDeep, loadHtml, nextData, productFromJsonLd, toCents } from './common.ts';

export const id = 'kabum';
export const name = 'KaBuM!';
export const match = (u) => /(^|\.)kabum\.com\.br$/i.test(new URL(u).hostname);
export const externalId = (u) => new URL(u).pathname.match(/\/produto\/(\d+)/)?.[1] ?? null;

/** Extrai os dados da página de produto da KaBuM! (Next.js). Exportado para testes. */
export function parse(html) {
  const $ = loadHtml(html);
  const nd = nextData($);
  const product = nd ? findDeep(nd.props?.pageProps, (o) => o.prices && 'priceWithDiscount' in o.prices) : null;
  const ld = productFromJsonLd($);

  if (!product && !ld?.priceCents) return null;

  const priceCents = toCents(product?.prices?.price) ?? ld?.priceCents ?? null; // cartão / parcelado
  const pixCents = toCents(product?.prices?.priceWithDiscount) || null; // à vista no Pix
  const oldCents = toCents(product?.prices?.oldPrice) || null;

  const stampText = [product?.stamps?.title, product?.stamps?.description].filter(Boolean).join(' — ');
  const pageCoupons = parseCoupons(stampText, { store: id }).map((c) => ({
    ...c,
    // selo da própria página do item ("neste item") => confirmado
    confidence: c.kind ? 'confirmed' : 'probable',
  }));

  return {
    title: product?.name ?? ld?.title ?? null,
    priceCents,
    pixCents: pixCents && pixCents < priceCents ? pixCents : null,
    listCents: oldCents && oldCents > priceCents ? oldCents : null,
    inStock: product ? Boolean(product.available ?? product.flags?.isAvailable) : ld?.inStock ?? null,
    seller: product?.sellerName ?? product?.marketplace?.sellerName ?? ld?.seller ?? 'KaBuM!',
    pageCoupons,
  };
}

export async function scrape(url) {
  let r = await fetchHtml(url);
  let data = r.status === 200 ? parse(r.html) : null;
  if (!data) {
    r = await renderHtml(url);
    data = parse(r.html);
  }
  if (!data) throw new BlockedError(id, `HTTP ${r.status}, sem dados de preço`);
  return { ...data, externalId: externalId(url) };
}
