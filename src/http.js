import { config } from './config.js';
import { log } from './log.js';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36';

const HEADERS = {
  'user-agent': UA,
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'accept-language': 'pt-BR,pt;q=0.9,en-US;q=0.6,en;q=0.5',
};

/** GET simples. Devolve { status, url, html }. */
export async function fetchHtml(url, { timeoutMs = 25000, headers = {} } = {}) {
  const res = await fetch(url, {
    headers: { ...HEADERS, ...headers },
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
  });
  const html = await res.text();
  return { status: res.status, url: res.url, html };
}

export async function fetchJson(url, { timeoutMs = 20000, headers = {} } = {}) {
  const res = await fetch(url, {
    headers: { 'user-agent': UA, accept: 'application/json', ...headers },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = await res.text();
  let json = null;
  try {
    json = JSON.parse(body);
  } catch {
    /* corpo não-JSON */
  }
  return { status: res.status, json, body };
}

// ---------------------------------------------------------------------------
// Navegador (Playwright) compartilhado. Abre sob demanda e fecha quando ocioso,
// para não ocupar ~300 MB de RAM o tempo todo numa VPS pequena.
// ---------------------------------------------------------------------------
let browserPromise = null;
let idleTimer = null;
let inUse = 0;

async function getBrowser() {
  if (!config.browser.enabled) throw new Error('Navegador desativado (BROWSER_ENABLED=false)');
  if (!browserPromise) {
    const { chromium } = await import('playwright');
    log.info('Abrindo Chromium');
    browserPromise = chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  }
  return browserPromise;
}

function scheduleIdleClose() {
  clearTimeout(idleTimer);
  // 0 (padrão) = nunca fecha por ociosidade
  if (!(config.browser.idleCloseSec > 0)) return;
  idleTimer = setTimeout(async () => {
    if (inUse > 0 || !browserPromise) return;
    const b = await browserPromise.catch(() => null);
    browserPromise = null;
    await b?.close().catch(() => {});
    log.info('Chromium fechado por ociosidade');
  }, config.browser.idleCloseSec * 1000);
}

/**
 * Abre a URL num navegador real e devolve o HTML renderizado.
 * `onResponse(response)` permite capturar respostas JSON de APIs internas da página.
 * @param {string} url
 * @param {{ waitMs?: number, timeoutMs?: number, onResponse?: (res: any) => any }} [opts]
 */
export async function renderHtml(url, { waitMs = 3500, timeoutMs = 45000, onResponse } = {}) {
  inUse++;
  clearTimeout(idleTimer);
  let context;
  try {
    const browser = await getBrowser();
    context = await browser.newContext({ locale: 'pt-BR', userAgent: UA, viewport: { width: 1366, height: 900 } });
    const page = await context.newPage();
    // economiza banda/CPU: não baixa imagens, fontes e mídia
    await page.route('**/*', (route) => {
      const t = route.request().resourceType();
      return ['image', 'media', 'font'].includes(t) ? route.abort() : route.continue();
    });
    if (onResponse) page.on('response', onResponse);
    const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    await page.waitForTimeout(waitMs);
    return { status: res?.status() ?? 0, url: page.url(), html: await page.content() };
  } finally {
    await context?.close().catch(() => {});
    inUse--;
    scheduleIdleClose();
  }
}

export async function closeBrowser() {
  clearTimeout(idleTimer);
  const b = await browserPromise?.catch(() => null);
  browserPromise = null;
  await b?.close().catch(() => {});
}
