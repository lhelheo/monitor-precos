import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCoupons, parseAnnouncedPrice } from '../src/coupons/parser.js';
import { effectivePrice, couponBlocker } from '../src/pricing.js';
import { toCents } from '../src/stores/common.js';
import { parse as parseKabum } from '../src/stores/kabum.js';
import { parse as parseAmazon } from '../src/stores/amazon.js';
import { parseApi as parseShopee } from '../src/stores/shopee.js';
import { normalizeUrl, storeFor } from '../src/stores/index.js';
import { matchesKeywords } from '../src/coupons/ingest.js';
import { alertReasons } from '../src/alerts.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (n) => fs.readFileSync(path.join(here, 'fixtures', n), 'utf8');

test('toCents aceita formato brasileiro', () => {
  assert.equal(toCents('R$ 1.234,56'), 123456);
  assert.equal(toCents('499,90'), 49990);
  assert.equal(toCents('1.299'), 129900);
  assert.equal(toCents(19.9), 1990);
  assert.equal(toCents(''), null);
});

test('parser de cupom em texto: percentual com condição', () => {
  const [c] = parseCoupons('🔥 CUPOM GAMER15 – 15% OFF em games acima de R$200, só no app, até 23:59');
  assert.equal(c.code, 'GAMER15');
  assert.equal(c.kind, 'pct');
  assert.equal(c.value, 15);
  assert.equal(c.minCents, 20000);
  assert.equal(c.conditions.appOnly, true);
});

test('parser de cupom em valor fixo com primeira compra', () => {
  const [c] = parseCoupons('R$20 off na primeira compra no app. Insira o código APPCOMPRA na finalização');
  assert.equal(c.code, 'APPCOMPRA');
  assert.equal(c.kind, 'fixed');
  assert.equal(c.value, 20);
  assert.equal(c.conditions.firstPurchase, true);
});

test('parser ignora palavras comuns em maiúsculas', () => {
  assert.deepEqual(parseCoupons('OFERTA PIX FRETE GRÁTIS hoje'), []);
});

test('preço anunciado: pega o menor valor, ignora "de:"', () => {
  assert.equal(parseAnnouncedPrice('De R$ 499,90 por R$ 349,90 no Pix'), 34990);
});

test('preço efetivo: escolhe o melhor cupom e respeita valor mínimo', () => {
  const scraped = { store: 'kabum', title: 'Controle DualSense', priceCents: 49900, pixCents: 46407, inStock: true };
  const coupons = [
    { code: 'A', kind: 'pct', value: 10, confidence: 'confirmed', conditions: {} },
    { code: 'B', kind: 'fixed', value: 100, confidence: 'probable', conditions: {}, minCents: 60000 },
    { code: 'C', kind: 'fixed', value: 50, confidence: 'probable', conditions: {} },
  ];
  const r = effectivePrice(scraped, coupons, { rules: { pixExtraPct: 0, cashbackPct: 0 } });
  // base = Pix 464,07; cupom A 10% = 46,41; C = 50 => C vence
  assert.equal(r.breakdown.coupon.code, 'C');
  assert.equal(r.effectiveCents, 46407 - 5000);
  assert.ok(r.breakdown.hints.some((h) => h.code === 'B' && h.blocker === 'abaixo do valor mínimo'));
});

test('preço efetivo: cupom "só primeira compra" é bloqueado por padrão', () => {
  const blocker = couponBlocker({ kind: 'fixed', value: 20, conditions: { firstPurchase: true } }, { priceCents: 40000, title: 'x', user: { firstPurchase: false } });
  assert.equal(blocker, 'só primeira compra');
});

test('cupom de confiança baixa não entra no preço efetivo quando minConfidence=confirmed', () => {
  const r = effectivePrice({ store: 'magalu', priceCents: 10000, title: 'x' }, [{ code: 'Z', kind: 'pct', value: 50, confidence: 'unverified', conditions: {} }], {
    minConfidence: 'confirmed',
    rules: {},
  });
  assert.equal(r.effectiveCents, 10000);
  assert.equal(r.breakdown.coupon, null);
});

test('cashback só entra quando countCashback=true', () => {
  const s = { store: 'x', priceCents: 10000, title: 'x' };
  assert.equal(effectivePrice(s, [], { rules: { cashbackPct: 10, countCashback: false } }).effectiveCents, 10000);
  assert.equal(effectivePrice(s, [], { rules: { cashbackPct: 10, countCashback: true } }).effectiveCents, 9000);
});

test('palavras-chave com negação', () => {
  assert.equal(matchesKeywords('Controle DualSense Midnight Black', 'dualsense -edge'), true);
  assert.equal(matchesKeywords('Controle DualSense Edge', 'dualsense -edge'), false);
  assert.equal(matchesKeywords('Controle DualSense Edge', ''), false);
  assert.equal(matchesKeywords('Controle Midnight Black', '"midnight black" controle'), true);
});

test('alertas: alvo, mínima histórica e mediana', () => {
  const now = Date.now();
  const product = { target_cents: 35000 };
  const old = now - 10 * 86400_000;
  const stats = { min: 40000, median: 45000, count: 10, firstTs: old };
  const win = { min: 40000, median: 45000, count: 10, firstTs: old };
  const reasons = alertReasons({ product, effectiveCents: 34000, inStock: true, statsAll: stats, statsWindow: win, now });
  assert.ok(reasons.includes('alvo'));
  assert.ok(reasons.includes('minima_historica'));
  assert.ok(reasons.includes('abaixo_mediana'));
  assert.deepEqual(alertReasons({ product: {}, effectiveCents: 50000, inStock: true, statsAll: stats, statsWindow: win, now }), []);
  assert.deepEqual(alertReasons({ product, effectiveCents: 30000, inStock: false, statsAll: stats, statsWindow: win, now }), []);
});

test('KaBuM: lê preço, Pix e cupom do selo da página (fixture real)', () => {
  const d = parseKabum(fixture('kabum.html'));
  assert.equal(d.priceCents, 49900);
  assert.equal(d.pixCents, 46407);
  assert.equal(d.inStock, true);
  assert.equal(d.seller, 'KaBuM!');
  assert.equal(d.pageCoupons[0].code, 'CONTROLE10');
  assert.equal(d.pageCoupons[0].kind, 'pct');
  assert.equal(d.pageCoupons[0].confidence, 'confirmed');
});

test('Amazon: lê preço e De: e cupons de primeira compra no app (fixture real)', () => {
  const d = parseAmazon(fixture('amazon.html'));
  assert.equal(d.priceCents, 40740);
  assert.equal(d.listCents, 49990);
  assert.equal(d.inStock, true);
  const codes = d.pageCoupons.map((c) => c.code);
  assert.ok(codes.includes('APPCOMPRA'));
  assert.ok(codes.includes('APPDEZ'));
  const app = d.pageCoupons.find((c) => c.code === 'APPCOMPRA');
  assert.equal(app.value, 20);
  assert.equal(app.conditions.firstPurchase, true);
});

test('Amazon: detecta página de captcha', () => {
  assert.deepEqual(parseAmazon('<html>Digite os caracteres api-services-support@amazon.com</html>'), { blocked: true });
});

test('Shopee: converte resposta da API interna (preço × 100000)', () => {
  const r = parseShopee({ data: { item: { price: 12990000, price_before_discount: 15990000, stock: 3, title: 'Controle' } } });
  assert.equal(r.priceCents, 12990);
  assert.equal(r.listCents, 15990);
  assert.equal(r.inStock, true);
});

test('URLs: normalização e identificação de loja', () => {
  assert.equal(storeFor('https://www.amazon.com.br/Controle/dp/B0FY6Y9WZT/ref=sr_1_1?utm=x')?.id, 'amazon');
  assert.equal(normalizeUrl('https://www.amazon.com.br/Controle/dp/B0FY6Y9WZT/ref=sr_1_1?utm=x'), 'https://www.amazon.com.br/dp/B0FY6Y9WZT');
  assert.equal(storeFor('https://www.kabum.com.br/produto/1032835/x')?.id, 'kabum');
  assert.equal(storeFor('https://exemplo.com/produto')?.id, undefined);
});

import { slugText, storeIdFromName, parseOffer } from '../src/discovery/promobit.js';

test('Promobit: texto legível do endereço da oferta', () => {
  assert.equal(slugText('https://www.promobit.com.br/oferta/controle-sem-fio-playstation-5-dualsense-branco-3200281/'), 'controle sem fio playstation 5 dualsense branco');
});

test('Promobit: nome de loja vira id interno', () => {
  assert.equal(storeIdFromName('KaBuM!'), 'kabum');
  assert.equal(storeIdFromName('Magazine Luiza'), 'magalu');
  assert.equal(storeIdFromName('Mercado Livre'), 'mercadolivre');
  assert.equal(storeIdFromName('Loja Desconhecida'), 'any');
});

test('Promobit: lê a oferta certa a partir dos dados embutidos', () => {
  const data = { props: { pageProps: { outras: [{ offerId: 1, offerTitle: 'Outra', offerPrice: 10 }], oferta: { offerId: 3200281, offerTitle: 'Controle Branco', offerPrice: 322.05, offerOldPrice: 547.89, storeName: 'Shopee', offerStatusName: 'APPROVED', offerCoupon: null, offerPublished: '2026-11-11T12:11:15-0300' } } } };
  const html = `<html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(data)}</script></html>`;
  const o = parseOffer(html, 3200281);
  assert.equal(o.title, 'Controle Branco');
  assert.equal(o.priceCents, 32205);
  assert.equal(o.oldCents, 54789);
  assert.equal(o.store, 'Shopee');
  assert.equal(parseOffer(html, 999), null);
});

test('acessórios do console são excluídos pelas palavras-chave', () => {
  const K = 'console playstation 5 -digital -pro -bundle -carregamento -capa -suporte -tampa -tampas -hd -externo -drive -compativel';
  assert.equal(matchesKeywords('Tampa para Console PlayStation 5 Slim, Techno Red', K), false);
  assert.equal(matchesKeywords('Hd Externo Portatil 1TB Compativel Console Playstation 5 Ps5', K), false);
  assert.equal(matchesKeywords('Leitor Drive De Disco Console Ps5 Playstation 5 Slim', K), false);
  assert.equal(matchesKeywords('Console Sony PlayStation 5 Slim, Leitor de Discos, SSD 1TB', K), true);
});
