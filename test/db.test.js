import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, closeDb, products, listings, prices, coupons, seen, kv } from '../src/db.ts';

beforeEach(() => {
  closeDb();
  openDb(':memory:');
});
after(() => closeDb());

test('produtos: criar, ler, definir faixa e palavras-chave', () => {
  const id = products.create({ name: 'Controle DualSense', targetCents: 35000 });
  assert.equal(products.get(id).name, 'Controle DualSense');
  products.setKeywords(id, 'dualsense -edge');
  products.setRange(id, 20000, 40000);
  const p = products.get(id);
  assert.equal(p.keywords, 'dualsense -edge');
  assert.equal(p.price_min_cents, 20000);
  assert.equal(p.price_max_cents, 40000);
});

test('anúncios: criar, achar pela URL e listar por produto', () => {
  const pid = products.create({ name: 'x' });
  const lid = listings.create({ productId: pid, store: 'kabum', url: 'https://www.kabum.com.br/produto/1' });
  assert.equal(listings.byUrl('https://www.kabum.com.br/produto/1').id, lid);
  assert.equal(listings.byProduct(pid).length, 1);
  listings.setInterval(lid, 30);
  assert.equal(listings.get(lid).interval_min, 30);
});

test('histórico: estatísticas usam só leituras com estoque', () => {
  const pid = products.create({ name: 'x' });
  const lid = listings.create({ productId: pid, store: 'amazon', url: 'https://www.amazon.com.br/dp/B0FY6Y9WZT' });
  prices.insert({ listingId: lid, priceCents: 50000, effectiveCents: 50000, inStock: true });
  prices.insert({ listingId: lid, priceCents: 40000, effectiveCents: 40000, inStock: true });
  prices.insert({ listingId: lid, priceCents: 10000, effectiveCents: 10000, inStock: false });
  const s = prices.statsForProduct(pid, 0);
  assert.equal(s.count, 2);
  assert.equal(s.min, 40000);
  assert.equal(s.max, 50000);
});

test('cupons: upsert não duplica e o cupom aparece para a loja', () => {
  const c = { store: 'kabum', code: 'CONTROLE10', kind: 'pct', value: 10, source: 'page', confidence: 'confirmed' };
  coupons.upsert(c);
  coupons.upsert(c);
  const ativos = coupons.activeFor('kabum', 999);
  assert.equal(ativos.length, 1);
  assert.equal(ativos[0].code, 'CONTROLE10');
});

test('cupons: upsert atualiza as condições de um cupom já salvo', () => {
  const c = { store: 'amazon', code: 'TELAS15', kind: 'pct', value: 15, source: 'page', confidence: 'confirmed', conditions: {} };
  coupons.upsert(c);
  coupons.upsert({ ...c, conditions: { primeOnly: true } });
  assert.equal(coupons.activeFor('amazon', 999)[0].conditions.primeOnly, true);
});

test('itens já vistos: só a primeira marcação é nova', () => {
  assert.equal(seen.has('pelando', 'abc'), false);
  assert.equal(seen.markNew('pelando', 'abc'), true);
  assert.equal(seen.markNew('pelando', 'abc'), false);
  assert.equal(seen.has('pelando', 'abc'), true);
});

test('chave-valor: grava e atualiza', () => {
  kv.set('flag', '1');
  kv.set('flag', '2');
  assert.equal(kv.get('flag'), '2');
});
