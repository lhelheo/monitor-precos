import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';

const num = (v: any, d: any) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? d : Number(v));
const bool = (v: any, d = false) => (v === undefined || v === '' ? d : /^(1|true|sim|yes)$/i.test(v));

const ROOT = path.resolve(import.meta.dirname, '..');

/** Regras por loja (Pix extra, cashback, cupons que não acumulam etc.). Editável em config/lojas.json. */
function loadStoreRules() {
  const file = path.join(ROOT, 'config', 'lojas.json');
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

export const config = {
  root: ROOT,
  dbPath: process.env.DB_PATH || path.join(ROOT, 'data', 'precos.db'),

  telegram: {
    token: process.env.TELEGRAM_BOT_TOKEN || '',
    chatId: process.env.TELEGRAM_CHAT_ID || '',
    // Leitura de canais de promoção (opcional, usa sua conta via MTProto)
    apiId: num(process.env.TELEGRAM_API_ID, 0),
    apiHash: process.env.TELEGRAM_API_HASH || '',
    session: process.env.TELEGRAM_SESSION || '',
    channels: (process.env.TELEGRAM_PROMO_CHANNELS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  },

  mercadoLivre: {
    clientId: process.env.ML_CLIENT_ID || '',
    clientSecret: process.env.ML_CLIENT_SECRET || '',
  },

  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY || '',
    model: process.env.ANTHROPIC_MODEL || 'claude-opus-5-5',
  },

  web: {
    host: process.env.WEB_HOST || '0.0.0.0',
    port: num(process.env.WEB_PORT, 8080),
    user: process.env.WEB_USER || 'admin',
    password: process.env.WEB_PASSWORD || '',
    publicUrl: process.env.WEB_PUBLIC_URL || '',
  },

  scheduler: {
    // Intervalo padrão entre verificações de um mesmo anúncio
    defaultIntervalMin: num(process.env.CHECK_INTERVAL_MIN, 10),
    // Espaço mínimo entre duas requisições à mesma loja (educação + evitar bloqueio)
    perStoreGapSec: num(process.env.PER_STORE_GAP_SEC, 20),
    // Quantas verificações em paralelo (1 vCPU => 1 ou 2)
    concurrency: num(process.env.CHECK_CONCURRENCY, 1),
    jitterPct: 0.2,
  },

  browser: {
    enabled: bool(process.env.BROWSER_ENABLED, true),
    // Fecha o Chromium após X segundos ocioso para liberar RAM
    idleCloseSec: num(process.env.BROWSER_IDLE_CLOSE_SEC, 0),
  },

  alerts: {
    // Queda mínima (%) abaixo da mediana dos últimos N dias para alertar
    belowMedianPct: num(process.env.ALERT_BELOW_MEDIAN_PCT, 10),
    medianWindowDays: num(process.env.ALERT_MEDIAN_WINDOW_DAYS, 30),
    // Dias mínimos de histórico para considerar "mínima histórica"/mediana confiáveis
    minHistoryDays: num(process.env.ALERT_MIN_HISTORY_DAYS, 3),
    // Não repetir alerta do mesmo produto antes de X horas, a menos que caia mais
    cooldownHours: num(process.env.ALERT_COOLDOWN_HOURS, 12),
    // Considerar cupons "prováveis" (de canais/agregadores) no preço efetivo do alerta
    includeProbableCoupons: bool(process.env.ALERT_INCLUDE_PROBABLE_COUPONS, true),
  },

  user: {
    // Se true, considera cupons de "primeira compra"
    firstPurchase: bool(process.env.USER_FIRST_PURCHASE, false),
    // Assinaturas que mudam preço/frete
    amazonPrime: bool(process.env.USER_AMAZON_PRIME, false),
  },

  promobit: {
    enabled: bool(process.env.PROMOBIT_ENABLED, true),
    intervalMin: num(process.env.PROMOBIT_INTERVAL_MIN, 10),
    maxAgeHours: num(process.env.PROMOBIT_MAX_AGE_HOURS, 48),
  },
  stores: loadStoreRules(),
  // Lojas ativas. MVP: só as que leem a página sem conta, afiliado ou verificação humana.
  // Para ativar outra loja depois, inclua o id dela aqui (mercadolivre, magalu, shopee).
  enabledStores: (process.env.ENABLED_STORES || 'kabum,amazon,zoom').split(',').map((s) => s.trim()).filter(Boolean),
  logLevel: process.env.LOG_LEVEL || 'info',
};
