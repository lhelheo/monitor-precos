// Teste manual (rede real): node test/e2e-smoke.mjs
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openDb, closeDb, products, listings, coupons, prices } from '../src/db.js';
import { scrape } from '../src/stores/index.js';
import { ingestText } from '../src/coupons/ingest.js';
import { effectivePrice } from '../src/pricing.js';
import { closeBrowser } from '../src/http.js';

const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mp-')), 'test.db');
openDb(tmp);

const pid = products.create({ name: 'Controle DualSense', targetCents: 35000 });
products.setKeywords(pid, 'dualsense -edge');

// 1) ingestão de mensagem de canal
const msg = '🔥 Controle DualSense PS5 por R$ 349,90\n🎟️ CUPOM GAMER15 – 15% OFF em controles acima de R$200, só no app, até 23:59';
const r = await ingestText(msg, { source: 'telegram', origin: 'canal_teste' });
console.log('ingest coupons:', r.coupons.map((c) => `${c.code}/${c.kind}/${c.value}/${c.confidence}`));
console.log('matched products:', r.matchedProducts.map((p) => p.name));
// segunda vez não deve duplicar
await ingestText(msg, { source: 'telegram' });
console.log('active coupons total:', coupons.list(true).length);

// 2) coleta ao vivo
for (const url of [
  'https://www.kabum.com.br/produto/1032835/controle-sem-fio-sony-dualsense-playstation-5-bluetooth-midnight-black-cfi-zct2w',
  'https://www.amazon.com.br/dp/B0FY6Y9WZT',
]) {
  try {
    const d = await scrape(url);
    const lid = listings.create({ productId: pid, store: d.store, url, externalId: d.externalId, title: d.title });
    for (const c of d.pageCoupons || []) if (c.kind && c.value) coupons.upsert({ ...c, store: d.store, listingId: lid, source: 'page' });
    const active = coupons.activeFor(d.store, lid);
    const eff = effectivePrice(d, active, { minConfidence: 'probable', user: { firstPurchase: false } });
    console.log(d.store, 'preço', d.priceCents, 'pix', d.pixCents, 'efetivo', eff.effectiveCents, 'cupom', eff.breakdown.coupon?.label ?? '-', 'hints', eff.breakdown.hints.length);
    prices.insert({ listingId: lid, priceCents: d.priceCents, pixCents: d.pixCents, effectiveCents: eff.effectiveCents, effectiveConfidence: eff.confidence, inStock: d.inStock, seller: d.seller, breakdown: eff.breakdown });
  } catch (e) {
    console.log('ERRO', url, e.message);
  }
}
console.log('history points:', prices.historyForProduct(pid).length, 'stats:', prices.statsForProduct(pid, 0));

await closeBrowser();
closeDb();
