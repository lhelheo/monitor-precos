import * as kabum from './kabum.js';
import * as amazon from './amazon.js';
import * as mercadolivre from './mercadolivre.js';
import * as magalu from './magalu.js';
import * as shopee from './shopee.js';
import * as zoom from './zoom.js';
import { config } from '../config.js';

const ALL_STORES = { kabum, amazon, mercadolivre, magalu, shopee, zoom };
// Só lojas habilitadas em config.enabledStores são aceitas (inclusive no bot)
export const STORES = Object.fromEntries(Object.entries(ALL_STORES).filter(([id]) => config.enabledStores.includes(id)));

export function storeFor(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(u.protocol)) return null;
  return Object.values(STORES).find((s) => s.match(u.href)) ?? null;
}

/** Remove parâmetros de rastreamento para a URL ficar estável (evita duplicar anúncios). */
export function normalizeUrl(url) {
  const store = storeFor(url);
  if (!store) return url;
  if (store.canonical) return store.canonical(url);
  const u = new URL(url);
  u.hash = '';
  const keep = store.id === 'mercadolivre' ? ['wid', 'item_id', 'pdp_filters'] : [];
  for (const k of [...u.searchParams.keys()]) if (!keep.includes(k)) u.searchParams.delete(k);
  return u.toString();
}

/**
 * Coleta dados de um anúncio. Resultado normalizado:
 * { title, priceCents, pixCents, listCents, inStock, seller, pageCoupons[], externalId }
 */
export async function scrape(url) {
  const store = storeFor(url);
  if (!store) throw new Error(`Loja não suportada: ${url}`);
  const data = await store.scrape(url);
  return { store: store.id, ...data };
}
