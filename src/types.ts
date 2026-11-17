// Formatos centrais do sistema. Arquivo só de tipos: não gera código em tempo de execução.
// Os módulos .js importam estes tipos com `import type` e JSDoc.

/** Identificadores das lojas e fontes que o sistema conhece. */
export type StoreId = 'kabum' | 'amazon' | 'mercadolivre' | 'magalu' | 'shopee' | 'zoom' | 'any';

/** Confiança de um cupom: 🟢 confirmado (na página), 🟡 provável (agregador), ⚪ não verificado. */
export type Confidence = 'confirmed' | 'probable' | 'unverified';

/** Tipo de desconto: percentual (10 = 10%) ou valor fixo em reais. */
export type CouponKind = 'pct' | 'fixed';

/** Condições extras de um cupom. */
export interface CouponConditions {
  firstPurchase?: boolean;
  appOnly?: boolean;
  selectedItems?: boolean;
  payment?: string;
  thisItem?: boolean;
  clipCoupon?: boolean;
}

/** Cupom encontrado em uma página, mensagem ou comando, antes de ser salvo. */
export interface CouponInput {
  code?: string | null;
  kind: CouponKind | null;
  value: number;
  minCents?: number | null;
  maxDiscountCents?: number | null;
  conditions?: CouponConditions;
  keywords?: string[];
  validUntil?: number | null;
  confidence?: Confidence;
  rawText?: string;
  source?: string;
}

/** Cupom como é lido do banco (já convertido de snake_case). */
export interface Coupon {
  id: number;
  store: StoreId;
  code: string | null;
  kind: CouponKind;
  value: number;
  minCents: number | null;
  maxDiscountCents: number | null;
  listingId: number | null;
  keywords: string[];
  conditions: CouponConditions;
  validUntil: number | null;
  source: string;
  confidence: Confidence;
  rawText: string | null;
  lastSeenAt: number;
}

/** Resultado da leitura de um anúncio por um coletor de loja. */
export interface ScrapedPage {
  priceCents: number | null;
  title?: string | null;
  pixCents?: number | null;
  listCents?: number | null;
  inStock?: boolean | null;
  seller?: string | null;
  pageCoupons?: CouponInput[];
  externalId?: string | null;
  store?: string;
}

/** Detalhamento do preço efetivo, mostrado nos alertas. */
export interface PriceBreakdown {
  priceCents: number;
  baseCents: number;
  baseKind: string;
  coupon: {
    code: string | null;
    label: string;
    source: string;
    confidence: Confidence;
    discountCents: number;
    conditions: CouponConditions;
  } | null;
  cashbackCents: number;
  cashbackCounted: boolean;
  hints: Array<{ code: string | null; label: string; confidence: Confidence; blocker: string | null; wouldBeCents: number }>;
}

/** Resultado do cálculo do preço efetivo. */
export interface EffectiveResult {
  effectiveCents: number;
  confidence: Confidence;
  breakdown: PriceBreakdown;
}

/** Linha da tabela de produtos. */
export interface ProductRow {
  id: number;
  name: string;
  target_cents: number | null;
  keywords: string | null;
  price_min_cents: number | null;
  price_max_cents: number | null;
  active: number;
  created_at: number;
}

/** Linha da tabela de anúncios. */
export interface ListingRow {
  id: number;
  product_id: number;
  store: StoreId;
  url: string;
  external_id: string | null;
  title: string | null;
  active: number;
  interval_min: number | null;
  next_check_at: number;
  last_checked_at: number | null;
  last_ok_at: number | null;
  fail_count: number;
  last_error: string | null;
  last_price_cents: number | null;
  last_effective_cents: number | null;
  last_in_stock: number | null;
  created_at: number;
}

/** Ponto do histórico de preços. */
export interface PricePoint {
  id: number;
  listing_id: number;
  ts: number;
  price_cents: number | null;
  pix_cents: number | null;
  list_cents: number | null;
  effective_cents: number | null;
  effective_confidence: Confidence | null;
  in_stock: number | null;
  seller: string | null;
  breakdown_json: string | null;
}

/** Oferta lida de um agregador de ofertas (Pelando ou Promobit). */
export interface DealOffer {
  externalId: string;
  title: string;
  priceCents: number;
  store: string | null;
  temperature?: number | null;
  createdAt?: string | null;
  url: string;
}

/** Item de busca automática de uma loja ou do comparador. */
export interface SearchItem {
  externalId?: string;
  url: string;
  title: string;
  priceCents: number | null;
  pixCents?: number | null;
  inStock?: boolean;
  seller?: string | null;
}
