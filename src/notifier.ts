import { log } from './log.ts';

/** Canal de saída das notificações. O bot do Telegram registra o envio aqui ao iniciar. */
let sender: ((html: string, opts?: { disablePreview?: boolean }) => Promise<unknown>) | null = null;

export function setSender(fn: ((html: string, opts?: { disablePreview?: boolean }) => Promise<unknown>) | null) {
  sender = fn;
}

/** Saída de fotos com legenda (anúncios de canais/grupos que trazem imagem). */
type PhotoSender = (photo: Buffer, caption: string) => Promise<unknown>;
let photoSender: PhotoSender | null = null;

export function setPhotoSender(fn: PhotoSender | null) {
  photoSender = fn;
}

/** Envia a foto com legenda. Devolve false se não deu, para o chamador mandar só o texto. */
export async function notifyPhoto(photo: Buffer, caption: string): Promise<boolean> {
  if (!photoSender) return false;
  try {
    await photoSender(photo, caption);
    return true;
  } catch (e) {
    log.error(`Falha ao enviar foto: ${(e as Error).message}`);
    return false;
  }
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
