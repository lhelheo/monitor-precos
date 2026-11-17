import { fetchHtml } from '../http.ts';
import type { CouponInput } from '../types.ts';
import { asString, BlockedError, findDeep, isRecord, loadHtml, nextData, type Obj } from './common.ts';

/**
 * Zoom: comparador de preços. Não vende nada; mostra o menor preço encontrado e a loja que vende por ele.
 * Os anúncios do Zoom são sempre marcados como "via comparador" nos alertas, porque o preço pode estar
 * um pouco atrasado em relação à loja.
 */
export const id = 'zoom';
export const name = 'Zoom (comparador)';
export const match = (u: string) => /(^|\.)zoom\.com\.br$/i.test(new URL(u).hostname);
export const externalId = (u: string) => new URL(u).pathname.split('/').filter(Boolean).pop() ?? null;

const cents = (v: unknown): number | null => (typeof v === 'number' && v > 0 ? Math.round(v * 100) : null);

/** Dados do produto a partir da página do Zoom (JSON embutido). Exportado para testes. */
export function parse(html: string, slug: string | null = null) {
  const nd = nextData(loadHtml(html));
  const p = nd
    ? findDeep(nd.props, (o) => isRecord(o.bestOffer) && typeof o.price === 'number' && Boolean(o.name) && (!slug || o.seoUrl === slug))
    : undefined;
  if (!p) return null;
  const bestOffer: Obj = isRecord(p.bestOffer) ? p.bestOffer : {};
  return {
    title: asString(p.name),
    priceCents: cents(p.price),
    pixCents: null as number | null,
    listCents: null as number | null,
    inStock: true,
    seller: asString(bestOffer.merchantName),
    pageCoupons: [] as CouponInput[],
  };
}

export type ZoomSearchItem = { url: string; title: string; priceCents: number | null; seller: string | null };

/** Resultados de busca do Zoom. Exportado para descoberta automática. */
export function parseSearch(html: string): ZoomSearchItem[] {
  const nd = nextData(loadHtml(html));
  const seen = new Set<string>();
  const out: ZoomSearchItem[] = [];
  const walk = (o: unknown, d = 0): void => {
    if (!o || typeof o !== 'object' || d > 14) return;
    const rec = o as Obj;
    if (rec.name && rec.seoUrl && rec.categorySeoUrl && typeof rec.price === 'number' && rec.bestOffer) {
      const url = `https://www.zoom.com.br/${String(rec.categorySeoUrl)}/${String(rec.seoUrl)}`;
      if (!seen.has(url)) {
        seen.add(url);
        const offer: Obj = isRecord(rec.bestOffer) ? rec.bestOffer : {};
        out.push({ url, title: String(rec.name), priceCents: cents(rec.price), seller: asString(offer.merchantName) });
      }
    }
    for (const v of Object.values(rec)) walk(v, d + 1);
  };
  walk(nd?.props);
  return out;
}

export async function searchZoom(term: string): Promise<ZoomSearchItem[]> {
  const r = await fetchHtml(`https://www.zoom.com.br/search?q=${encodeURIComponent(term)}`);
  if (r.status !== 200) throw new BlockedError(id, `busca HTTP ${r.status}`);
  return parseSearch(r.html);
}

export async function scrape(url: string) {
  const r = await fetchHtml(url);
  if (r.status !== 200) throw new BlockedError(id, `HTTP ${r.status}`);
  const data = parse(r.html, externalId(url));
  if (!data?.priceCents) throw new BlockedError(id, 'sem preço na página do comparador');
  return { ...data, externalId: externalId(url) };
}
