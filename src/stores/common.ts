import * as cheerio from 'cheerio';

/** "R$ 1.234,56" | "1234.56" | 1234.56 -> 123456 (centavos) */
export function toCents(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? Math.round(v * 100) : null;
  let s = String(v).replace(/[^\d.,-]/g, '');
  if (!s) return null;
  if (s.includes(',')) {
    // formato brasileiro: ponto = milhar, vírgula = decimal
    s = s.replace(/\./g, '').replace(',', '.');
  } else if ((s.match(/\./g) || []).length > 1 || /\.\d{3}$/.test(s)) {
    // "1.234" ou "1.234.567" sem centavos
    s = s.replace(/\./g, '');
  }
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

export const fmt = (cents) =>
  cents === null || cents === undefined
    ? '—'
    : (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

export function loadHtml(html) {
  return cheerio.load(html);
}

/** Todos os objetos JSON-LD da página (achatando @graph e arrays). */
export function jsonLd($) {
  const out = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const data = JSON.parse($(el).contents().text());
      const stack = Array.isArray(data) ? [...data] : [data];
      while (stack.length) {
        const o = stack.shift();
        if (!o || typeof o !== 'object') continue;
        if (Array.isArray(o['@graph'])) stack.push(...o['@graph']);
        out.push(o);
      }
    } catch {
      /* JSON-LD inválido: ignora */
    }
  });
  return out;
}

/** Extrai dados de um Product do schema.org, se houver. */
export function productFromJsonLd($) {
  const p = jsonLd($).find((o) => [].concat(o['@type']).includes('Product'));
  if (!p) return null;
  const offers = [].concat(p.offers || []).flatMap((o) => (o?.['@type'] === 'AggregateOffer' ? [o, ...[].concat(o.offers || [])] : [o]));
  const prices = offers
    .map((o) => toCents(o?.price ?? o?.lowPrice ?? o?.priceSpecification?.price))
    .filter((c) => c !== null && c > 0);
  const availability = offers.map((o) => String(o?.availability || '')).join(' ');
  return {
    title: p.name || null,
    sku: p.sku || p.productID || null,
    gtin: p.gtin13 || p.gtin || p.gtin14 || p.gtin12 || null,
    priceCents: prices.length ? Math.min(...prices) : null,
    inStock: availability ? /InStock|LimitedAvailability|PreOrder/i.test(availability) : null,
    seller: offers[0]?.seller?.name || null,
  };
}

/** JSON do Next.js (__NEXT_DATA__), se houver. */
export function nextData($) {
  const txt = $('#__NEXT_DATA__').contents().text();
  if (!txt) return null;
  try {
    return JSON.parse(txt);
  } catch {
    return null;
  }
}

/** Procura recursivamente o primeiro objeto que satisfaça o predicado. */
export function findDeep(obj, pred, maxDepth = 12) {
  const seen = new Set();
  const walk = (o, d) => {
    if (!o || typeof o !== 'object' || d > maxDepth || seen.has(o)) return undefined;
    seen.add(o);
    if (pred(o)) return o;
    for (const v of Object.values(o)) {
      const r = walk(v, d + 1);
      if (r) return r;
    }
    return undefined;
  };
  return walk(obj, 0);
}

export function metaPrice($) {
  const v =
    $('meta[property="product:price:amount"]').attr('content') ||
    $('meta[property="og:price:amount"]').attr('content') ||
    $('meta[itemprop="price"]').attr('content');
  return toCents(v);
}

export const cleanText = (s) => String(s || '').replace(/\s+/g, ' ').trim();

/** Erro que indica bloqueio anti-robô / captcha (o agendador espaça mais as tentativas). */
export class BlockedError extends Error {
  constructor(store, detail = '') {
    super(`${store}: acesso bloqueado pela loja (anti-robô/captcha)${detail ? ' — ' + detail : ''}`);
    this.name = 'BlockedError';
  }
}

// ---------- validação de dados externos (lojas, comparadores e agregadores) ----------
// Respostas de sites chegam sem formato garantido: tudo entra como unknown e passa por estes validadores.

/** @param {unknown} v @returns {v is Record<string, unknown>} */
export const isRecord = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Número finito ou null. @param {unknown} v @returns {number | null} */
export const asNumber = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Texto não vazio ou null. @param {unknown} v @returns {string | null} */
export const asString = (v) => (typeof v === 'string' && v.length > 0 ? v : null);
