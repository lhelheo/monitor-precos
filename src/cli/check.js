// Verifica todos os anúncios agora, sem bot nem agendador: `npm run check [-- <url>]`
import { openDb, closeDb, listings, products } from '../db.js';
import { checkListing } from '../checker.js';
import { normalizeUrl, storeFor } from '../stores/index.ts';
import { closeBrowser } from '../http.ts';
import { log } from '../log.js';
import { fmt } from '../stores/common.ts';

openDb();
const arg = process.argv[2];
const targets = arg ? [{ url: normalizeUrl(arg), store: storeFor(arg)?.id, id: 0 }] : listings.all();
for (const l of targets) {
  if (!arg && !products.get(l.product_id)?.active) continue;
  /** @type {any} */
  const r = await checkListing(l.id ? l : { ...l, product_id: 0 }, { silent: true }).catch((e) => ({ ok: false, error: e.message }));
  if (r.ok) console.log(`#${l.id || '-'} ${l.store}: ${fmt(r.eff.effectiveCents)} (preço ${fmt(r.scraped.priceCents)})`);
  else console.log(`#${l.id || '-'} ${l.store}: ERRO ${r.error}`);
}
await closeBrowser();
closeDb();
