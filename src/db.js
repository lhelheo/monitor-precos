import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

/**
 * Valores monetários são guardados em centavos (inteiros) para evitar erros de ponto flutuante.
 * Datas são epoch em milissegundos.
 */
const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS products (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL,
  target_cents  INTEGER,
  keywords      TEXT,
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS listings (
  id                   INTEGER PRIMARY KEY,
  product_id           INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  store                TEXT NOT NULL,
  url                  TEXT NOT NULL UNIQUE,
  external_id          TEXT,
  title                TEXT,
  active               INTEGER NOT NULL DEFAULT 1,
  interval_min         INTEGER,
  next_check_at        INTEGER NOT NULL DEFAULT 0,
  last_checked_at      INTEGER,
  last_ok_at           INTEGER,
  fail_count           INTEGER NOT NULL DEFAULT 0,
  last_error           TEXT,
  last_price_cents     INTEGER,
  last_effective_cents INTEGER,
  last_in_stock        INTEGER,
  created_at           INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS price_points (
  id                   INTEGER PRIMARY KEY,
  listing_id           INTEGER NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  ts                   INTEGER NOT NULL,
  price_cents          INTEGER,
  pix_cents            INTEGER,
  list_cents           INTEGER,
  effective_cents      INTEGER,
  effective_confidence TEXT,
  in_stock             INTEGER,
  seller               TEXT,
  breakdown_json       TEXT
);
CREATE INDEX IF NOT EXISTS idx_pp_listing_ts ON price_points(listing_id, ts);

CREATE TABLE IF NOT EXISTS coupons (
  id                 INTEGER PRIMARY KEY,
  store              TEXT NOT NULL,
  code               TEXT,
  kind               TEXT NOT NULL CHECK (kind IN ('pct','fixed')),
  value              REAL NOT NULL,
  min_cents          INTEGER,
  max_discount_cents INTEGER,
  listing_id         INTEGER REFERENCES listings(id) ON DELETE CASCADE,
  keywords           TEXT,
  conditions_json    TEXT,
  valid_until        INTEGER,
  source             TEXT NOT NULL,
  confidence         TEXT NOT NULL CHECK (confidence IN ('confirmed','probable','unverified')),
  raw_text           TEXT,
  active             INTEGER NOT NULL DEFAULT 1,
  created_at         INTEGER NOT NULL,
  last_seen_at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_coupons_store ON coupons(store, active);
CREATE UNIQUE INDEX IF NOT EXISTS uq_coupon_page ON coupons(store, IFNULL(code,''), IFNULL(listing_id,0), source, kind, value);

CREATE TABLE IF NOT EXISTS alerts (
  id              INTEGER PRIMARY KEY,
  product_id      INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  listing_id      INTEGER REFERENCES listings(id) ON DELETE SET NULL,
  ts              INTEGER NOT NULL,
  effective_cents INTEGER NOT NULL,
  reasons         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_alerts_product ON alerts(product_id, ts);

CREATE TABLE IF NOT EXISTS kv (
  key   TEXT PRIMARY KEY,
  value TEXT
);
`;

let db;

// Migrações para bancos criados em versões anteriores
function migrate(d) {
  const cols = d.prepare('PRAGMA table_info(products)').all().map((c) => c.name);
  if (!cols.includes('price_min_cents')) d.exec('ALTER TABLE products ADD COLUMN price_min_cents INTEGER');
  if (!cols.includes('price_max_cents')) d.exec('ALTER TABLE products ADD COLUMN price_max_cents INTEGER');
  d.exec(`CREATE TABLE IF NOT EXISTS seen_items (
    source      TEXT NOT NULL,
    external_id TEXT NOT NULL,
    ts          INTEGER NOT NULL,
    PRIMARY KEY (source, external_id)
  )`);
}

export function openDb(file = config.dbPath) {
  if (db) return db;
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  db = new DatabaseSync(file);
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

export function closeDb() {
  db?.close();
  db = undefined;
}

const now = () => Date.now();

// ---------- products ----------
export const products = {
  create({ name, targetCents = null }) {
    const r = openDb()
      .prepare('INSERT INTO products (name, target_cents, created_at) VALUES (?, ?, ?)')
      .run(name, targetCents, now());
    return Number(r.lastInsertRowid);
  },
  get: (id) => openDb().prepare('SELECT * FROM products WHERE id = ?').get(id),
  list: () => openDb().prepare('SELECT * FROM products ORDER BY id').all(),
  setTarget: (id, cents) => openDb().prepare('UPDATE products SET target_cents = ? WHERE id = ?').run(cents, id),
  setKeywords: (id, kw) => openDb().prepare('UPDATE products SET keywords = ? WHERE id = ?').run(kw || null, id),
  setRange: (id, minCents, maxCents) =>
    openDb().prepare('UPDATE products SET price_min_cents = ?, price_max_cents = ? WHERE id = ?').run(minCents || null, maxCents || null, id),
  rename: (id, name) => openDb().prepare('UPDATE products SET name = ? WHERE id = ?').run(name, id),
  setActive: (id, active) => {
    openDb().prepare('UPDATE products SET active = ? WHERE id = ?').run(active ? 1 : 0, id);
    openDb().prepare('UPDATE listings SET active = ? WHERE product_id = ?').run(active ? 1 : 0, id);
  },
  remove: (id) => openDb().prepare('DELETE FROM products WHERE id = ?').run(id),
};

// ---------- listings ----------
export const listings = {
  create({ productId, store, url, externalId = null, title = null }) {
    const r = openDb()
      .prepare(
        'INSERT INTO listings (product_id, store, url, external_id, title, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(productId, store, url, externalId, title, now());
    return Number(r.lastInsertRowid);
  },
  get: (id) => openDb().prepare('SELECT * FROM listings WHERE id = ?').get(id),
  byUrl: (url) => openDb().prepare('SELECT * FROM listings WHERE url = ?').get(url),
  byProduct: (productId) => openDb().prepare('SELECT * FROM listings WHERE product_id = ? ORDER BY id').all(productId),
  all: () => openDb().prepare('SELECT * FROM listings ORDER BY id').all(),
  due: (ts = now()) =>
    openDb()
      .prepare(
        `SELECT l.* FROM listings l JOIN products p ON p.id = l.product_id
         WHERE l.active = 1 AND p.active = 1 AND l.next_check_at <= ? ORDER BY l.next_check_at`,
      )
      .all(ts),
  remove: (id) => openDb().prepare('DELETE FROM listings WHERE id = ?').run(id),
  setInterval: (id, min) => openDb().prepare('UPDATE listings SET interval_min = ? WHERE id = ?').run(min, id),
  scheduleNow: (id) => openDb().prepare('UPDATE listings SET next_check_at = 0 WHERE id = ?').run(id),
  markOk(id, { title, externalId, priceCents, effectiveCents, inStock, nextCheckAt }) {
    openDb()
      .prepare(
        `UPDATE listings SET title = COALESCE(?, title), external_id = COALESCE(?, external_id),
           last_checked_at = ?, last_ok_at = ?, fail_count = 0, last_error = NULL,
           last_price_cents = ?, last_effective_cents = ?, last_in_stock = ?, next_check_at = ?
         WHERE id = ?`,
      )
      .run(title ?? null, externalId ?? null, now(), now(), priceCents, effectiveCents, inStock ? 1 : 0, nextCheckAt, id);
  },
  markFail(id, error, nextCheckAt) {
    openDb()
      .prepare(
        `UPDATE listings SET last_checked_at = ?, fail_count = fail_count + 1, last_error = ?, next_check_at = ?
         WHERE id = ?`,
      )
      .run(now(), String(error).slice(0, 500), nextCheckAt, id);
  },
};

// ---------- price points ----------
export const prices = {
  last: (listingId) =>
    openDb().prepare('SELECT * FROM price_points WHERE listing_id = ? ORDER BY ts DESC LIMIT 1').get(listingId),
  insert(p) {
    openDb()
      .prepare(
        `INSERT INTO price_points (listing_id, ts, price_cents, pix_cents, list_cents, effective_cents,
           effective_confidence, in_stock, seller, breakdown_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        p.listingId,
        p.ts ?? now(),
        p.priceCents ?? null,
        p.pixCents ?? null,
        p.listCents ?? null,
        p.effectiveCents ?? null,
        p.effectiveConfidence ?? null,
        p.inStock ? 1 : 0,
        p.seller ?? null,
        p.breakdown ? JSON.stringify(p.breakdown) : null,
      );
  },
  /** Histórico de todos os anúncios de um produto. */
  historyForProduct: (productId, sinceTs = 0) =>
    openDb()
      .prepare(
        `SELECT pp.*, l.store, l.url FROM price_points pp JOIN listings l ON l.id = pp.listing_id
         WHERE l.product_id = ? AND pp.ts >= ? ORDER BY pp.ts`,
      )
      .all(productId, sinceTs),
  /** Estatísticas do preço efetivo (somente com estoque) de um produto. */
  statsForProduct(productId, sinceTs = 0) {
    const rows = openDb()
      .prepare(
        `SELECT pp.effective_cents AS c, pp.ts FROM price_points pp JOIN listings l ON l.id = pp.listing_id
         WHERE l.product_id = ? AND pp.ts >= ? AND pp.in_stock = 1 AND pp.effective_cents IS NOT NULL ORDER BY pp.ts`,
      )
      .all(productId, sinceTs);
    if (!rows.length) return null;
    const vals = rows.map((r) => r.c).sort((a, b) => a - b);
    const mid = Math.floor(vals.length / 2);
    const median = vals.length % 2 ? vals[mid] : Math.round((vals[mid - 1] + vals[mid]) / 2);
    return { min: vals[0], max: vals.at(-1), median, count: vals.length, firstTs: rows[0].ts };
  },
};

// ---------- coupons ----------
export const coupons = {
  /** Insere ou atualiza (por chave única) e devolve o id. */
  upsert(c) {
    const d = openDb();
    const ts = now();
    d.prepare(
      `INSERT INTO coupons (store, code, kind, value, min_cents, max_discount_cents, listing_id, keywords,
         conditions_json, valid_until, source, confidence, raw_text, active, created_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
       ON CONFLICT DO UPDATE SET last_seen_at = excluded.last_seen_at, active = 1,
         min_cents = COALESCE(excluded.min_cents, min_cents),
         max_discount_cents = COALESCE(excluded.max_discount_cents, max_discount_cents),
         valid_until = COALESCE(excluded.valid_until, valid_until),
         raw_text = excluded.raw_text`,
    ).run(
      c.store,
      c.code ?? null,
      c.kind,
      c.value,
      c.minCents ?? null,
      c.maxDiscountCents ?? null,
      c.listingId ?? null,
      c.keywords?.length ? c.keywords.join(',') : null,
      c.conditions ? JSON.stringify(c.conditions) : null,
      c.validUntil ?? null,
      c.source,
      c.confidence,
      c.rawText?.slice(0, 1000) ?? null,
      ts,
      ts,
    );
  },
  /** Cupons ativos e válidos de uma loja (gerais ou deste anúncio). */
  activeFor(store, listingId, ts = now()) {
    return openDb()
      .prepare(
        `SELECT * FROM coupons WHERE (store = ? OR store = 'any') AND active = 1
           AND (listing_id IS NULL OR listing_id = ?)
           AND (valid_until IS NULL OR valid_until > ?)`,
      )
      .all(store, listingId, ts)
      .map(rowToCoupon);
  },
  /** Desativa cupons de página de um anúncio que não apareceram na última leitura. */
  expirePageCoupons(listingId, seenBefore) {
    openDb()
      .prepare(`UPDATE coupons SET active = 0 WHERE listing_id = ? AND source = 'page' AND last_seen_at < ?`)
      .run(listingId, seenBefore);
  },
  /** Cupons de canais sem validade explícita expiram após X horas sem serem vistos novamente. */
  expireStale(maxAgeHours = 48) {
    openDb()
      .prepare(`UPDATE coupons SET active = 0 WHERE source != 'page' AND source != 'manual' AND valid_until IS NULL AND last_seen_at < ?`)
      .run(now() - maxAgeHours * 3600_000);
  },
  list: (onlyActive = true) =>
    openDb()
      .prepare(`SELECT * FROM coupons ${onlyActive ? 'WHERE active = 1' : ''} ORDER BY last_seen_at DESC LIMIT 100`)
      .all()
      .map(rowToCoupon),
  deactivate: (id) => openDb().prepare('UPDATE coupons SET active = 0 WHERE id = ?').run(id),
};

function rowToCoupon(r) {
  return {
    id: r.id,
    store: r.store,
    code: r.code,
    kind: r.kind,
    value: r.value,
    minCents: r.min_cents,
    maxDiscountCents: r.max_discount_cents,
    listingId: r.listing_id,
    keywords: r.keywords ? r.keywords.split(',') : [],
    conditions: r.conditions_json ? JSON.parse(r.conditions_json) : {},
    validUntil: r.valid_until,
    source: r.source,
    confidence: r.confidence,
    rawText: r.raw_text,
    lastSeenAt: r.last_seen_at,
  };
}

// ---------- alerts ----------
export const alerts = {
  insert: ({ productId, listingId, effectiveCents, reasons }) =>
    openDb()
      .prepare('INSERT INTO alerts (product_id, listing_id, ts, effective_cents, reasons) VALUES (?, ?, ?, ?, ?)')
      .run(productId, listingId, now(), effectiveCents, reasons.join(',')),
  lastForProduct: (productId) =>
    openDb().prepare('SELECT * FROM alerts WHERE product_id = ? ORDER BY ts DESC LIMIT 1').get(productId),
};

export const kv = {
  get: (k) => openDb().prepare('SELECT value FROM kv WHERE key = ?').get(k)?.value,
  set: (k, v) => openDb().prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, v),
};

// ---------- itens já vistos (para não avisar a mesma oferta duas vezes) ----------
export const seen = {
  /** true só na primeira vez que o item aparece */
  markNew(source, externalId) {
    const r = openDb()
      .prepare('INSERT OR IGNORE INTO seen_items (source, external_id, ts) VALUES (?, ?, ?)')
      .run(source, String(externalId), now());
    return r.changes === 1;
  },
};
