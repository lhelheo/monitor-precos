import { log } from './log.ts';

/** Canal de saída das notificações. O bot do Telegram registra o envio aqui ao iniciar. */
let sender: any = null;

export function setSender(fn: any) {
  sender = fn;
}

export async function notify(html: any, opts = {}) {
  if (!sender) {
    log.info(`[notificação] ${html.replace(/<[^>]+>/g, '')}`);
    return false;
  }
  try {
    await sender(html, opts);
    return true;
  } catch (e) {
    log.error(`Falha ao enviar notificação: ${e.message}`);
    return false;
  }
}
