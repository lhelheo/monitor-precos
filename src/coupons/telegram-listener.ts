import { TelegramClient } from 'telegram';
import type { ProductRow } from '../types.ts';
import type { CouponWrite } from '../db.ts';
import type { DealInfo } from './parser.ts';
import { StringSession } from 'telegram/sessions/index.js';
import { NewMessage } from 'telegram/events/index.js';
import { config } from '../config.ts';
import { log } from '../log.ts';
import { kv } from '../db.ts';
import { ingestText } from './ingest.ts';
import { isOfferMessage, messageLink } from './offers.ts';

/**
 * Lê canais e grupos de promoção do Telegram usando a SUA conta (MTProto). É só leitura: nada é enviado.
 * Requer TELEGRAM_API_ID / TELEGRAM_API_HASH (my.telegram.org) e TELEGRAM_SESSION (gerada com `npm run telegram:login`).
 *
 * Duas formas de receber mensagens, para não depender de uma só:
 * - em tempo real, pelo evento do Telegram;
 * - conferência a cada POLL_MS, lendo as mensagens novas de cada conversa (cobre o que o evento não entregar).
 * Uma mesma mensagem pode chegar pelas duas vias; o aviso não se repete por causa da deduplicação diária.
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
  /** foto da mensagem original, quando ela tem uma (baixada só se a mensagem casar com um produto) */
  image: Buffer | null;
}) => Promise<void> | void;

/** Conversa do Telegram (canal, grupo ou privada) vista pela conta. */
interface Dialog {
  id?: { toString(): string };
  title?: string;
  entity?: { username?: string };
}

/** Intervalo da leitura de conferência. */
const POLL_MS = 2 * 60_000;
/** Mensagens novas lidas por conversa a cada conferência. */
const POLL_LIMIT = 50;

type Entity = Parameters<TelegramClient['getMessages']>[0];
/** Mensagem do Telegram que pode conter foto. */
type MediaMsg = Parameters<TelegramClient['downloadMedia']>[0];
const hasPhoto = (m: unknown) => Boolean((m as { photo?: unknown } | null)?.photo);
/** Identificador aceito pelo filtro de mensagens (NewMessage chats). */
type ChatId = NonNullable<NonNullable<ConstructorParameters<typeof NewMessage>[0]>['chats']>[number];

interface Watched {
  key: string; // o que está no .env, usado para guardar até onde já foi lido
  entity: Entity;
  id: ChatId;
  label: string;
  markedId: string | null; // ID com prefixo -100, usado no link t.me/c
  username: string | null;
}

interface ChatInfo {
  markedId: string | null;
  username: string | null;
  title: string | null;
}

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
  const watched: Watched[] = [];
  for (const ch of channels) {
    const ref = ch.replace(/^@/, '');
    const found = dialogs.find((d) => d.id?.toString() === ref || (d.entity?.username ?? '').toLowerCase() === ref.toLowerCase());
    if (found?.entity) {
      const entity = found.entity as unknown as Entity;
      watched.push({
        key: ch,
        entity,
        id: (found.entity as unknown as { id: ChatId }).id,
        label: found.entity.username || found.title || ch,
        markedId: found.id?.toString() ?? null,
        username: found.entity.username ?? null,
      });
    } else if (/^-?\d+$/.test(ref)) {
      log.warn(`Grupo ${ch} não está entre as suas conversas do Telegram`);
    } else {
      try {
        const entity = (await client.getEntity(ref)) as unknown as Entity & { id: ChatId };
        watched.push({ key: ch, entity, id: entity.id, label: ref, markedId: null, username: ref });
      } catch (e) {
        log.warn(`Canal ${ch} não encontrado: ${(e as Error).message}`);
      }
    }
  }
  if (!watched.length) {
    log.warn('Nenhum canal de promoção válido');
    return client;
  }

  /** Analisa uma mensagem (vinda do evento ou da conferência) e chama onMatch para cada produto citado. */
  const handle = async (msgId: number, text: string, chat: ChatInfo, media: MediaMsg | null) => {
    const channel = chat.username || chat.title || 'canal';
    // conversa comum de grupo (sem preço, cupom nem link de loja) nem é analisada
    if (!isOfferMessage(text)) return;
    try {
      const r = await ingestText(text, { source: 'telegram', origin: channel });
      if (r.coupons.length) log.info(`Canal ${channel}: ${r.coupons.length} cupom(ns) salvos (${r.coupons.map((c) => c.code).join(', ')})`);
      log.info(`Oferta de ${channel}: ${r.matchedProducts.length} produto(s) casado(s)`);
      if (!r.matchedProducts.length) return;
      const link = messageLink(chat.username, chat.markedId, msgId);
      // a foto só é baixada quando a oferta casa com um produto
      let image: Buffer | null = null;
      if (media && hasPhoto(media)) {
        try {
          const data = await client.downloadMedia(media, {});
          image = data instanceof Buffer ? data : null;
        } catch (e) {
          log.warn(`Foto de ${channel} não baixada: ${(e as Error).message}`);
        }
      }
      for (const product of r.matchedProducts) {
        await onMatch?.({ product, text, deal: r.deal, coupons: r.coupons, channel, link, image });
      }
    } catch (e) {
      log.warn(`Erro ao processar mensagem de ${channel}: ${(e as Error).message}`);
    }
  };

  // evento em tempo real
  client.addEventHandler(
    async (event) => {
      const msg = event.message;
      const text = msg?.message;
      if (!text) return;
      const chat = (await msg.getChat().catch((): null => null)) as unknown as { id?: { toString(): string }; username?: string; title?: string } | null;
      await handle(
        msg.id,
        text,
        { markedId: chat?.id?.toString() ?? null, username: chat?.username ?? null, title: chat?.title ?? null },
        msg as unknown as MediaMsg,
      );
    },
    new NewMessage({ chats: watched.map((w) => w.id) }),
  );

  // conferência periódica: lê só as mensagens novas desde a última leitura de cada conversa
  const pollOnce = async () => {
    for (const w of watched) {
      const key = `tg_last:${w.key}`;
      try {
        const stored = kv.get(key);
        if (stored === undefined) {
          // primeira vez: marca o ponto atual, sem analisar o histórico antigo
          const [latest] = await client.getMessages(w.entity, { limit: 1 });
          kv.set(key, String(latest?.id ?? 0));
          continue;
        }
        const msgs = await client.getMessages(w.entity, { limit: POLL_LIMIT, minId: Number(stored) });
        if (!msgs.length) continue;
        const ordered = [...msgs].sort((a, b) => a.id - b.id);
        log.info(`Conferência de ${w.label}: ${ordered.length} mensagem(ns) nova(s)`);
        for (const m of ordered) {
          if (m.message) await handle(m.id, m.message, { markedId: w.markedId, username: w.username, title: w.label }, m as unknown as MediaMsg);
        }
        kv.set(key, String(ordered[ordered.length - 1].id));
      } catch (e) {
        log.warn(`Conferência de ${w.label} falhou: ${(e as Error).message}`);
      }
    }
  };
  setInterval(() => void pollOnce(), POLL_MS);
  setTimeout(() => void pollOnce(), 15_000);

  log.info(`Ouvindo ${watched.length} canal(is) de promoção: ${channels.join(', ')} (conferência a cada ${POLL_MS / 60_000} min)`);
  return client;
}
