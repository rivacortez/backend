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

// QA-02 (bugfix, reporte QA usuario final pre-demo) · "El descuento aplicado
// NO se cobra". Root cause: el frontend calculaba el descuento SOLO en el
// modal (preview local) y nunca lo enviaba al backend — no existía NI el
// campo de persistencia (Order.discount*) NI el endpoint. El cobro, el
// desglose de IGV, el comprobante y "dividir cuenta" ignoraban por completo
// la intención de descuento. Ver `orders.service.ts#applyDiscount` y
// `billing.service.ts#computeTotals` para el fix. Este archivo cubre el flujo
// descuento→cobro end-to-end (persistencia, CASL, cómputo, comprobante).

const adminUrl = process.env.DATABASE_URL_ADMIN;
if (!adminUrl) {
  throw new Error('DATABASE_URL_ADMIN no está definido (ver .env)');
}

const TRUNCATE =
  'TRUNCATE TABLE "cash_closes","payments","sales","order_items","orders","dining_tables","zones","menu_modifiers","menu_availability","menu_items","menu_categories","recipe_versions","recipe_items","recipes","product_suppliers","suppliers","ingredients","categories","units_of_measure","audit_logs","refresh_tokens","users","tenants" CASCADE';

describe('Discount — descuento en cuenta QA-02 (e2e)', () => {
  let app: NestFastifyApplication<App>;
  const admin = new PrismaClient({ datasources: { db: { url: adminUrl } } });
  const password = 'Secret12345';
  const tokensSchema = apiResponseSchema(authTokensSchema);
  const idSchema = apiResponseSchema(z.object({ id: z.uuid() }));
  const discountSchema = z
    .object({
      type: z.string(),
      value: z.string(),
      reason: z.string(),
      amount: z.string(),
    })
    .nullable();
  const orderSchema = apiResponseSchema(
    z.object({
      id: z.uuid(),
      status: z.string(),
      subtotal: z.string(),
      discount: z
        .object({ type: z.string(), value: z.string(), reason: z.string() })
        .nullable(),
    }),
  );
  const preBillSchema = apiResponseSchema(
    z.object({
      orderId: z.uuid(),
      grossTotal: z.string(),
      discount: discountSchema,
      subtotal: z.string(),
      igv: z.string(),
      total: z.string(),
    }),
  );
  const saleSchema = z.object({
    id: z.uuid(),
    grossTotal: z.string(),
    discount: discountSchema,
    subtotal: z.string(),
    igv: z.string(),
    total: z.string(),
    status: z.string(),
  });
  const paySchema = apiResponseSchema(
    z.object({
      order: z.object({ id: z.uuid(), status: z.string() }),
      sale: saleSchema,
    }),
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
  const post = (path: string, token: string, body?: unknown) =>
    request(app.getHttpServer()).post(path).set(bearer(token)).send(body);
  const del = (path: string, token: string) =>
    request(app.getHttpServer()).delete(path).set(bearer(token));

  let zoneId = '';
  let menuItemId = ''; // precio 118 → subtotal 100, IGV 18 (números limpios)
  let tableSeq = 0;

  // Abre una orden NUEVA con 1 unidad del plato (118).
  const openOrderWithItem = async (): Promise<{ orderId: string }> => {
    tableSeq += 1;
    const tableId = idSchema.parse(
      (
        await post('/api/tables', ownerToken, {
          zoneId,
          code: `D${tableSeq}`,
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
    return { orderId };
  };

  beforeAll(async () => {
    await admin.$connect();
    await admin.$executeRawUnsafe(TRUNCATE);
    const tenant = await admin.tenant.create({
      data: { name: 'Motif Discount', igvRate: 0.18 },
    });
    const passwordHash = await hash(password, 4);
    await admin.user.create({
      data: {
        tenantId: tenant.id,
        email: 'owner@discount.pe',
        name: 'O',
        passwordHash,
        roles: ['owner'],
      },
    });
    await admin.user.create({
      data: {
        tenantId: tenant.id,
        email: 'staff@discount.pe',
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
    ownerToken = await login('owner@discount.pe');
    staffToken = await login('staff@discount.pe');

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

  it('CASL: staff NO puede aplicar descuento (403) — decisión financiera, mismo criterio que anular ticket', async () => {
    const { orderId } = await openOrderWithItem();
    await post(`/api/orders/${orderId}/discount`, staffToken, {
      type: 'pct',
      value: 10,
      reason: 'Cliente frecuente',
    }).expect(403);
  });

  it('sin motivo → 400 (Zod: reason obligatorio, igual que anular)', async () => {
    const { orderId } = await openOrderWithItem();
    await post(`/api/orders/${orderId}/discount`, ownerToken, {
      type: 'pct',
      value: 10,
    }).expect(400);
  });

  it('owner aplica 10% → persiste en la orden, pre-cuenta y cobro reflejan el descuento (NO el bruto)', async () => {
    const { orderId } = await openOrderWithItem();
    const applied = orderSchema.parse(
      (
        await post(`/api/orders/${orderId}/discount`, ownerToken, {
          type: 'pct',
          value: 10,
          reason: 'Cliente frecuente',
        }).expect(201)
      ).body,
    ).data;
    expect(applied.discount).toEqual({
      type: 'pct',
      value: '10.00',
      reason: 'Cliente frecuente',
    });

    // GET /api/orders/:id también refleja el descuento persistido (no se pierde).
    const fetched = orderSchema.parse(
      (await get(`/api/orders/${orderId}`, staffToken).expect(200)).body,
    ).data;
    expect(fetched.discount?.value).toBe('10.00');

    const pre = preBillSchema.parse(
      (await get(`/api/orders/${orderId}/pre-bill`, staffToken).expect(200))
        .body,
    ).data;
    expect(pre.grossTotal).toBe('118.00');
    expect(pre.discount).toEqual({
      type: 'pct',
      value: '10.00',
      reason: 'Cliente frecuente',
      amount: '11.80',
    });
    // 118 − 11.80 = 106.20 (subtotal 90.00 + IGV 16.20) — IGV 18% sobre la
    // base YA DESCONTADA, no sobre el bruto (la corrección central del defecto).
    expect(pre.total).toBe('106.20');
    expect(pre.subtotal).toBe('90.00');
    expect(pre.igv).toBe('16.20');

    // Cobrar con el pago EXACTO del total descontado (106.20) — si el bug
    // siguiera vigente, el backend exigiría 118.00 y este pago de 106.20 fallaría.
    const { sale, order } = paySchema.parse(
      (
        await post(`/api/orders/${orderId}/pay`, staffToken, {
          payments: [{ method: 'cash', amount: 106.2 }],
        }).expect(201)
      ).body,
    ).data;
    expect(order.status).toBe('paid');
    expect(sale.total).toBe('106.20');
    expect(sale.subtotal).toBe('90.00');
    expect(sale.igv).toBe('16.20');
    // Línea de descuento en el comprobante (snapshot inmutable al cobrar).
    expect(sale.grossTotal).toBe('118.00');
    expect(sale.discount).toEqual({
      type: 'pct',
      value: '10.00',
      reason: 'Cliente frecuente',
      amount: '11.80',
    });

    // Pagar el bruto sin descuento (118) ahora SOBRA sobre el total → igual
    // cubre (paid >= total), pero confirma que el mínimo exigido es 106.20.
    const { orderId: orderId2 } = await openOrderWithItem();
    await post(`/api/orders/${orderId2}/discount`, ownerToken, {
      type: 'pct',
      value: 10,
      reason: 'Cliente frecuente',
    }).expect(201);
    await post(`/api/orders/${orderId2}/pay`, staffToken, {
      payments: [{ method: 'cash', amount: 100 }], // < 106.20 → insuficiente
    }).expect(400);
  });

  it('QA-02 caso límite: descuento 0% deja la cuenta intacta (total = bruto)', async () => {
    const { orderId } = await openOrderWithItem();
    await post(`/api/orders/${orderId}/discount`, ownerToken, {
      type: 'pct',
      value: 0,
      reason: 'Sin descuento efectivo',
    }).expect(201);
    const pre = preBillSchema.parse(
      (await get(`/api/orders/${orderId}/pre-bill`, staffToken).expect(200))
        .body,
    ).data;
    expect(pre.discount?.amount).toBe('0.00');
    expect(pre.total).toBe('118.00');
    expect(pre.subtotal).toBe('100.00');
    expect(pre.igv).toBe('18.00');
  });

  it('QA-02 caso límite: descuento 100% → cuenta gratis (total/subtotal/igv = 0.00) y se puede cobrar', async () => {
    const { orderId } = await openOrderWithItem();
    await post(`/api/orders/${orderId}/discount`, ownerToken, {
      type: 'pct',
      value: 100,
      reason: 'Cortesía de la casa',
    }).expect(201);
    const pre = preBillSchema.parse(
      (await get(`/api/orders/${orderId}/pre-bill`, staffToken).expect(200))
        .body,
    ).data;
    expect(pre.total).toBe('0.00');
    expect(pre.subtotal).toBe('0.00');
    expect(pre.igv).toBe('0.00');
    expect(pre.discount?.amount).toBe('118.00');

    // Se puede cerrar la cuenta gratis con un pago nominal (total exigido = 0).
    const { order, sale } = paySchema.parse(
      (
        await post(`/api/orders/${orderId}/pay`, staffToken, {
          payments: [{ method: 'cash', amount: 0.01 }],
        }).expect(201)
      ).body,
    ).data;
    expect(order.status).toBe('paid');
    expect(sale.total).toBe('0.00');
  });

  it('type=amount que excede el bruto de la cuenta → 400', async () => {
    const { orderId } = await openOrderWithItem(); // bruto 118
    await post(`/api/orders/${orderId}/discount`, ownerToken, {
      type: 'amount',
      value: 200,
      reason: 'Promoción del día',
    }).expect(400);
  });

  it('quitar el descuento (DELETE) → vuelve a cobrar el 100%; orden sin descuento queda intacta', async () => {
    const { orderId } = await openOrderWithItem();
    await post(`/api/orders/${orderId}/discount`, ownerToken, {
      type: 'amount',
      value: 20,
      reason: 'Error de cocina',
    }).expect(201);
    const cleared = orderSchema.parse(
      (await del(`/api/orders/${orderId}/discount`, ownerToken).expect(200))
        .body,
    ).data;
    expect(cleared.discount).toBeNull();

    const pre = preBillSchema.parse(
      (await get(`/api/orders/${orderId}/pre-bill`, staffToken).expect(200))
        .body,
    ).data;
    expect(pre.discount).toBeNull();
    expect(pre.total).toBe('118.00'); // orden intacta, sin descuento
  });

  it('orden sin descuento nunca aplicado: pre-cuenta y cobro no tienen discount (regresión)', async () => {
    const { orderId } = await openOrderWithItem();
    const pre = preBillSchema.parse(
      (await get(`/api/orders/${orderId}/pre-bill`, staffToken).expect(200))
        .body,
    ).data;
    expect(pre.discount).toBeNull();
    expect(pre.total).toBe('118.00');

    const { sale } = paySchema.parse(
      (
        await post(`/api/orders/${orderId}/pay`, staffToken, {
          payments: [{ method: 'cash', amount: 118 }],
        }).expect(201)
      ).body,
    ).data;
    expect(sale.discount).toBeNull();
    expect(sale.total).toBe('118.00');
  });

  it('cuenta cerrada (paid) → aplicar/quitar descuento da 409', async () => {
    const { orderId } = await openOrderWithItem();
    await post(`/api/orders/${orderId}/pay`, staffToken, {
      payments: [{ method: 'cash', amount: 118 }],
    }).expect(201);
    await post(`/api/orders/${orderId}/discount`, ownerToken, {
      type: 'pct',
      value: 10,
      reason: 'Tarde',
    }).expect(409);
    await del(`/api/orders/${orderId}/discount`, ownerToken).expect(409);
  });
});
