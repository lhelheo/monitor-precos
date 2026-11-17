// Carrega todos os módulos sem iniciar o sistema: pega imports quebrados e nomes errados.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(here, '..', 'src');
// index.js e as CLIs iniciam o sistema ao carregar; ficam de fora
const SKIP = new Set([
  'index.js', 'index.ts', 'telegram-login.js', 'telegram-login.ts', 'telegram-chats.js', 'telegram-chats.ts', 'check.js', 'check.ts',
]);

function listar(dir) {
  return readdirSync(dir).flatMap((f) => {
    const p = path.join(dir, f);
    if (statSync(p).isDirectory()) return listar(p);
    return /\.(js|ts)$/.test(f) && !f.endsWith('.d.ts') && !SKIP.has(f) ? [p] : [];
  });
}

for (const arquivo of listar(src)) {
  test(`carrega ${path.relative(src, arquivo)}`, async () => {
    const mod = await import(pathToFileURL(arquivo).href);
    assert.ok(mod && typeof mod === 'object');
  });
}
