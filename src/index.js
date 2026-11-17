import { config } from './config.js';
import { openDb, closeDb } from './db.js';
import { log } from './log.js';
import { startScheduler } from './scheduler.js';
import { createBot } from './bot.js';
import { startWeb } from './web/server.js';
import { startPromoListener } from './coupons/telegram-listener.js';
import { formatDeal } from './format.js';
import { notify } from './notifier.js';
import { closeBrowser } from './http.js';

openDb();
log.info('Monitor de preços iniciado');

const bot = createBot();
if (bot) {
  bot.start({ onStart: (me) => log.info(`Bot @${me.username} online`) });
}

const web = await startWeb().catch((e) => {
  log.error(`Painel web não iniciou: ${e.message}`);
  return null;
});

const scheduler = startScheduler();

const promo = await startPromoListener(async ({ product, text, deal, coupons, channel, link }) => {
  await notify(formatDeal({ product, text, deal, coupons, channel, link }));
}).catch((e) => {
  log.error(`Leitor de canais não iniciou: ${e.message}`);
  return null;
});

async function shutdown(sig) {
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
process.on('unhandledRejection', (e) => log.error(`Promise rejeitada: ${/** @type {any} */ (e)?.stack || e}`));
