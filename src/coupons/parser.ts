import { toCents } from '../stores/common.ts';

/**
 * Parser de cupons em texto livre (página da loja, mensagens de canais de promoção, /cupom do bot).
 * Ex.: "Use o cupom CONTROLE10 e ganhe 10% OFF neste item"
 *      "R$20 off na primeira compra no app. Insira o código APPCOMPRA"
 *      "🎟️ Cupom GAMER15 — 15% OFF em games acima de R$ 200, só no app, até 23:59"
 */

const STORE_PATTERNS: [string, RegExp][] = [
  ['kabum', /kabum|kbum\.me/i],
  ['amazon', /amazon|amzn\.to|a\.co\//i],
  ['magalu', /magalu|magazine\s*luiza|magazineluiza|divulgador\.magalu/i],
  ['mercadolivre', /mercado\s*livre|mercadolivre|mercadolibre|meli\.la|\bmeli\b/i],
  ['shopee', /shopee|shp\.ee/i],
];

export function detectStore(text: any) {
  for (const [store, re] of STORE_PATTERNS) if (re.test(text)) return store;
  return null;
}

// Palavras que costumam aparecer em MAIÚSCULAS e não são códigos de cupom
const NOT_CODES = new Set([
  'OFF', 'PIX', 'APP', 'CUPOM', 'FRETE', 'GRATIS', 'GRÁTIS', 'PROMO', 'BLACK', 'FRIDAY', 'HOJE', 'LINK',
  'COMPRE', 'AQUI', 'PS5', 'PS4', 'USB', 'CFI', 'NOVO', 'NOVA', 'SONY', 'KABUM', 'AMAZON', 'SHOPEE',
  'MAGALU', 'PRIME', 'DESCONTO', 'CODIGO', 'CÓDIGO', 'ACIMA', 'ITEM', 'LOJA', 'OFERTA', 'MELI',
]);

const CODE_RE =
  /(?:cupo[mn]s?|c[oó]digo|code)\s*(?:de\s+desconto\s*)?(?:promocional\s*)?[:\-–—]?\s*["'\u201C\u201D\u2018\u2019\x60*_]*\s*([A-Za-z0-9][A-Za-z0-9_-]{3,24})\b/gi;

/** Data de validade a partir de "até 23:59", "até 20/11", "válido até 30/11/2026 às 10h". */
export function parseValidity(text: any, ref = new Date()) {
  const dm = text.match(/at[eé]\s+(?:o\s+dia\s+)?(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?(?:[^\d]{1,6}(\d{1,2})[:h](\d{2})?)?/i);
  if (dm) {
    const year = dm[3] ? (dm[3].length === 2 ? 2000 + Number(dm[3]) : Number(dm[3])) : ref.getFullYear();
    const h = dm[4] !== undefined ? Number(dm[4]) : 23;
    const m = dm[5] !== undefined ? Number(dm[5]) : dm[4] !== undefined ? 0 : 59;
    const d = new Date(year, Number(dm[2]) - 1, Number(dm[1]), h, m, 59);
    if (d < ref && !dm[3]) d.setFullYear(d.getFullYear() + 1);
    return d.getTime();
  }
  const hm = text.match(/at[eé]\s+(?:[àa]s\s+)?(\d{1,2})[:h](\d{2})?\b/i);
  if (hm) {
    const d = new Date(ref);
    d.setHours(Number(hm[1]), hm[2] ? Number(hm[2]) : 0, 59, 0);
    if (d < ref) d.setDate(d.getDate() + 1);
    return d.getTime();
  }
  return null;
}

function parseAmounts(seg: string): any {
  const out: any = {};
  const pct = seg.match(/(\d{1,2}(?:[.,]\d{1,2})?)\s*%/);
  const fixed =
    seg.match(/R\$\s*([\d.]+(?:,\d{1,2})?)\s*(?:de\s+)?(?:off|desconto|de\s+volta)/i) ||
    seg.match(/(?:desconto|abatimento)\s+de\s+R\$\s*([\d.]+(?:,\d{1,2})?)/i) ||
    seg.match(/(?:ganhe|economize)\s+R\$\s*([\d.]+(?:,\d{1,2})?)/i);
  if (pct) {
    out.kind = 'pct';
    out.value = Number(pct[1].replace(',', '.'));
  } else if (fixed) {
    out.kind = 'fixed';
    out.value = toCents(fixed[1]) / 100;
  }
  const min = seg.match(
    /(?:acima\s+de|a\s+partir\s+de|compras?\s+(?:m[ií]nimas?\s+)?(?:de|acima\s+de)|m[ií]nimo\s+(?:de\s+)?|pedido\s+m[ií]nimo\s+(?:de\s+)?)\s*R\$\s*([\d.]+(?:,\d{1,2})?)/i,
  );
  if (min) out.minCents = toCents(min[1]);
  const max = seg.match(
    /(?:limitad[oa]\s+a|limite\s+de|m[aá]ximo\s+de|teto\s+de|desconto\s+m[aá]ximo\s+(?:de\s+)?)\s*R\$\s*([\d.]+(?:,\d{1,2})?)/i,
  );
  if (max) out.maxDiscountCents = toCents(max[1]);
  return out;
}

function parseConditions(seg: string): any {
  const c: any = {};
  if (/primeira\s+compra|1[ªa]\s+compra|novos?\s+clientes?/i.test(seg)) c.firstPurchase = true;
  if (/\bno\s+app\b|\bpelo\s+app\b|s[oó]\s+(?:no\s+)?app|aplicativo|\bapp\b/i.test(seg)) c.appOnly = true;
  if (/selecionad[oa]s|participantes|categorias?\s+selecionad/i.test(seg)) c.selectedItems = true;
  const pay = seg.match(/(?:pagando|pagamento|exclusivo)\s+(?:com|no|via)\s+([A-Za-zÀ-ú0-9 ]{3,25}?)(?:[.,;!]|$)/i);
  if (pay) c.payment = pay[1].trim();
  if (/neste\s+item|neste\s+produto|nesse\s+produto/i.test(seg)) c.thisItem = true;
  return c;
}

/**
 * Extrai cupons de um texto. Retorna lista de { code, kind, value, minCents, maxDiscountCents, conditions, validUntil, store, rawText }.
 * Cupons sem valor (kind) ainda são retornados — o valor pode já estar embutido no preço anunciado na mensagem.
 */
export function parseCoupons(text: any, { store = null, now = new Date() }: any = {}) {
  if (!text) return [];
  const flat = String(text).replace(/ /g, ' ');
  const results: any[] = [];
  const matches = [...flat.matchAll(CODE_RE)].filter((m) => {
    const code = m[1];
    return /[A-Z]/.test(code) && code === code.toUpperCase() && !NOT_CODES.has(code);
  });
  const validUntil = parseValidity(flat, now);
  const detected = store || detectStore(flat);

  matches.forEach((m, i) => {
    // segmento = da ocorrência anterior até a próxima, para atribuir valores ao cupom certo
    const start = i === 0 ? Math.max(0, m.index - 220) : matches[i - 1].index + matches[i - 1][0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index : Math.min(flat.length, m.index + 260);
    const seg = flat.slice(start, end);
    const amounts = parseAmounts(seg);
    results.push({
      code: m[1],
      ...amounts,
      conditions: parseConditions(seg),
      validUntil,
      store: detected,
      rawText: seg.trim(),
    });
  });

  // de-duplica por código (mantém o que tem valor)
  const byCode = new Map();
  for (const r of results) {
    const prev = byCode.get(r.code);
    if (!prev || (!prev.kind && r.kind)) byCode.set(r.code, r);
  }
  return [...byCode.values()];
}

/** "R$ 349,90" mais baixo presente numa mensagem de promoção (preço anunciado). */
export function parseAnnouncedPrice(text: any) {
  const vals = [...String(text).matchAll(/R\$\s*([\d.]+(?:,\d{1,2})?)/g)]
    .filter((m) => !/^\s*(?:de\s+)?(?:off|desconto)/i.test(text.slice(m.index + m[0].length, m.index + m[0].length + 12)))
    .filter((m) => !/(?:acima|partir|m[ií]nimo|limit|m[aá]ximo|de:|\bde\b)\s*$/i.test(text.slice(Math.max(0, m.index - 14), m.index)))
    .map((m) => toCents(m[1]))
    .filter((c) => c && c > 100);
  return vals.length ? Math.min(...vals) : null;
}
