import { config } from './config.ts';
import { openDb, closeDb, seen } from './db.ts';
import { offerKey } from './coupons/offers.ts';
import { log } from './log.ts';
import { startScheduler } from './scheduler.ts';
import { createBot } from './bot.ts';
import { startWeb } from './web/server.ts';
import { startPromoListener } from './coupons/telegram-listener.ts';
import { formatDeal } from './format.ts';
import { notify } from './notifier.ts';
import { closeBrowser } from './http.ts';

openDb();
log.info('Monitor de preços iniciado');

const bot = createBot();
if (bot) {
  bot.start({ onStart: (me) => log.info(`Bot @${me.username} online`) });
}

const web = await startWeb().catch((e: unknown) => {
  log.error(`Painel web não iniciou: ${(e as Error).message}`);
  return null;
});

const scheduler = startScheduler();

const promo = await startPromoListener(async ({ product, text, deal, coupons, channel, link }) => {
  // a mesma oferta pode circular em vários grupos: avisa uma vez por dia
  const day = new Date().toISOString().slice(0, 10);
  if (!seen.markNew('offer', offerKey(product.id, deal?.finalCents ?? null, text, day))) return;
  await notify(formatDeal({ product, text, deal, coupons, channel, link }));
}).catch((e: unknown) => {
  log.error(`Leitor de canais não iniciou: ${(e as Error).message}`);
  return null;
});

async function shutdown(sig: string): Promise<void> {
  log.info(`Encerrando (${sig})`);
  scheduler.stop();
  await bot?.stop();
  await web?.close();
  await promo?.disconnect();
  await closeBrowser();
  closeDb();
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (e: unknown) => log.error(`Promise rejeitada: ${(e as Error | undefined)?.stack || e}`));
