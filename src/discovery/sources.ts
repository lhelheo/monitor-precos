import { fetchHtml } from '../http.ts';
import { BlockedError, loadHtml, nextData, toCents, type Obj } from '../stores/common.ts';
import { searchZoom } from '../stores/zoom.ts';
import type { DealOffer, SearchItem } from '../types.ts';

/** Busca na Kabum (página de busca, JSON embutido). Devolve anúncios com preço, sem filtro. */
export async function searchKabum(term: string): Promise<SearchItem[]> {
  const slug = encodeURIComponent(term.trim().replace(/\s+/g, '-'));
  const r = await fetchHtml(`https://www.kabum.com.br/busca/${slug}`);
  if (r.status !== 200) throw new BlockedError('kabum', `busca HTTP ${r.status}`);
  const nd = nextData(loadHtml(r.html));
  const out: SearchItem[] = [];
  const seen = new Set<unknown>();
  const walk = (o: unknown, d = 0): void => {
    if (!o || typeof o !== 'object' || d > 14) return;
    const rec = o as Obj;
    if ((typeof rec.code === 'number' || typeof rec.code === 'string') && rec.name && rec.price !== undefined && rec.priceWithDiscount !== undefined) {
      if (!seen.has(rec.code)) {
        seen.add(rec.code);
        out.push({
          externalId: String(rec.code),
          url: `https://www.kabum.com.br/produto/${String(rec.code)}`,
          title: String(rec.name),
          priceCents: toCents(rec.price),
          pixCents: toCents(rec.priceWithDiscount),
          inStock: rec.available !== false,
        });
      }
    }
    for (const v of Object.values(rec)) walk(v, d + 1);
  };
  walk(nd?.props?.pageProps);
  return out;
}

/**
 * Ofertas da comunidade (Pelando). A página de busca traz os dados das ofertas embutidos,
 * com título, preço, loja e temperatura. Devolve [{ externalId, title, priceCents, store, temperature, url }].
 */
export async function searchPelando(term: string): Promise<DealOffer[]> {
  const slug = encodeURIComponent(term.trim().replace(/\s+/g, '-'));
  const r = await fetchHtml(`https://www.pelando.com.br/busca/${slug}`);
  if (r.status !== 200) throw new BlockedError('pelando', `busca HTTP ${r.status}`);
  const text = r.html.replace(/&quot;/g, '"').replace(/&amp;/g, '&');
  const out: DealOffer[] = [];
  const seen = new Set<string>();
  for (const chunk of text.split('"slug":[0,"').slice(1)) {
    const dealSlug = chunk.slice(0, chunk.indexOf('"'));
    if (!dealSlug || seen.has(dealSlug)) continue;
    const title = chunk.match(/"title":(?:\[0,)?"([^"]*)"/)?.[1];
    const price = chunk.match(/"price":(?:\[0,)?([\d.]+)/)?.[1];
    const temp = chunk.match(/"temperature":(?:\[0,)?(-?\d+)/)?.[1];
    // ofertas encerradas aparecem na busca com status "expired": não podem virar aviso
    const status = chunk.match(/"status":(?:\[0,)?"([^"]*)"/)?.[1] ?? null;
    const createdAt = chunk.match(/"createdAt":(?:\[0,)?"([^"]*)"/)?.[1] ?? null;
    if (status && status !== 'active') continue;
    const storeAt = chunk.indexOf('"store":');
    const store = storeAt >= 0 ? chunk.slice(storeAt).match(/"name":(?:\[0,)?"([^"]*)"/)?.[1] : null;
    if (!title || !price) continue;
    seen.add(dealSlug);
    out.push({
      externalId: dealSlug,
      title,
      priceCents: Math.round(Number(price) * 100),
      store: store ?? null,
      temperature: temp ? Number(temp) : null,
      createdAt,
      url: `https://www.pelando.com.br/d/${dealSlug}`,
    });
  }
  return out;
}

export { searchZoom };
