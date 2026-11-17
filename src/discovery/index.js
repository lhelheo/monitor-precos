import { config } from '../config.js';
import { kv, listings, products, seen } from '../db.js';
import { matchesKeywords } from '../coupons/ingest.js';
import { formatDeal } from '../format.js';
import { notify } from '../notifier.js';
import { log } from '../log.js';
import { searchKabum, searchPelando, searchZoom } from './sources.js';
import { fmt } from '../stores/common.js';

// limite de anúncios descobertos por loja e por produto
const CAP = { kabum: 20, zoom: 10 };
// anúncios descobertos automaticamente são verificados com menos frequência (muitos anúncios, mesma loja)
const DISCOVERED_INTERVAL_MIN = 30;

/** Primeiro termo positivo das palavras-chave, usado como busca nas lojas ("controle dualsense -edge" -> "controle dualsense"). */
export function searchTerm(keywords) {
  if (!keywords) return null;
  const terms = [...keywords.matchAll(/"([^"]+)"|(\S+)/g)]
    .filter((m) => !(m[2] || '').startsWith('-'))
    .map((m) => m[1] || m[2]);
  return terms.length ? terms.join(' ') : null;
}

const inRange = (p, cents) =>
  cents !== null &&
  cents !== undefined &&
  (!p.price_min_cents || cents >= p.price_min_cents) &&
  (!p.price_max_cents || cents <= p.price_max_cents);

const activeProducts = () => products.list().filter((p) => p.active && p.keywords);

/**
 * Busca automática nas lojas e no comparador: cadastra anúncios novos que batem com as palavras-chave
 * e a faixa de preço do produto. Roda de hora em hora.
 */
export async function runSearchDiscovery() {
  for (const p of activeProducts()) {
    const term = searchTerm(p.keywords);
    if (!term) continue;
    const sources = [
      ['kabum', () => searchKabum(term)],
      ['zoom', () => searchZoom(term).then((items) => items.map((i) => ({ ...i, externalId: i.url.split('/').pop(), inStock: true })))],
    ];
    for (const [store, fetchItems] of sources) {
      if (!config.enabledStores.includes(store)) continue;
      let items;
      try {
        items = await fetchItems();
      } catch (e) {
        log.warn(`Busca ${store} "${term}": ${e.message}`);
        continue;
      }
      let added = 0;
      const current = listings.byProduct(p.id).filter((l) => l.store === store).length;
      for (const it of items) {
        if (current + added >= (CAP[store] ?? 10)) break;
        if (!matchesKeywords(it.title, p.keywords)) continue;
        if (!inRange(p, it.priceCents)) continue;
        if (listings.byUrl(it.url)) continue;
        const lid = listings.create({ productId: p.id, store, url: it.url, externalId: it.externalId, title: it.title });
        listings.setInterval(lid, DISCOVERED_INTERVAL_MIN);
        added++;
      }
      if (added) log.info(`Descoberta ${store} para "${p.name}": ${added} anúncio(s) novo(s)`);
    }
  }
}

/**
 * Ofertas da comunidade (Pelando): avisa na hora quando aparece uma oferta nova que bate com as palavras-chave
 * e a faixa de preço. Na primeira execução só registra o que já existe, para não mandar um monte de avisos antigos.
 */
export async function runPelandoAlerts(send = notify) {
  const first = !kv.get('pelando_bootstrapped');
  const active = activeProducts();
  if (!active.length) return;

  const terms = [...new Set(active.map((p) => searchTerm(p.keywords)).filter(Boolean))];
  const items = [];
  for (const t of terms) items.push(...(await searchPelando(t)));
  for (const deal of items) {
    for (const p of active) {
      if (!matchesKeywords(deal.title, p.keywords) || !inRange(p, deal.priceCents)) continue;
      const isNew = seen.markNew('pelando', deal.externalId);
      if (!isNew || first) continue;
      const html = formatDeal({
        product: p,
        text: `${deal.title}\nLoja: ${deal.store ?? '—'}${deal.temperature != null ? ` · temperatura ${deal.temperature}°` : ''}`,
        deal: { product: deal.title, finalCents: deal.priceCents },
        coupons: [],
        channel: 'Pelando',
        link: deal.url,
      });
      await send(html);
      log.info(`Pelando: ${p.name} ← ${deal.title} por ${fmt(deal.priceCents)}`);
    }
  }
  if (first) kv.set('pelando_bootstrapped', '1');
}
