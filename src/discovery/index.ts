import { config } from '../config.ts';
import { kv, listings, products, seen } from '../db.ts';
import { matchesKeywords } from '../coupons/ingest.ts';
import { formatDeal } from '../format.ts';
import { notify } from '../notifier.ts';
import { log } from '../log.ts';
import { searchKabum, searchPelando, searchZoom } from './sources.ts';
import { fetchOffer, searchPromobit, slugText, storeIdFromName } from './promobit.ts';
import { coupons } from '../db.ts';
import { fmt } from '../stores/common.ts';
import type { ProductRow, SearchItem } from '../types.ts';

// limite de anúncios descobertos por loja e por produto
const CAP: Record<string, number> = { kabum: 20, zoom: 10 };
// anúncios descobertos automaticamente são verificados com menos frequência (muitos anúncios, mesma loja)
const DISCOVERED_INTERVAL_MIN = 30;

/** Primeiro termo positivo das palavras-chave, usado como busca nas lojas ("controle dualsense -edge" -> "controle dualsense"). */
export function searchTerm(keywords: string | null | undefined) {
  return searchTerms(keywords)[0] ?? null;
}

/**
 * Termos de busca. Um grupo de alternativas "(console|slim|digital)" gera uma busca para cada alternativa,
 * porque cada loja/agregador indexa os títulos de um jeito diferente.
 */
export function searchTerms(keywords: string | null | undefined) {
  if (!keywords) return [];
  let variants = [''];
  for (const m of keywords.matchAll(/"([^"]+)"|(\S+)/g)) {
    const raw = m[1] || m[2];
    if ((m[2] || '').startsWith('-')) continue;
    const alts = raw.replace(/^\(|\)$/g, '').split('|');
    variants = variants.flatMap((v) => alts.map((a: string) => (v ? v + ' ' + a : a)));
  }
  return variants.map((v) => v.trim()).filter(Boolean).slice(0, 3);
}

const inRange = (p: ProductRow, cents: number | null | undefined) =>
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
    const sources: Array<[string, () => Promise<SearchItem[]>]> = [
      // a Kabum é sensível à ordem das palavras: se a busca vier vazia, tenta com as palavras invertidas
      ['kabum', async () => {
        const direct = await searchKabum(term);
        if (direct.length) return direct;
        return searchKabum(term.split(' ').reverse().join(' '));
      }],
      ['zoom', () => searchZoom(term).then((items) => items.map((i) => ({ ...i, externalId: i.url.split('/').pop(), inStock: true })))],
    ];
    for (const [store, fetchItems] of sources) {
      if (!config.enabledStores.includes(store)) continue;
      let items;
      try {
        items = await fetchItems();
      } catch (e) {
        log.warn(`Busca ${store} "${term}": ${(e as Error).message}`);
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
  const maxAgeMs = config.promobit.maxAgeHours * 3600_000;
  for (const deal of items) {
    const created = Date.parse(deal.createdAt ?? '');
    if (!Number.isNaN(created) && Date.now() - created > maxAgeMs) continue;
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

/**
 * Promobit: busca por produto no navegador e lê os detalhes de cada oferta nova.
 * Avisa ofertas aprovadas, recentes, que batem com as palavras-chave e a faixa de preço.
 * Na primeira execução só registra o que existe.
 */
export async function runPromobitAlerts(send = notify) {
  if (!config.promobit.enabled) return;
  const active = activeProducts();
  if (!active.length) return;
  const first = !kv.get('promobit_bootstrapped');
  const maxAgeMs = config.promobit.maxAgeHours * 3600_000;
  const terms = [...new Set(active.flatMap((p) => searchTerms(p.keywords)))];

  for (const term of terms) {
    let links;
    try {
      links = await searchPromobit(term);
    } catch (e) {
      log.warn(`Promobit "${term}": ${(e as Error).message}`);
      continue;
    }
    for (const link of links) {
      if (!active.some((p) => matchesKeywords(slugText(link.url), p.keywords))) continue;
      if (seen.has('promobit', link.id)) continue;
      let offer;
      try {
        offer = await fetchOffer(link.url, link.id);
      } catch (e) {
        log.warn(`Promobit oferta ${link.id}: ${(e as Error).message}`);
        continue;
      }
      if (!offer) continue;
      seen.markNew('promobit', link.id);
      if (first) continue;
      if (offer.status && offer.status !== 'APPROVED') continue;
      const published = Date.parse(offer.published ?? '');
      if (!Number.isNaN(published) && Date.now() - published > maxAgeMs) continue;

      for (const p of active) {
        if (!matchesKeywords(offer.title, p.keywords) || !inRange(p, offer.priceCents)) continue;
        if (offer.coupon) {
          // o Promobit não informa o valor do cupom aqui: fica como "sem valor identificado", só para aviso
          coupons.upsert({
            store: storeIdFromName(offer.store),
            code: offer.coupon,
            kind: 'fixed',
            value: 0,
            source: 'promobit',
            confidence: 'unverified',
            rawText: offer.title,
          });
        }
        const html = formatDeal({
          product: p,
          text: `${offer.title}
Loja: ${offer.store ?? '—'}${offer.coupon ? `
Cupom: ${offer.coupon} (valor não informado)` : ''}`,
          deal: { product: offer.title, finalCents: offer.priceCents },
          coupons: [],
          channel: 'Promobit',
          link: link.url,
        });
        await send(html);
        log.info(`Promobit: ${p.name} ← ${offer.title} por ${fmt(offer.priceCents)}`);
      }
    }
  }
  if (first) kv.set('promobit_bootstrapped', '1');
}
