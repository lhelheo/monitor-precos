// Gera a TELEGRAM_SESSION para o leitor de canais de promoção. Rode uma vez: `npm run telegram:login`
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { config } from '../config.js';

const rl = readline.createInterface({ input, output });
const apiId = config.telegram.apiId || Number(await rl.question('TELEGRAM_API_ID: '));
const apiHash = config.telegram.apiHash || (await rl.question('TELEGRAM_API_HASH: '));

const client = new TelegramClient(new StringSession(''), apiId, apiHash, { connectionRetries: 5 });
await client.start({
  phoneNumber: () => rl.question('Seu telefone (+55...): '),
  password: () => rl.question('Senha de 2 etapas (se tiver): '),
  phoneCode: () => rl.question('Código recebido no Telegram: '),
  onError: (e) => console.error(e.message),
});
console.log('\nCole esta linha no seu .env:\n');
console.log(`TELEGRAM_SESSION=${client.session.save()}\n`);
await client.disconnect();
rl.close();
process.exit(0);
