import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import basicAuth from '@fastify/basic-auth';
import path from 'node:path';
import { config } from '../config.ts';
import { listings, prices, products } from '../db.ts';
import { log } from '../log.ts';

/** Painel web do histórico. Protegido por usuário/senha (HTTP Basic). */
export async function startWeb() {
  if (!config.web.password) {
    log.warn('WEB_PASSWORD não definido: painel web desativado por segurança');
    return null;
  }
  const app = Fastify({ logger: false });

  await app.register(basicAuth, {
    authenticate: true,
    validate: async (user, pass) => {
      if (user !== config.web.user || pass !== config.web.password) throw new Error('unauthorized');
    },
  });

  app.addHook('onRequest', app.basicAuth);

  await app.register(fastifyStatic, {
    root: path.join(config.root, 'src', 'web', 'public'),
    prefix: '/',
  });

  app.get('/api/products', async () =>
    products.list().map((p: any) => {
      const ls = listings.byProduct(p.id);
      const best = ls.filter((l: any) => l.last_effective_cents).sort((a: any, b: any) => a.last_effective_cents - b.last_effective_cents)[0];
      return {
        id: p.id,
        name: p.name,
        active: Boolean(p.active),
        targetCents: p.target_cents,
        bestCents: best?.last_effective_cents ?? null,
        listings: ls.map((l: any) => ({
          id: l.id,
          store: l.store,
          title: l.title,
          url: l.url,
          effectiveCents: l.last_effective_cents,
          priceCents: l.last_price_cents,
          inStock: Boolean(l.last_in_stock),
          lastOkAt: l.last_ok_at,
          lastError: l.last_error,
        })),
      };
    }),
  );

  app.get('/api/products/:id/history', async (req, reply) => {
    const id = Number((req as any).params.id);
    const p = products.get(id);
    if (!p) return reply.code(404).send({ error: 'não encontrado' });
    const rows = prices.historyForProduct(id, 0);
    return {
      id,
      name: p.name,
      targetCents: p.target_cents,
      stats: prices.statsForProduct(id, 0),
      points: rows.map((r: any) => ({
        ts: r.ts,
        store: r.store,
        listingId: r.listing_id,
        priceCents: r.price_cents,
        pixCents: r.pix_cents,
        effectiveCents: r.effective_cents,
        confidence: r.effective_confidence,
        inStock: Boolean(r.in_stock),
        couponCode: r.breakdown_json ? JSON.parse(r.breakdown_json)?.coupon?.code ?? null : null,
      })),
    };
  });

  await app.listen({ host: config.web.host, port: config.web.port });
  log.info(`Painel web em http://${config.web.host}:${config.web.port}`);
  return app;
}
