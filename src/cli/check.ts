// Verifica todos os anúncios agora, sem bot nem agendador: `npm run check [-- <url>]`
import { openDb, closeDb, listings, products } from '../db.ts';
import { checkListing } from '../checker.ts';
import type { ListingRow } from '../types.ts';
import { normalizeUrl, storeFor } from '../stores/index.ts';
import { closeBrowser } from '../http.ts';
import { log } from '../log.ts';
import { fmt } from '../stores/common.ts';

openDb();
const arg = process.argv[2];
const targets = arg ? [{ url: normalizeUrl(arg), store: storeFor(arg)?.id, id: 0, product_id: 0 }] : listings.all();
for (const l of targets) {
  if (!arg && !products.get(l.product_id)?.active) continue;
    const r = await checkListing(l.id ? (l as ListingRow) : ({ ...l, product_id: 0 } as unknown as ListingRow), { silent: true }).catch((e) => ({ ok: false, error: (e as Error).message, eff: undefined, scraped: undefined }));
  if (r.ok) console.log(`#${l.id || '-'} ${l.store}: ${fmt(r.eff?.effectiveCents ?? null)} (preço ${fmt(r.scraped?.priceCents ?? null)})`);
  else console.log(`#${l.id || '-'} ${l.store}: ERRO ${r.error}`);
}
await closeBrowser();
closeDb();
