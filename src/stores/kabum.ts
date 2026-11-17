import { fetchHtml, renderHtml } from '../http.ts';
import { parseCoupons } from '../coupons/parser.ts';
import type { CouponInput } from '../types.ts';
import { asString, BlockedError, findDeep, isRecord, loadHtml, nextData, productFromJsonLd, toCents, type Obj } from './common.ts';

export const id = 'kabum';
export const name = 'KaBuM!';
export const match = (u: string) => /(^|\.)kabum\.com\.br$/i.test(new URL(u).hostname);
export const externalId = (u: string) => new URL(u).pathname.match(/\/produto\/(\d+)/)?.[1] ?? null;

/** Sub-objeto opcional: devolve o objeto se for registro, senão um vazio (acesso seguro). */
const sub = (v: unknown): Obj => (isRecord(v) ? v : {});

/** Extrai os dados da página de produto da KaBuM! (Next.js). Exportado para testes. */
export function parse(html: string) {
  const $ = loadHtml(html);
  const nd = nextData($);
  const product = nd ? findDeep(nd.props?.pageProps, (o) => isRecord(o.prices) && 'priceWithDiscount' in o.prices) : null;
  const ld = productFromJsonLd($);

  if (!product && !ld?.priceCents) return null;

  const prices = sub(product?.prices);
  const stamps = sub(product?.stamps);
  const flags = sub(product?.flags);
  const marketplace = sub(product?.marketplace);

  const priceCents = toCents(prices.price) ?? ld?.priceCents ?? null; // cartão / parcelado
  const pixCents = toCents(prices.priceWithDiscount) || null; // à vista no Pix
  const oldCents = toCents(prices.oldPrice) || null;

  const stampText = [asString(stamps.title), asString(stamps.description)].filter(Boolean).join(' — ');
  const pageCoupons: CouponInput[] = parseCoupons(stampText, { store: id }).map((c) => ({
    ...c,
    // selo da própria página do item ("neste item") => confirmado
    confidence: c.kind ? ('confirmed' as const) : ('probable' as const),
  }));

  return {
    title: asString(product?.name) ?? ld?.title ?? null,
    priceCents,
    pixCents: pixCents && pixCents < (priceCents ?? 0) ? pixCents : null,
    listCents: oldCents && oldCents > (priceCents ?? 0) ? oldCents : null,
    inStock: product ? Boolean(product.available ?? flags.isAvailable) : (ld?.inStock ?? null),
    seller: asString(product?.sellerName) ?? asString(marketplace.sellerName) ?? ld?.seller ?? 'KaBuM!',
    pageCoupons,
  };
}

export async function scrape(url: string) {
  let r = await fetchHtml(url);
  let data = r.status === 200 ? parse(r.html) : null;
  if (!data) {
    r = await renderHtml(url);
    data = parse(r.html);
  }
  if (!data) throw new BlockedError(id, `HTTP ${r.status}, sem dados de preço`);
  return { ...data, externalId: externalId(url) };
}
