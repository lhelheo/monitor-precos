import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.ts';
import { log } from '../log.ts';
import { toCents } from '../stores/common.ts';

/**
 * Extração de cupons com Claude (opcional — só roda se ANTHROPIC_API_KEY estiver definida).
 * Usada para mensagens de canais de promoção, que têm formatos muito variados.
 * Só é chamada para mensagens que mencionam "cupom"/"código" — o volume é pequeno.
 */

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['coupons', 'deal'],
  properties: {
    coupons: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['store', 'code', 'kind', 'value', 'min_purchase', 'max_discount', 'first_purchase_only', 'app_only', 'prime_only', 'selected_items_only', 'payment_method', 'valid_until', 'product_keywords'],
        properties: {
          store: { type: ['string', 'null'], description: 'kabum, amazon, magalu, mercadolivre ou shopee' },
          code: { type: ['string', 'null'] },
          kind: { type: ['string', 'null'], description: 'pct (percentual) ou fixed (valor em reais)' },
          value: { type: ['number', 'null'], description: 'percentual (10 = 10%) ou valor em reais' },
          min_purchase: { type: ['number', 'null'], description: 'valor mínimo da compra em reais' },
          max_discount: { type: ['number', 'null'], description: 'desconto máximo em reais' },
          first_purchase_only: { type: 'boolean' },
          app_only: { type: 'boolean' },
          prime_only: { type: 'boolean', description: 'cupom exclusivo para assinantes Amazon Prime' },
          selected_items_only: { type: 'boolean' },
          payment_method: { type: ['string', 'null'] },
          valid_until: { type: ['string', 'null'], description: 'ISO 8601 no fuso America/Sao_Paulo, se informado' },
          product_keywords: {
            type: 'array',
            items: { type: 'string' },
            description: 'categorias/produtos aos quais o cupom se restringe (vazio = loja toda)',
          },
        },
      },
    },
    deal: {
      type: ['object', 'null'],
      additionalProperties: false,
      required: ['store', 'product', 'final_price'],
      properties: {
        store: { type: ['string', 'null'], description: 'kabum, amazon, magalu, mercadolivre ou shopee' },
        product: { type: 'string' },
        final_price: { type: ['number', 'null'], description: 'preço final anunciado em reais (já com cupom, se a mensagem disser)' },
      },
    },
  },
};

const SYSTEM = `Você extrai dados de mensagens de canais brasileiros de promoções.
Retorne somente o que está escrito na mensagem; use null quando um campo não for informado e nunca invente códigos de cupom.
"store" é a loja onde o cupom/oferta vale (kabum, amazon, magalu, mercadolivre ou shopee), deduzida do texto ou dos links.
"deal" descreve o produto anunciado e o preço final, se a mensagem anunciar um produto específico; senão null.`;

let client: Anthropic | null = null;
export const llmEnabled = () => Boolean(config.anthropic.apiKey);

interface LlmCoupon {
  store: string | null;
  code: string | null;
  kind: 'pct' | 'fixed' | null;
  value: number | null;
  min_purchase: number | null;
  max_discount: number | null;
  first_purchase_only: boolean;
  app_only: boolean;
  prime_only: boolean;
  selected_items_only: boolean;
  payment_method: string | null;
  valid_until: string | null;
  product_keywords: string[];
}

export async function extractWithLlm(text: string, { now = new Date() }: { now?: Date } = {}) {
  if (!llmEnabled()) return null;
  client ??= new Anthropic({ apiKey: config.anthropic.apiKey });
  try {
    const res = await client.beta.messages.create({
      model: config.anthropic.model,
      max_tokens: 2000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
      system: SYSTEM,
      messages: [
        {
          role: 'user',
          content: `Data/hora atual: ${now.toISOString()} (America/Sao_Paulo)\n\nMensagem:\n${text.slice(0, 4000)}`,
        },
      ],
    });
    if (res.stop_reason === 'refusal' || res.stop_reason === 'max_tokens') {
      log.warn(`LLM: resposta incompleta (${res.stop_reason})`);
      return null;
    }
    const block = res.content.find((b) => b.type === 'text');
    const data = JSON.parse(block?.text || 'null');
    if (!data) return null;
    return {
      coupons: data.coupons.map((c: LlmCoupon) => ({
        store: c.store,
        code: c.code,
        kind: c.kind,
        value: c.value,
        minCents: c.min_purchase ? toCents(c.min_purchase) : null,
        maxDiscountCents: c.max_discount ? toCents(c.max_discount) : null,
        keywords: c.product_keywords,
        conditions: {
          ...(c.first_purchase_only && { firstPurchase: true }),
          ...(c.app_only && { appOnly: true }),
          ...(c.prime_only && { primeOnly: true }),
          ...(c.selected_items_only && { selectedItems: true }),
          ...(c.payment_method && { payment: c.payment_method }),
        },
        validUntil: c.valid_until ? Date.parse(c.valid_until) || null : null,
      })),
      deal: data.deal ? { ...data.deal, finalCents: data.deal.final_price ? toCents(data.deal.final_price) : null } : null,
    };
  } catch (e) {
    if (e instanceof Anthropic.RateLimitError) log.warn('LLM: limite de requisições, usando parser local');
    else if (e instanceof Anthropic.APIError) log.warn(`LLM: erro da API ${e.status}: ${(e as Error).message}`);
    else log.warn(`LLM: ${(e as Error).message}`);
    return null;
  }
}
