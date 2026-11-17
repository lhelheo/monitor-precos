import { log } from './log.ts';

/** Canal de saída das notificações. O bot do Telegram registra o envio aqui ao iniciar. */
let sender: ((html: string, opts?: { disablePreview?: boolean }) => Promise<unknown>) | null = null;

export function setSender(fn: ((html: string, opts?: { disablePreview?: boolean }) => Promise<unknown>) | null) {
  sender = fn;
}

export async function notify(html: string, opts: { disablePreview?: boolean } = {}) {
  if (!sender) {
    log.info(`[notificação] ${html.replace(/<[^>]+>/g, '')}`);
    return false;
  }
  try {
    await sender(html, opts);
    return true;
  } catch (e) {
    log.error(`Falha ao enviar notificação: ${(e as Error).message}`);
    return false;
  }
}
