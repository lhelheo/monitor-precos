import { fetchHtml } from '../http.ts';
import { BlockedError, loadHtml, nextData, toCents } from '../stores/common.ts';
import { searchZoom } from '../stores/zoom.ts';

/** Busca na Kabum (página de busca, JSON embutido). Devolve anúncios com preço, sem filtro. */
export async function searchKabum(term) {
  const slug = encodeURIComponent(term.trim().replace(/\s+/g, '-'));
  const r = await fetchHtml(`https://www.kabum.com.br/busca/${slug}`);
  if (r.status !== 200) throw new BlockedError('kabum', `busca HTTP ${r.status}`);
  const nd = nextData(loadHtml(r.html));
  const out = [];
  const seen = new Set();
  const walk = (o, d = 0) => {
    if (!o || typeof o !== 'object' || d > 14) return;
    if ((typeof o.code === 'number' || typeof o.code === 'string') && o.name && o.price !== undefined && o.priceWithDiscount !== undefined) {
      if (!seen.has(o.code)) {
        seen.add(o.code);
        out.push({
          externalId: String(o.code),
          url: `https://www.kabum.com.br/produto/${o.code}`,
          title: o.name,
          priceCents: toCents(o.price),
          pixCents: toCents(o.priceWithDiscount),
          inStock: o.available !== false,
        });
      }
    }
    for (const v of Object.values(o)) walk(v, d + 1);
  };
  walk(nd?.props?.pageProps);
  return out;
}

/**
 * Ofertas da comunidade (Pelando). A página de busca traz os dados das ofertas embutidos,
 * com título, preço, loja e temperatura. Devolve [{ externalId, title, priceCents, store, temperature, url }].
 */
export async function searchPelando(term) {
  const slug = encodeURIComponent(term.trim().replace(/\s+/g, '-'));
  const r = await fetchHtml(`https://www.pelando.com.br/busca/${slug}`);
  if (r.status !== 200) throw new BlockedError('pelando', `busca HTTP ${r.status}`);
  const text = r.html.replace(/&quot;/g, '"').replace(/&amp;/g, '&');
  const out = [];
  const seen = new Set();
  for (const chunk of text.split('"slug":[0,"').slice(1)) {
    const slug = chunk.slice(0, chunk.indexOf('"'));
    if (!slug || seen.has(slug)) continue;
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
    seen.add(slug);
    out.push({
      externalId: slug,
      title,
      priceCents: Math.round(Number(price) * 100),
      store: store ?? null,
      temperature: temp ? Number(temp) : null,
      createdAt,
      url: `https://www.pelando.com.br/d/${slug}`,
    });
  }
  return out;
}

export { searchZoom };
