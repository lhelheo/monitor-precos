// Lista seus grupos e canais do Telegram com o ID para usar em TELEGRAM_PROMO_CHANNELS. Rode: `npm run telegram:chats`
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { config } from '../config.ts';

interface Dialog {
  id?: { toString(): string };
  title?: string;
  isGroup?: boolean;
  isChannel?: boolean;
  entity?: { username?: string };
}

const { apiId, apiHash, session } = config.telegram;
if (!apiId || !apiHash || !session) {
  console.error('Configure TELEGRAM_API_ID, TELEGRAM_API_HASH e TELEGRAM_SESSION no .env (ver npm run telegram:login).');
  process.exit(1);
}

const client = new TelegramClient(new StringSession(session), apiId, apiHash, { connectionRetries: 5 });
await client.connect();
const dialogs = (await client.getDialogs({ limit: 1000 })) as unknown as Dialog[];

const rows = dialogs
  .filter((d) => d.isGroup || d.isChannel)
  .map((d) => ({
    tipo: d.isGroup ? 'grupo' : 'canal',
    id: d.id?.toString() ?? '',
    nome: d.title ?? '(sem nome)',
    username: d.entity?.username ?? '',
  }))
  .sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));

if (!rows.length) console.log('Nenhum grupo ou canal encontrado nesta conta.');
for (const r of rows) {
  console.log(`${r.tipo.padEnd(6)} ${r.id.padEnd(16)} ${r.nome}${r.username ? ` (@${r.username})` : ''}`);
}
console.log('\nColoque os IDs (ou @nomes) desejados em TELEGRAM_PROMO_CHANNELS, separados por vírgula.');

await client.disconnect();
process.exit(0);
