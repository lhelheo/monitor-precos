import { fetchHtml, renderHtml } from '../http.ts';
import { parseCoupons } from '../coupons/parser.ts';
import { BlockedError, cleanText, loadHtml, toCents } from './common.ts';

export const id = 'amazon';
export const name = 'Amazon';
export const match = (u: string) => /(^|\.)amazon\.com\.br$/i.test(new URL(u).hostname);
export const externalId = (u: string) => u.match(/\/(?:dp|gp\/product|gp\/aw\/d)\/([A-Z0-9]{10})/i)?.[1]?.toUpperCase() ?? null;
/** URL canônica curta, sem rastreadores. */
export const canonical = (u: string) => {
  const asin = externalId(u);
  return asin ? `https://www.amazon.com.br/dp/${asin}` : u;
};

const isCaptcha = (html: string) => /validateCaptcha|Digite os caracteres|api-services-support@amazon/i.test(html);

export function parse(html: string) {
  const $ = loadHtml(html);
  if (isCaptcha(html)) return { blocked: true };

  const title = cleanText($('#productTitle').text()) || null;
  const priceTxt =
    $('#corePrice_feature_div .apex-pricetopay-value .a-offscreen').first().text() ||
    $('#corePriceDisplay_desktop_feature_div .priceToPay .a-offscreen').first().text() ||
    $('#corePriceDisplay_desktop_feature_div .apex-pricetopay-value .a-offscreen').first().text() ||
    $('#corePrice_desktop .a-price .a-offscreen').first().text() ||
    $('#apex_desktop .a-price .a-offscreen').first().text() ||
    $('#price_inside_buybox').first().text();
  const priceCents = toCents(priceTxt);
  if (!title && !priceCents) return null;

  const listTxt =
    $('#corePriceDisplay_desktop_feature_div .basisPrice .a-offscreen').first().text() ||
    $('.basisPrice .a-offscreen').first().text() ||
    $('#corePrice_desktop .a-text-price .a-offscreen').first().text();
  const listCents = toCents(listTxt);

  const availability = cleanText($('#availability').text());
  const inStock = priceCents ? !/indispon[ií]vel|não dispon/i.test(availability) : false;

  const merchant = cleanText($('[offer-display-feature-name="desktop-merchant-info"] .offer-display-feature-text').first().text()) ||
    cleanText($('#merchantInfoFeature_feature_div .offer-display-feature-text').first().text()) ||
    cleanText($('#sellerProfileTriggerId').first().text()) || null;

  // Cupons: caixa "Aplicar cupom" do produto (confirmado) + promoções de código (ex.: primeira compra no app)
  const pageCoupons = [];
  const couponBox = cleanText(
    $('#promoPriceBlockMessage_feature_div, #couponFeature, [id^="couponText"], #vpcButton').text(),
  );
  const boxMatch = couponBox.match(/(?:aplicar|economize)[^.]*?(?:cupom\s+de\s+)?(R\$\s*[\d.,]+|\d{1,2}\s*%)/i);
  if (boxMatch) {
    const v = boxMatch[1];
    pageCoupons.push({
      code: null as string | null,
      kind: v.includes('%') ? ('pct' as const) : ('fixed' as const),
      value: v.includes('%') ? Number(v.replace(/[^\d]/g, '')) : (toCents(v) ?? 0) / 100,
      conditions: { clipCoupon: true },
      confidence: 'confirmed' as const,
      rawText: couponBox.slice(0, 300),
    });
  }
  $('style, script').remove();
  const seen = new Set();
  $('[data-csa-c-owner="PromotionsDiscovery"]').each((_, el) => {
    // cada bloco de promoção é interpretado separadamente para não misturar valores entre cupons
    for (const c of parseCoupons(cleanText($(el).text()), { store: id })) {
      if (seen.has(c.code)) continue;
      seen.add(c.code);
      pageCoupons.push({ ...c, confidence: c.kind ? ('confirmed' as const) : ('probable' as const) });
    }
  });

  return {
    title,
    priceCents,
    pixCents: null as number | null,
    listCents: listCents && listCents > (priceCents ?? 0) ? listCents : null,
    inStock,
    seller: merchant,
    pageCoupons,
  };
}

export async function scrape(url: string) {
  const target = canonical(url);
  let r = await fetchHtml(target);
  let data = r.status === 200 ? parse(r.html) : null;
  if (!data || data.blocked) {
    r = await renderHtml(target, { waitMs: 2500 });
    data = parse(r.html);
  }
  if (!data || data.blocked) throw new BlockedError(id, data?.blocked ? 'captcha' : `HTTP ${r.status}`);
  return { ...data, externalId: externalId(url) };
}
