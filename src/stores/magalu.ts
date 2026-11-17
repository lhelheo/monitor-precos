import { fetchHtml, renderHtml } from '../http.ts';
import { parseCoupons } from '../coupons/parser.ts';
import { BlockedError, cleanText, findDeep, loadHtml, metaPrice, nextData, productFromJsonLd, toCents } from './common.ts';

export const id = 'magalu';
export const name = 'Magalu';
export const match = (u: any) => /(^|\.)(magazineluiza|magalu)\.com(\.br)?$/i.test(new URL(u).hostname);
export const externalId = (u: any) => new URL(u).pathname.match(/\/p\/([a-z0-9]+)/i)?.[1] ?? null;

const isBlockedPage = (html: any) => /N[aã]o [eé] poss[ií]vel acessar a p[aá]gina|akamai-bot|Access Denied/i.test(html.slice(0, 4000));

export function parse(html: any) {
  if (isBlockedPage(html)) return { blocked: true };
  const $ = loadHtml(html);
  const ld = productFromJsonLd($);
  const nd = nextData($);
  // Estrutura do Next.js da Magalu varia; procuramos um objeto de preço com "bestPrice"/"price"
  const priceObj = nd
    ? findDeep(nd.props?.pageProps, (o: any) => o && typeof o === 'object' && ('bestPrice' in o || 'paymentMethodDescription' in o) && 'price' in o)
    : null;

  const priceCents = toCents(priceObj?.price) ?? ld?.priceCents ?? metaPrice($);
  if (!priceCents) return null;
  const best = toCents(priceObj?.bestPrice);
  const list = toCents(priceObj?.fullPrice);
  const promoText = cleanText($('[data-testid*="coupon"], [data-testid*="promotion"], [class*="coupon"]').text());

  return {
    title: ld?.title || cleanText($('h1').first().text()) || null,
    priceCents,
    pixCents: best && best < priceCents ? best : null,
    listCents: list && list > priceCents ? list : null,
    inStock: ld?.inStock ?? true,
    seller: ld?.seller || null,
    pageCoupons: parseCoupons(promoText, { store: id }).map((c) => ({ ...c, confidence: c.kind ? 'confirmed' : 'probable' })),
  };
}

export async function scrape(url: any) {
  let r = await fetchHtml(url);
  let data = r.status === 200 ? parse(r.html) : null;
  if (!data || data.blocked) {
    r = await renderHtml(url, { waitMs: 4000 });
    data = parse(r.html);
  }
  if (!data || data.blocked) throw new BlockedError(id, `HTTP ${r.status}`);
  return { ...data, externalId: externalId(url) };
}
