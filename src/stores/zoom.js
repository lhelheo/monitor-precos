import { fetchHtml } from '../http.js';
import { BlockedError, findDeep, loadHtml, nextData } from './common.ts';

/**
 * Zoom: comparador de preços. Não vende nada; mostra o menor preço encontrado e a loja que vende por ele.
 * Os anúncios do Zoom são sempre marcados como "via comparador" nos alertas, porque o preço pode estar
 * um pouco atrasado em relação à loja.
 */
export const id = 'zoom';
export const name = 'Zoom (comparador)';
export const match = (u) => /(^|\.)zoom\.com\.br$/i.test(new URL(u).hostname);
export const externalId = (u) => new URL(u).pathname.split('/').filter(Boolean).pop() ?? null;

const cents = (v) => (typeof v === 'number' && v > 0 ? Math.round(v * 100) : null);

/** Dados do produto a partir da página do Zoom (JSON embutido). Exportado para testes. */
export function parse(html, slug = null) {
  const nd = nextData(loadHtml(html));
  const p = nd ? findDeep(nd.props, (o) => o.bestOffer && typeof o.price === 'number' && o.name && (!slug || o.seoUrl === slug)) : null;
  if (!p) return null;
  return {
    title: p.name,
    priceCents: cents(p.price),
    pixCents: null,
    listCents: null,
    inStock: true,
    seller: p.bestOffer?.merchantName ?? null,
    pageCoupons: [],
  };
}

/** Resultados de busca do Zoom. Exportado para descoberta automática. */
export function parseSearch(html) {
  const nd = nextData(loadHtml(html));
  const seen = new Set();
  const out = [];
  const walk = (o, d = 0) => {
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

export async function searchZoom(term) {
  const r = await fetchHtml(`https://www.zoom.com.br/search?q=${encodeURIComponent(term)}`);
  if (r.status !== 200) throw new BlockedError(id, `busca HTTP ${r.status}`);
  return parseSearch(r.html);
}

export async function scrape(url) {
  const r = await fetchHtml(url);
  if (r.status !== 200) throw new BlockedError(id, `HTTP ${r.status}`);
  const data = parse(r.html, externalId(url));
  if (!data?.priceCents) throw new BlockedError(id, 'sem preço na página do comparador');
  return { ...data, externalId: externalId(url) };
}
