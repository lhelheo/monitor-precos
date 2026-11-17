import { detectStore } from './parser.ts';

/**
 * Mensagem com cara de oferta: tem preço, cupom ou link de loja. Conversa comum de grupo fica de fora.
 */
export function isOfferMessage(text: string | null | undefined): boolean {
  if (!text) return false;
  return /R\$\s*\d/.test(text) || /cupo[mn]|c[oó]digo/i.test(text) || detectStore(text) !== null;
}

/**
 * Link da mensagem. Canal público tem @nome (t.me/nome/123); grupo e canal privado usam t.me/c/<id>/123,
 * que abre normalmente para quem é membro. O ID do Telegram vem com prefixo -100, que é removido.
 */
export function messageLink(
  username: string | null | undefined,
  chatId: string | number | null | undefined,
  msgId: number,
): string | null {
  if (username) return `https://t.me/${username}/${msgId}`;
  if (chatId === null || chatId === undefined || chatId === '') return null;
  const id = String(chatId).replace(/^-100/, '').replace(/^-/, '');
  return id ? `https://t.me/c/${id}/${msgId}` : null;
}

/**
 * Chave de deduplicação: a mesma oferta (produto + preço anunciado) vale uma vez por dia,
 * mesmo que circule em vários grupos. Sem preço, usa o início do texto.
 */
export function offerKey(productId: number, finalCents: number | null | undefined, text: string, day: string): string {
  return `${productId}|${finalCents ?? text.slice(0, 80)}|${day}`;
}
