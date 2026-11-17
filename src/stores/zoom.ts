import { fetchHtml } from '../http.ts';
import { BlockedError, findDeep, loadHtml, nextData } from './common.ts';

/**
 * Zoom: comparador de preços. Não vende nada; mostra o menor preço encontrado e a loja que vende por ele.
 * Os anúncios do Zoom são sempre marcados como "via comparador" nos alertas, porque o preço pode estar
 * um pouco atrasado em relação à loja.
 */
export const id = 'zoom';
export const name = 'Zoom (comparador)';
export const match = (u: any) => /(^|\.)zoom\.com\.br$/i.test(new URL(u).hostname);
export const externalId = (u: any) => new URL(u).pathname.split('/').filter(Boolean).pop() ?? null;

const cents = (v: any) => (typeof v === 'number' && v > 0 ? Math.round(v * 100) : null);

/** Dados do produto a partir da página do Zoom (JSON embutido). Exportado para testes. */
export function parse(html: any, slug: any = null) {
  const nd = nextData(loadHtml(html));
  const p = nd ? findDeep(nd.props, (o: any) => o.bestOffer && typeof o.price === 'number' && o.name && (!slug || o.seoUrl === slug)) : null;
  if (!p) return null;
  return {
    title: p.name,
    priceCents: cents(p.price),
    pixCents: null as number | null,
    listCents: null as number | null,
    inStock: true,
    seller: p.bestOffer?.merchantName ?? null,
    pageCoupons: [] as any[],
  };
}

/** Resultados de busca do Zoom. Exportado para descoberta automática. */
export function parseSearch(html: any) {
  const nd = nextData(loadHtml(html));
  const seen = new Set();
  const out: any[] = [];
  const walk = (o: any, d = 0) => {
    if (!o || typeof o !== 'object' || d > 14) return;
    if (o.name && o.seoUrl && o.categorySeoUrl && typeof o.price === 'number' && o.bestOffer) {
      const url = `https://www.zoom.com.br/${o.categorySeoUrl}/${o.seoUrl}`;
      if (!seen.has(url)) {
        seen.add(url);
        out.push({
          url,
          title: o.name,
          priceCents: cents(o.price),
          seller: o.bestOffer.merchantName ?? null,
        });
      }
    }
    for (const v of Object.values(o)) walk(v, d + 1);
  };
  walk(nd?.props);
  return out;
}

export async function searchZoom(term: any) {
  const r = await fetchHtml(`https://www.zoom.com.br/search?q=${encodeURIComponent(term)}`);
  if (r.status !== 200) throw new BlockedError(id, `busca HTTP ${r.status}`);
  return parseSearch(r.html);
}

export async function scrape(url: any) {
  const r = await fetchHtml(url);
  if (r.status !== 200) throw new BlockedError(id, `HTTP ${r.status}`);
  const data = parse(r.html, externalId(url));
  if (!data?.priceCents) throw new BlockedError(id, 'sem preço na página do comparador');
  return { ...data, externalId: externalId(url) };
}
