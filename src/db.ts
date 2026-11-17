import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.ts';
import type { Confidence, Coupon, CouponConditions, CouponKind, ListingRow, PricePoint, ProductRow, StoreId } from './types.ts';

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

let db: DatabaseSync | undefined;

/** Linha da tabela de cupons, como o SQLite devolve (snake_case). */
type CouponRow = {
  id: number;
  store: string;
  code: string | null;
  kind: CouponKind;
  value: number;
  min_cents: number | null;
  max_discount_cents: number | null;
  listing_id: number | null;
  keywords: string | null;
  conditions_json: string | null;
  valid_until: number | null;
  source: string;
  confidence: Confidence;
  raw_text: string | null;
  last_seen_at: number;
};

/** Linha da tabela de alertas. */
type AlertRow = {
  id: number;
  product_id: number;
  listing_id: number | null;
  ts: number;
  effective_cents: number;
  reasons: string;
};

/** Cupom a gravar. `kind` nulo não é gravado: quem chama confere antes. */
export interface CouponWrite {
  store: string;
  code?: string | null;
  kind: CouponKind | null;
  value: number;
  minCents?: number | null;
  maxDiscountCents?: number | null;
  listingId?: number | null;
  keywords?: string[];
  conditions?: CouponConditions;
  validUntil?: number | null;
  source: string;
  confidence: Confidence;
  rawText?: string | null;
}

// Migrações para bancos criados em versões anteriores
function migrate(d: DatabaseSync): void {
  const cols = (d.prepare('PRAGMA table_info(products)').all() as Array<{ name: string }>).map((c) => c.name);
  if (!cols.includes('price_min_cents')) d.exec('ALTER TABLE products ADD COLUMN price_min_cents INTEGER');
  if (!cols.includes('price_max_cents')) d.exec('ALTER TABLE products ADD COLUMN price_max_cents INTEGER');
  d.exec(`CREATE TABLE IF NOT EXISTS seen_items (
    source      TEXT NOT NULL,
    external_id TEXT NOT NULL,
    ts          INTEGER NOT NULL,
    PRIMARY KEY (source, external_id)
  )`);
}

export function openDb(file: string = config.dbPath): DatabaseSync {
  if (db) return db;
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  db = new DatabaseSync(file);
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

export function closeDb(): void {
  db?.close();
  db = undefined;
}

const now = (): number => Date.now();

// ---------- products ----------
export const products = {
  create({ name, targetCents = null }: { name: string; targetCents?: number | null }): number {
    const r = openDb()
      .prepare('INSERT INTO products (name, target_cents, created_at) VALUES (?, ?, ?)')
      .run(name, targetCents, now());
    return Number(r.lastInsertRowid);
  },
  get: (id: number): ProductRow | undefined =>
    openDb().prepare('SELECT * FROM products WHERE id = ?').get(id) as ProductRow | undefined,
  list: (): ProductRow[] => openDb().prepare('SELECT * FROM products ORDER BY id').all() as unknown as ProductRow[],
  setTarget: (id: number, cents: number | null) =>
    openDb().prepare('UPDATE products SET target_cents = ? WHERE id = ?').run(cents, id),
  setKeywords: (id: number, kw: string | null | undefined) =>
    openDb().prepare('UPDATE products SET keywords = ? WHERE id = ?').run(kw || null, id),
  setRange: (id: number, minCents: number | null, maxCents: number | null) =>
    openDb().prepare('UPDATE products SET price_min_cents = ?, price_max_cents = ? WHERE id = ?').run(minCents || null, maxCents || null, id),
  rename: (id: number, name: string) => openDb().prepare('UPDATE products SET name = ? WHERE id = ?').run(name, id),
  setActive: (id: number, active: boolean): void => {
    openDb().prepare('UPDATE products SET active = ? WHERE id = ?').run(active ? 1 : 0, id);
    openDb().prepare('UPDATE listings SET active = ? WHERE product_id = ?').run(active ? 1 : 0, id);
  },
  remove: (id: number) => openDb().prepare('DELETE FROM products WHERE id = ?').run(id),
};

// ---------- listings ----------
export const listings = {
  create({
    productId,
    store,
    url,
    externalId = null,
    title = null,
  }: {
    productId: number;
    store: string;
    url: string;
    externalId?: string | null;
    title?: string | null;
  }): number {
    const r = openDb()
      .prepare(
        'INSERT INTO listings (product_id, store, url, external_id, title, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(productId, store, url, externalId, title, now());
    return Number(r.lastInsertRowid);
  },
  get: (id: number): ListingRow | undefined =>
    openDb().prepare('SELECT * FROM listings WHERE id = ?').get(id) as ListingRow | undefined,
  byUrl: (url: string): ListingRow | undefined =>
    openDb().prepare('SELECT * FROM listings WHERE url = ?').get(url) as ListingRow | undefined,
  byProduct: (productId: number): ListingRow[] =>
    openDb().prepare('SELECT * FROM listings WHERE product_id = ? ORDER BY id').all(productId) as unknown as ListingRow[],
  all: (): ListingRow[] => openDb().prepare('SELECT * FROM listings ORDER BY id').all() as unknown as ListingRow[],
  due: (ts: number = now()): ListingRow[] =>
    openDb()
      .prepare(
        `SELECT l.* FROM listings l JOIN products p ON p.id = l.product_id
         WHERE l.active = 1 AND p.active = 1 AND l.next_check_at <= ? ORDER BY l.next_check_at`,
      )
      .all(ts) as unknown as ListingRow[],
  remove: (id: number) => openDb().prepare('DELETE FROM listings WHERE id = ?').run(id),
  setInterval: (id: number, min: number) =>
    openDb().prepare('UPDATE listings SET interval_min = ? WHERE id = ?').run(min, id),
  scheduleNow: (id: number) => openDb().prepare('UPDATE listings SET next_check_at = 0 WHERE id = ?').run(id),
  markOk(
    id: number,
    {
      title,
      externalId,
      priceCents,
      effectiveCents,
      inStock,
      nextCheckAt,
    }: {
      title?: string | null;
      externalId?: string | null;
      priceCents: number | null;
      effectiveCents: number | null;
      inStock: boolean;
      nextCheckAt: number;
    },
  ): void {
    openDb()
      .prepare(
        `UPDATE listings SET title = COALESCE(?, title), external_id = COALESCE(?, external_id),
           last_checked_at = ?, last_ok_at = ?, fail_count = 0, last_error = NULL,
           last_price_cents = ?, last_effective_cents = ?, last_in_stock = ?, next_check_at = ?
         WHERE id = ?`,
      )
      .run(title ?? null, externalId ?? null, now(), now(), priceCents, effectiveCents, inStock ? 1 : 0, nextCheckAt, id);
  },
  markFail(id: number, error: unknown, nextCheckAt: number): void {
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
  last: (listingId: number): PricePoint | undefined =>
    openDb().prepare('SELECT * FROM price_points WHERE listing_id = ? ORDER BY ts DESC LIMIT 1').get(listingId) as
      | PricePoint
      | undefined,
  insert(p: {
    listingId: number;
    ts?: number;
    priceCents?: number | null;
    pixCents?: number | null;
    listCents?: number | null;
    effectiveCents?: number | null;
    effectiveConfidence?: Confidence | null;
    inStock?: boolean;
    seller?: string | null;
    breakdown?: unknown;
  }): void {
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
  historyForProduct: (productId: number, sinceTs = 0): Array<PricePoint & { store: StoreId; url: string }> =>
    openDb()
      .prepare(
        `SELECT pp.*, l.store, l.url FROM price_points pp JOIN listings l ON l.id = pp.listing_id
         WHERE l.product_id = ? AND pp.ts >= ? ORDER BY pp.ts`,
      )
      .all(productId, sinceTs) as unknown as Array<PricePoint & { store: StoreId; url: string }>,
  /** Estatísticas do preço efetivo (somente com estoque) de um produto. */
  statsForProduct(
    productId: number,
    sinceTs = 0,
  ): { min: number; max: number; median: number; count: number; firstTs: number } | null {
    const rows = openDb()
      .prepare(
        `SELECT pp.effective_cents AS c, pp.ts FROM price_points pp JOIN listings l ON l.id = pp.listing_id
         WHERE l.product_id = ? AND pp.ts >= ? AND pp.in_stock = 1 AND pp.effective_cents IS NOT NULL ORDER BY pp.ts`,
      )
      .all(productId, sinceTs) as Array<{ c: number; ts: number }>;
    if (!rows.length) return null;
    const vals = rows.map((r) => r.c).sort((a, b) => a - b);
    const mid = Math.floor(vals.length / 2);
    const median = vals.length % 2 ? vals[mid] : Math.round((vals[mid - 1] + vals[mid]) / 2);
    return { min: vals[0], max: vals.at(-1) as number, median, count: vals.length, firstTs: rows[0].ts };
  },
};

// ---------- coupons ----------
export const coupons = {
  /** Insere ou atualiza (por chave única). */
  upsert(c: CouponWrite): void {
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
         conditions_json = COALESCE(excluded.conditions_json, conditions_json),
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
  activeFor(store: string, listingId: number, ts: number = now()): Coupon[] {
    return (
      openDb()
        .prepare(
          `SELECT * FROM coupons WHERE (store = ? OR store = 'any') AND active = 1
           AND (listing_id IS NULL OR listing_id = ?)
           AND (valid_until IS NULL OR valid_until > ?)`,
        )
        .all(store, listingId, ts) as CouponRow[]
    ).map(rowToCoupon);
  },
  /** Desativa cupons de página de um anúncio que não apareceram na última leitura. */
  expirePageCoupons(listingId: number, seenBefore: number): void {
    openDb()
      .prepare(`UPDATE coupons SET active = 0 WHERE listing_id = ? AND source = 'page' AND last_seen_at < ?`)
      .run(listingId, seenBefore);
  },
  /** Cupons de canais sem validade explícita expiram após X horas sem serem vistos novamente. */
  expireStale(maxAgeHours = 48): void {
    openDb()
      .prepare(`UPDATE coupons SET active = 0 WHERE source != 'page' AND source != 'manual' AND valid_until IS NULL AND last_seen_at < ?`)
      .run(now() - maxAgeHours * 3600_000);
  },
  list: (onlyActive = true): Coupon[] =>
    (
      openDb()
        .prepare(`SELECT * FROM coupons ${onlyActive ? 'WHERE active = 1' : ''} ORDER BY last_seen_at DESC LIMIT 100`)
        .all() as CouponRow[]
    ).map(rowToCoupon),
  deactivate: (id: number) => openDb().prepare('UPDATE coupons SET active = 0 WHERE id = ?').run(id),
};

function rowToCoupon(r: CouponRow): Coupon {
  return {
    id: r.id,
    store: r.store as StoreId,
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
  insert: ({
    productId,
    listingId,
    effectiveCents,
    reasons,
  }: {
    productId: number;
    listingId: number | null;
    effectiveCents: number;
    reasons: string[];
  }) =>
    openDb()
      .prepare('INSERT INTO alerts (product_id, listing_id, ts, effective_cents, reasons) VALUES (?, ?, ?, ?, ?)')
      .run(productId, listingId, now(), effectiveCents, reasons.join(',')),
  lastForProduct: (productId: number): AlertRow | undefined =>
    openDb().prepare('SELECT * FROM alerts WHERE product_id = ? ORDER BY ts DESC LIMIT 1').get(productId) as
      | AlertRow
      | undefined,
};

export const kv = {
  get: (k: string): string | undefined =>
    (openDb().prepare('SELECT value FROM kv WHERE key = ?').get(k) as { value: string } | undefined)?.value,
  set: (k: string, v: string) =>
    openDb()
      .prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(k, v),
};

// ---------- itens já vistos (para não avisar a mesma oferta duas vezes) ----------
export const seen = {
  /** já foi visto? */
  has(source: string, externalId: string | number): boolean {
    return Boolean(
      openDb().prepare('SELECT 1 FROM seen_items WHERE source = ? AND external_id = ?').get(source, String(externalId)),
    );
  },
  /** true só na primeira vez que o item aparece */
  markNew(source: string, externalId: string | number): boolean {
    const r = openDb()
      .prepare('INSERT OR IGNORE INTO seen_items (source, external_id, ts) VALUES (?, ?, ?)')
      .run(source, String(externalId), now());
    return r.changes === 1;
  },
};
