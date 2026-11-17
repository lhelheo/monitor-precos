import { coupons, products } from '../db.js';
import { log } from '../log.js';
import { STORES } from '../stores/index.js';
import { detectStore, parseAnnouncedPrice, parseCoupons } from './parser.js';
import { extractWithLlm, llmEnabled } from './llm.js';

const VALID_STORES = new Set(Object.keys(STORES));

const norm = (s) =>
  String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');

/**
 * Palavras-chave do produto: "dualsense -edge -capa" => precisa ter "dualsense" e não pode ter "edge" nem "capa".
 * Termos entre aspas viram frase: "\"midnight black\" dualsense".
 */
export function matchesKeywords(text, keywords) {
  if (!keywords) return false;
  // "PlayStation5" escrito junto (comum em títulos) vira "playstation 5"
  const t = norm(text).replace(/playstation(\d)/g, 'playstation $1');
  const terms = [...keywords.matchAll(/(-?)"([^"]+)"|(-?)(\S+)/g)].map((m) => ({
    neg: Boolean(m[1] || m[3]),
    // "(console|slim|digital)" = qualquer uma das alternativas
    alts: (m[2] || m[4]).replace(/^\(|\)$/g, '').split('|').map((a) => norm(a)),
  }));
  // palavra inteira (não pedaço): "-pro" não pode excluir "produto"
  const has = (term) => new RegExp('(^|[^a-z0-9])' + term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '([^a-z0-9]|$)').test(t);
  const pos = terms.filter((x) => !x.neg);
  if (!pos.length) return false;
  return pos.every((x) => x.alts.some(has)) && terms.filter((x) => x.neg).every((x) => !x.alts.some(has));
}

/** Confiança de um cupom vindo de canal/agregador. */
function confidenceFor(c) {
  if (!c.kind || !c.value) return 'unverified';
  if (c.conditions?.selectedItems) return 'unverified';
  return 'probable';
}

/**
 * Processa uma mensagem de canal de promoção (ou texto enviado via /cupom).
 * Salva os cupons encontrados e devolve os produtos monitorados que a mensagem menciona.
 *
 * @returns {{ coupons: object[], deal: object|null, matchedProducts: object[] }}
 */
export async function ingestText(text, { source = 'telegram', origin = '', forceConfidence = null } = {}) {
  if (!text || text.length < 8) return { coupons: [], deal: null, matchedProducts: [] };
  const hasCoupon = /cupo[mn]|c[oó]digo/i.test(text);
  const fallbackStore = detectStore(text);

  let parsed = null;
  if (hasCoupon && llmEnabled()) parsed = await extractWithLlm(text);
  if (!parsed) {
    parsed = {
      coupons: hasCoupon ? parseCoupons(text) : [],
      deal: { store: fallbackStore, product: text.split('\n')[0].slice(0, 120), finalCents: parseAnnouncedPrice(text) },
    };
  }

  const saved = [];
  for (const c of parsed.coupons) {
    const store = VALID_STORES.has(c.store) ? c.store : fallbackStore ?? 'any';
    if (!c.code) continue; // sem código não dá para usar
    const kind = c.kind === 'pct' || c.kind === 'fixed' ? c.kind : null;
    const coupon = {
      ...c,
      store,
      kind: kind ?? 'fixed',
      value: kind ? Number(c.value) || 0 : 0,
      source,
      confidence: forceConfidence ?? (store === 'any' ? 'unverified' : confidenceFor({ ...c, kind })),
      rawText: `${origin ? `[${origin}] ` : ''}${text}`.slice(0, 1000),
    };
    try {
      coupons.upsert(coupon);
      saved.push(coupon);
    } catch (e) {
      log.warn(`Cupom ignorado (${coupon.code}): ${e.message}`);
    }
  }

  const matchedProducts = products.list().filter((p) => p.active && matchesKeywords(text, p.keywords));
  return { coupons: saved, deal: parsed.deal, matchedProducts };
}
