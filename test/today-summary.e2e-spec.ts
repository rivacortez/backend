import { Test } from '@nestjs/testing';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import request from 'supertest';
import { App } from 'supertest/types';
import { PrismaClient } from '@prisma/client';
import { hash } from 'bcryptjs';
import { z } from 'zod';
import { AppModule } from './../src/app.module';
import { apiResponseSchema, authTokensSchema } from './../src/shared';

// No se importa `src/billing/lima-day.util` a propósito (el e2e no reimplementa
// ni reutiliza lógica interna de un módulo — mismo criterio de otros e2e-spec
// del repo, que solo importan `src/shared`/`src/app.module`). El día se valida
// con una regex `YYYY-MM-DD`; el "ayer" se simula retrocediendo 25h (margen
// > 24h, garantiza cruzar la medianoche Lima sin depender de esa lógica).
const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MS_25H = 25 * 60 * 60 * 1000;

// QA-07 (bugfix, reporte QA usuario final pre-demo) · La card "HOY" de
// Comprobantes mostraba S/144,888 (acumulado histórico: cierre Z anterior
// 140,026 + turno actual 4,862), no el día. Root cause: el frontend sumaba
// `GET /api/sales` COMPLETO (listado histórico del módulo, sin ventana de
// fecha — correcto para la grilla, pero NO para una card "Hoy") y lo
// etiquetaba "Hoy". Este endpoint (`GET /api/sales/today-summary`) calcula el
// agregado del DÍA CALENDARIO en America/Lima server-side. Este archivo
// simula el cruce de medianoche (una venta de "ayer" que NO debe contarse).

const adminUrl = process.env.DATABASE_URL_ADMIN;
if (!adminUrl) {
  throw new Error('DATABASE_URL_ADMIN no está definido (ver .env)');
}

const TRUNCATE =
  'TRUNCATE TABLE "cash_closes","payments","sales","order_items","orders","dining_tables","zones","menu_modifiers","menu_availability","menu_items","menu_categories","recipe_versions","recipe_items","recipes","product_suppliers","suppliers","ingredients","categories","units_of_measure","audit_logs","refresh_tokens","users","tenants" CASCADE';

describe('Sales today-summary QA-07 (e2e)', () => {
  let app: NestFastifyApplication<App>;
  const admin = new PrismaClient({ datasources: { db: { url: adminUrl } } });
  const password = 'Secret12345';
  const tokensSchema = apiResponseSchema(authTokensSchema);
  const idSchema = apiResponseSchema(z.object({ id: z.uuid() }));
  const orderSchema = apiResponseSchema(z.object({ id: z.uuid() }));
  const paySchema = apiResponseSchema(
    z.object({ sale: z.object({ id: z.uuid(), total: z.string() }) }),
  );
  const summarySchema = apiResponseSchema(
    z.object({ date: z.string(), total: z.string(), count: z.number() }),
  );

  let ownerToken = '';
  let staffToken = '';

  const login = async (email: string): Promise<string> => {
    const res = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email, password })
      .expect(200);
    return tokensSchema.parse(res.body).data.accessToken;
  };
  const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
  const get = (path: string, token: string) =>
    request(app.getHttpServer()).get(path).set(bearer(token));
  const post = (path: string, token: string, body: unknown) =>
    request(app.getHttpServer()).post(path).set(bearer(token)).send(body);

  let zoneId = '';
  let menuItemId = ''; // precio 118
  let tableSeq = 0;

  const openAndPay = async (): Promise<string> => {
    tableSeq += 1;
    const tableId = idSchema.parse(
      (
        await post('/api/tables', ownerToken, {
          zoneId,
          code: `T${tableSeq}`,
          capacity: 4,
        }).expect(201)
      ).body,
    ).data.id;
    const orderId = orderSchema.parse(
      (
        await post('/api/orders', staffToken, { tableId, guests: 2 }).expect(
          201,
        )
      ).body,
    ).data.id;
    await post(`/api/orders/${orderId}/items`, staffToken, {
      items: [{ menuItemId, qty: 1 }],
    }).expect(201);
    const { sale } = paySchema.parse(
      (
        await post(`/api/orders/${orderId}/pay`, staffToken, {
          payments: [{ method: 'cash', amount: 118 }],
        }).expect(201)
      ).body,
    ).data;
    return sale.id;
  };

  beforeAll(async () => {
    await admin.$connect();
    await admin.$executeRawUnsafe(TRUNCATE);
    const tenant = await admin.tenant.create({
      data: { name: 'Motif Today', igvRate: 0.18 },
    });
    const passwordHash = await hash(password, 4);
    await admin.user.create({
      data: {
        tenantId: tenant.id,
        email: 'owner@today.pe',
        name: 'O',
        passwordHash,
        roles: ['owner'],
      },
    });
    await admin.user.create({
      data: {
        tenantId: tenant.id,
        email: 'staff@today.pe',
        name: 'S',
        passwordHash,
        roles: ['staff'],
      },
    });
    const mf = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = mf.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );
    app.setGlobalPrefix('api');
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    ownerToken = await login('owner@today.pe');
    staffToken = await login('staff@today.pe');

    zoneId = idSchema.parse(
      (await post('/api/zones', ownerToken, { name: 'Salón' }).expect(201))
        .body,
    ).data.id;
    const ingId = idSchema.parse(
      (
        await post('/api/ingredients', ownerToken, {
          sku: 'QUE',
          name: 'Queso',
          type: 'raw',
          unit: 'kg',
          unitCost: 10,
        }).expect(201)
      ).body,
    ).data.id;
    const recipeId = idSchema.parse(
      (
        await post('/api/recipes', ownerToken, {
          name: 'Pizza',
          kind: 'dish',
          yield: 1,
          items: [{ ingredientId: ingId, qty: 1 }],
        }).expect(201)
      ).body,
    ).data.id;
    menuItemId = idSchema.parse(
      (
        await post('/api/menu/items', ownerToken, {
          recipeId,
          name: 'Pizza Margarita',
          price: 118,
        }).expect(201)
      ).body,
    ).data.id;
  });

  afterAll(async () => {
    await admin.$executeRawUnsafe(TRUNCATE);
    await admin.$disconnect();
    await app.close();
  });

  it('sin ventas → total 0.00, count 0, date = hoy en Lima', async () => {
    const summary = summarySchema.parse(
      (await get('/api/sales/today-summary', staffToken).expect(200)).body,
    ).data;
    expect(summary.total).toBe('0.00');
    expect(summary.count).toBe(0);
    expect(summary.date).toMatch(DAY_KEY_RE);
  });

  it('QA-07: una venta de "ayer" (cruza medianoche Lima) NO se cuenta en "hoy" — solo el turno actual', async () => {
    // Venta 1: se emite normalmente (issuedAt = now), y LUEGO se "retrocede" su
    // fecha 25h (garantiza cruzar la medianoche Lima, sin depender de la lógica
    // interna del módulo) — simula el acumulado histórico/cierre Z pasado que
    // el bug sumaba incorrectamente.
    const staleSaleId = await openAndPay();
    await admin.sale.update({
      where: { id: staleSaleId },
      data: { issuedAt: new Date(Date.now() - MS_25H) },
    });

    // Venta 2: del turno ACTUAL (issuedAt = now, sin tocar).
    await openAndPay();

    const summary = summarySchema.parse(
      (await get('/api/sales/today-summary', staffToken).expect(200)).body,
    ).data;
    // Si el bug siguiera vigente (sumar TODO el histórico), total sería 236.00
    // (2×118). El fix debe contar SOLO la venta de hoy → 118.00.
    expect(summary.total).toBe('118.00');
    expect(summary.count).toBe(1);
    expect(summary.date).toMatch(DAY_KEY_RE);
  });

  it('una venta anulada (void) no suma al total "hoy" (mismo criterio que el cierre Z)', async () => {
    const saleId = await openAndPay();
    await post(`/api/sales/${saleId}/void`, ownerToken, {
      reason: 'Error de cobro',
    }).expect(201);

    const before = summarySchema.parse(
      (await get('/api/sales/today-summary', staffToken).expect(200)).body,
    ).data;
    await openAndPay(); // venta issued adicional del día
    const after = summarySchema.parse(
      (await get('/api/sales/today-summary', staffToken).expect(200)).body,
    ).data;
    // El total solo crece por la venta issued nueva (118), la void no suma.
    expect(Number(after.total) - Number(before.total)).toBeCloseTo(118, 2);
  });
});
