import { TelegramClient } from 'telegram';
import type { ProductRow } from '../types.ts';
import type { CouponWrite } from '../db.ts';
import type { DealInfo } from './parser.ts';
import { StringSession } from 'telegram/sessions/index.js';
import { NewMessage } from 'telegram/events/index.js';
import { config } from '../config.ts';
import { log } from '../log.ts';
import { ingestText } from './ingest.ts';
import { isOfferMessage, messageLink } from './offers.ts';

/** Conversa do Telegram (canal, grupo ou privada) vista pela conta. */
interface Dialog {
  id?: { toString(): string };
  entity?: { username?: string };
}

/**
 * Lê canais públicos de promoção do Telegram (ex.: canais de ofertas/cupons) usando a SUA conta
 * (MTProto). É só leitura: nada é enviado nesses canais.
 * Requer TELEGRAM_API_ID / TELEGRAM_API_HASH (my.telegram.org) e TELEGRAM_SESSION (gerada com `npm run telegram:login`).
 *
 * @param onMatch  chamado quando uma mensagem menciona um produto monitorado: ({ product, text, deal, coupons, channel, link })
 */
export type PromoMatchHandler = (m: {
  product: ProductRow;
  text: string;
  deal: DealInfo | null;
  coupons: CouponWrite[];
  channel: string;
  link: string | null;
}) => Promise<void> | void;

export async function startPromoListener(onMatch: PromoMatchHandler | undefined) {
  const { apiId, apiHash, session, channels } = config.telegram;
  if (!apiId || !apiHash || !session || !channels.length) {
    log.info('Leitor de canais de promoção desativado (configure TELEGRAM_API_ID/HASH/SESSION e TELEGRAM_PROMO_CHANNELS)');
    return null;
  }
  const client = new TelegramClient(new StringSession(session), apiId, apiHash, { connectionRetries: 10 });
  client.setLogLevel('error' as Parameters<typeof client.setLogLevel>[0]);
  await client.connect();

  // grupos privados não têm @nome: são localizados pelo ID entre as suas conversas (ver npm run telegram:chats)
  const dialogs = (await client.getDialogs({ limit: 1000 }).catch(() => [])) as unknown as Dialog[];
  // identificador aceito pelo filtro de mensagens (NewMessage chats)
  type Chat = NonNullable<NonNullable<ConstructorParameters<typeof NewMessage>[0]>['chats']>[number];
  const entities: Array<{ id: Chat }> = [];
  for (const ch of channels) {
    const ref = ch.replace(/^@/, '');
    const found = dialogs.find((d) => d.id?.toString() === ref || (d.entity?.username ?? '').toLowerCase() === ref.toLowerCase());
    if (found?.entity) {
      entities.push(found.entity as unknown as { id: Chat });
    } else if (/^-?\d+$/.test(ref)) {
      log.warn(`Grupo ${ch} não está entre as suas conversas do Telegram`);
    } else {
      try {
        entities.push((await client.getEntity(ref)) as unknown as { id: Chat });
      } catch (e) {
        log.warn(`Canal ${ch} não encontrado: ${(e as Error).message}`);
      }
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
      // conversa comum de grupo (sem preço, cupom nem link de loja) nem é analisada
      if (!text || !isOfferMessage(text)) return;
      const chat = (await msg.getChat().catch((): null => null)) as unknown as { id?: { toString(): string }; username?: string; title?: string } | null;
      const channel = chat?.username || chat?.title || 'canal';
      try {
        const r = await ingestText(text, { source: 'telegram', origin: channel });
        if (r.coupons.length) log.info(`Canal ${channel}: ${r.coupons.length} cupom(ns) salvos (${r.coupons.map((c) => c.code).join(', ')})`);
        const link = messageLink(chat?.username, chat?.id?.toString(), msg.id);
        for (const product of r.matchedProducts) {
          await onMatch?.({ product, text, deal: r.deal, coupons: r.coupons, channel, link });
        }
      } catch (e) {
        log.warn(`Erro ao processar mensagem de ${channel}: ${(e as Error).message}`);
      }
    },
    new NewMessage({ chats: entities.map((e) => e.id) }),
  );
  log.info(`Ouvindo ${entities.length} canal(is) de promoção: ${channels.join(', ')}`);
  return client;
}
