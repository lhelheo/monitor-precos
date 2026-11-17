import { Bot } from 'grammy';
import { config } from './config.ts';
import { coupons, listings, prices, products } from './db.ts';
import { checkListing } from './checker.ts';
import { storeFor, normalizeUrl, STORES } from './stores/index.ts';
import { ingestText } from './coupons/ingest.ts';
import { esc, formatDeal } from './format.ts';
import { setSender } from './notifier.ts';
import { fmt } from './stores/common.ts';
import { log } from './log.ts';

const HELP = `<b>Comandos</b>
/novo &lt;nome&gt; — cria um produto a monitorar
/link &lt;id&gt; &lt;url&gt; — adiciona um anúncio (Kabum, Amazon, Magalu, Mercado Livre ou Shopee)
/alvo &lt;id&gt; &lt;valor&gt; — preço-alvo (ex.: /alvo 1 350)
/palavras &lt;id&gt; &lt;termos&gt; — filtro de busca e de ofertas (ex.: controle dualsense -edge -base)
/faixa &lt;id&gt; &lt;mín&gt; &lt;máx&gt; — faixa de preço aceita (ex.: /faixa 1 250 700)
/lista — produtos e último preço
/historico &lt;id&gt; — resumo do histórico
/check &lt;id&gt; — verifica agora
/cupom &lt;texto&gt; — cadastra um cupom ou cola uma mensagem de promoção
/cupons — cupons ativos
/remover &lt;id&gt; — remove um produto
/ajuda — esta lista`;

function ownerOnly(ctx) {
  return String(ctx.chat?.id) === String(config.telegram.chatId);
}

const parseId = (s) => {
  const n = Number(s);
  return Number.isInteger(n) && n > 0 ? n : null;
};

/** "350", "350,90", "R$ 1.299,90" -> centavos */
function parseMoney(s) {
  const v = String(s).replace(/R\$|\s/g, '').replace(/\./g, '').replace(',', '.');
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : null;
}

export function createBot() {
  if (!config.telegram.token) {
    log.warn('TELEGRAM_BOT_TOKEN não definido: bot desativado');
    return null;
  }
  const bot = new Bot(config.telegram.token);
  const chatId = config.telegram.chatId;

  // Saída de alertas/notificações
  setSender(async (html, opts = {}) => {
    if (!chatId) return;
    await bot.api.sendMessage(chatId, html, { parse_mode: 'HTML', link_preview_options: { is_disabled: opts.disablePreview ?? true } });
  });

  // Só o dono usa o bot
  bot.use(async (ctx, next) => {
    if (!ownerOnly(ctx)) {
      if (ctx.chat) log.warn(`Mensagem de chat não autorizado ignorada (${ctx.chat.id})`);
      return;
    }
    return next();
  });

  const reply = (ctx, text, extra = {}) => ctx.reply(text, { parse_mode: 'HTML', link_preview_options: { is_disabled: true }, ...extra });
  const arg = (ctx) => (ctx.match || '').trim();

  bot.command(['start', 'ajuda'], (ctx) => reply(ctx, HELP));

  bot.command('novo', (ctx) => {
    const name = arg(ctx);
    if (!name) return reply(ctx, 'Uso: /novo &lt;nome do produto&gt;');
    const id = products.create({ name });
    return reply(ctx, `✅ Produto <b>#${id}</b> criado: ${esc(name)}\nAgora adicione anúncios com /link ${id} &lt;url&gt;`);
  });

  bot.command('link', async (ctx) => {
    const [idS, ...rest] = arg(ctx).split(/\s+/);
    const id = parseId(idS);
    const raw = rest.join(' ');
    if (!id || !products.get(id)) return reply(ctx, 'Uso: /link &lt;id do produto&gt; &lt;url&gt;');
    const url = normalizeUrl(raw.trim());
    const store = storeFor(url);
    if (!store) return reply(ctx, 'Loja não suportada. Use links de Kabum, Amazon, Magalu, Mercado Livre ou Shopee.');
    if (listings.byUrl(url)) return reply(ctx, 'Esse anúncio já está cadastrado.');
    const lid = listings.create({ productId: id, store: store.id, url });
    listings.scheduleNow(lid);
    await reply(ctx, `✅ Anúncio #${lid} (${store.name}) adicionado. Verificando agora…`);
    const l = listings.get(lid);
    const r = await checkListing(l, { silent: true });
    if (!r.ok) return reply(ctx, `⚠️ Não consegui ler o anúncio: <code>${esc(r.error)}</code>\nVou tentar de novo automaticamente.`);
    return reply(ctx, `Preço atual: <b>${fmt(r.eff.effectiveCents)}</b> (${esc(r.scraped.title?.slice(0, 80) ?? '')})`);
  });

  bot.command('alvo', (ctx) => {
    const [idS, valS] = arg(ctx).split(/\s+/);
    const id = parseId(idS);
    const cents = parseMoney(valS ?? '');
    if (!id || !products.get(id) || !cents) return reply(ctx, 'Uso: /alvo &lt;id&gt; &lt;valor&gt;  (ex.: /alvo 1 350)');
    products.setTarget(id, cents);
    return reply(ctx, `🎯 Alvo do produto #${id}: ${fmt(cents)}`);
  });

  bot.command('palavras', (ctx) => {
    const [idS, ...rest] = arg(ctx).split(/\s+/);
    const id = parseId(idS);
    if (!id || !products.get(id)) return reply(ctx, 'Uso: /palavras &lt;id&gt; dualsense -edge');
    products.setKeywords(id, rest.join(' ') || null);
    return reply(ctx, `🔎 Filtro do produto #${id}: ${esc(rest.join(' ') || '(nenhum)')}`);
  });

  bot.command('faixa', (ctx) => {
    const [idS, minS, maxS] = arg(ctx).split(/\s+/);
    const id = parseId(idS);
    if (!id || !products.get(id) || !minS || !maxS) return reply(ctx, 'Uso: /faixa <id> <mín> <máx>  (ex.: /faixa 1 250 700; use - para ignorar um dos limites)');
    const min = minS === '-' ? null : parseMoney(minS);
    const max = maxS === '-' ? null : parseMoney(maxS);
    products.setRange(id, min, max);
    return reply(ctx, `💲 Faixa do produto #${id}: ${min ? fmt(min) : 'sem mínimo'} a ${max ? fmt(max) : 'sem máximo'}`);
  });

  bot.command('lista', (ctx) => {
    const ps = products.list();
    if (!ps.length) return reply(ctx, 'Nenhum produto ainda. Use /novo.');
    const out = ps.map((p) => {
      const ls = listings.byProduct(p.id);
      const best = ls.filter((l) => l.last_effective_cents).sort((a, b) => a.last_effective_cents - b.last_effective_cents)[0];
      const status = !p.active ? '⏸' : best ? `${fmt(best.last_effective_cents)} (${STORES[best.store]?.name})` : 'sem leitura';
      return `#${p.id} <b>${esc(p.name)}</b> — ${status}${p.target_cents ? ` · alvo ${fmt(p.target_cents)}` : ''} · ${ls.length} anúncio(s)`;
    });
    return reply(ctx, out.join('\n'));
  });

  bot.command('historico', (ctx) => {
    const id = parseId(arg(ctx));
    const p = id && products.get(id);
    if (!p) return reply(ctx, 'Uso: /historico &lt;id&gt;');
    const lines = listings.byProduct(p.id).map((l) =>
      `${STORES[l.store]?.name}: atual ${fmt(l.last_effective_cents)}${l.last_ok_at ? '' : ' (sem leitura ainda)'}`,
    );
    const s = prices.statsForProduct(p.id, 0);
    const summary = s ? `\nMínimo ${fmt(s.min)} · mediana ${fmt(s.median)} · máximo ${fmt(s.max)} (${s.count} leituras)` : '';
    const link = config.web.publicUrl ? `\n${config.web.publicUrl}/#p${p.id}` : '';
    return reply(ctx, `<b>${esc(p.name)}</b>\n${lines.join('\n')}${summary}${link}`);
  });

  bot.command('check', async (ctx) => {
    const id = parseId(arg(ctx));
    if (!id || !products.get(id)) return reply(ctx, 'Uso: /check &lt;id&gt;');
    const ls = listings.byProduct(id);
    await reply(ctx, `Verificando ${ls.length} anúncio(s)…`);
    for (const l of ls) {
      const r = await checkListing(l, { silent: true });
      const msg = r.ok ? `${STORES[l.store]?.name}: <b>${fmt(r.eff.effectiveCents)}</b>` : `${STORES[l.store]?.name}: erro ${esc(r.error)}`;
      await reply(ctx, msg);
    }
  });

  bot.command('cupom', async (ctx) => {
    const text = arg(ctx);
    if (!text) return reply(ctx, 'Uso: /cupom &lt;texto do cupom ou mensagem de promoção&gt;');
    const r = await ingestText(text, { source: 'manual' });
    if (!r.coupons.length && !r.deal) return reply(ctx, 'Não encontrei cupom nem produto nessa mensagem.');
    const codes = r.coupons.map((c) => `<code>${esc(c.code)}</code> (${esc(c.store)})`).join(', ') || 'nenhum código';
    await reply(ctx, `🎟️ Cupons salvos: ${codes}`);
    for (const product of r.matchedProducts) {
      await reply(ctx, formatDeal({ product, text, deal: r.deal, coupons: r.coupons, channel: 'manual' }));
    }
    // reverifica os anúncios das lojas dos cupons agora
    for (const c of r.coupons) {
      for (const l of listings.all().filter((x) => x.store === c.store && x.active)) listings.scheduleNow(l.id);
    }
  });

  bot.command('cupons', (ctx) => {
    const list = coupons.list(true);
    if (!list.length) return reply(ctx, 'Nenhum cupom ativo.');
    return reply(
      ctx,
      list
        .slice(0, 30)
        .map((c) => `<code>${esc(c.code ?? '—')}</code> ${esc(c.store)} · ${esc(c.kind === 'pct' ? c.value + '%' : fmt(c.value * 100))} · ${c.confidence}`)
        .join('\n'),
    );
  });

  bot.command('remover', (ctx) => {
    const id = parseId(arg(ctx));
    if (!id || !products.get(id)) return reply(ctx, 'Uso: /remover &lt;id&gt;');
    products.remove(id);
    return reply(ctx, `🗑️ Produto #${id} removido.`);
  });

  bot.on('message:text', (ctx) => reply(ctx, 'Não entendi. Use /ajuda para ver os comandos.'));
  bot.catch((err) => {
    const e = /** @type {any} */ (err);
    log.error(`Bot: ${e.error?.message || e.message}`);
  });
  return bot;
}
