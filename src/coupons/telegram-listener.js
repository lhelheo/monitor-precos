import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { NewMessage } from 'telegram/events/index.js';
import { config } from '../config.js';
import { log } from '../log.js';
import { ingestText } from './ingest.js';

/**
 * Lê canais públicos de promoção do Telegram (ex.: canais de ofertas/cupons) usando a SUA conta
 * (MTProto). É só leitura: nada é enviado nesses canais.
 * Requer TELEGRAM_API_ID / TELEGRAM_API_HASH (my.telegram.org) e TELEGRAM_SESSION (gerada com `npm run telegram:login`).
 *
 * @param onMatch  chamado quando uma mensagem menciona um produto monitorado: ({ product, text, deal, coupons, channel, link })
 */
export async function startPromoListener(onMatch) {
  const { apiId, apiHash, session, channels } = config.telegram;
  if (!apiId || !apiHash || !session || !channels.length) {
    log.info('Leitor de canais de promoção desativado (configure TELEGRAM_API_ID/HASH/SESSION e TELEGRAM_PROMO_CHANNELS)');
    return null;
  }
  const client = new TelegramClient(new StringSession(session), apiId, apiHash, { connectionRetries: 10 });
  client.setLogLevel('error');
  await client.connect();

  const entities = [];
  for (const ch of channels) {
    try {
      entities.push(await client.getEntity(ch));
    } catch (e) {
      log.warn(`Canal ${ch} não encontrado: ${e.message}`);
    }
  }
  if (!entities.length) {
    log.warn('Nenhum canal de promoção válido');
    return client;
  }

  client.addEventHandler(
    async (event) => {
      const msg = event.message;
      const text = msg?.message;
      if (!text) return;
      const chat = await msg.getChat().catch(() => null);
      const channel = chat?.username || chat?.title || 'canal';
      try {
        const r = await ingestText(text, { source: 'telegram', origin: channel });
        if (r.coupons.length) log.info(`Canal ${channel}: ${r.coupons.length} cupom(ns) salvos (${r.coupons.map((c) => c.code).join(', ')})`);
        const link = chat?.username ? `https://t.me/${chat.username}/${msg.id}` : null;
        for (const product of r.matchedProducts) {
          await onMatch?.({ product, text, deal: r.deal, coupons: r.coupons, channel, link });
        }
      } catch (e) {
        log.warn(`Erro ao processar mensagem de ${channel}: ${e.message}`);
      }
    },
    new NewMessage({ chats: entities.map((e) => e.id) }),
  );
  log.info(`Ouvindo ${entities.length} canal(is) de promoção: ${channels.join(', ')}`);
  return client;
}
