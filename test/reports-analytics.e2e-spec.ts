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

/**
 * E2E — Menu Engineering (HU-07-11) + Prime Cost (HU-07-12).
 *
 * Seed: 2 dishes with controlled costs to guarantee predictable classification.
 *   "Combo Premium": price=50, ingredientCost=10 (1 kg Queso @ S/10/kg) → CM=40
 *   "Agua Mineral":  price=20, ingredientCost=15 (0.5 kg Salmón @ S/30/kg) → CM=5
 *
 * Sales in the period: 9 × Combo Premium + 1 × Agua Mineral
 *   totalUnits=10, N=2, popularityCutoff=0.70×0.5=0.35
 *   Combo popularityShare=0.90 ≥ 0.35 → high pop
 *   Agua  popularityShare=0.10 < 0.35 → low pop
 *   avgCM=(40+5)/2=22.50
 *   Combo CM=40 ≥ 22.50 → STAR
 *   Agua  CM=5  < 22.50 → DOG
 *
 * Prime cost:
 *   revenue = 9*50 + 1*20 = 470.00
 *   foodCost = 9*10 + 1*15 = 105.00
 *   laborCost = 500.00 (overhead 'Sueldos de planilla')
 *   primeCost = 605.00, primeCostPct ≈ 128.72% → status='high'
 */

const adminUrl = process.env.DATABASE_URL_ADMIN;
if (!adminUrl) {
  throw new Error('DATABASE_URL_ADMIN no está definido (ver .env)');
}

const TRUNCATE =
  'TRUNCATE TABLE "costing_closes","overhead_costs","inventory_movements","cash_closes","payments","sales","order_items","orders","dining_tables","zones","menu_modifiers","menu_availability","menu_items","menu_categories","recipe_versions","recipe_items","recipes","product_suppliers","suppliers","ingredients","categories","units_of_measure","audit_logs","refresh_tokens","users","tenants" CASCADE';

// Period: current UTC month. Sales are seeded on day 15 to be safely inside
// the [month-start, month-end) window that unitsSoldByDish() and monthRange() use.
const nowDate = new Date();
const PERIOD = `${nowDate.getUTCFullYear()}-${String(nowDate.getUTCMonth() + 1).padStart(2, '0')}`;
const IN_PERIOD = new Date(
  Date.UTC(nowDate.getUTCFullYear(), nowDate.getUTCMonth(), 15, 12, 0, 0),
);

describe('Menu Engineering + Prime Cost — HU-07-11/12 (e2e)', () => {
  let app: NestFastifyApplication<App>;
  const admin = new PrismaClient({ datasources: { db: { url: adminUrl } } });
  const password = 'Secret12345';
  const tokensSchema = apiResponseSchema(authTokensSchema);
  const idSchema = apiResponseSchema(z.object({ id: z.uuid() }));

  // --- Zod schemas for response validation ---

  const classificationSchema = z.enum(['star', 'plowhorse', 'puzzle', 'dog']);
  const recommendationSchema = z.enum([
    'promote',
    'reprice_or_reduce_portion',
    'reposition_or_rename',
    'remove_or_rework',
  ]);

  const menuEngSchema = apiResponseSchema(
    z.object({
      period: z.string(),
      popularityCutoff: z.string(),
      avgContributionMargin: z.string(),
      items: z.array(
        z.object({
          menuItemId: z.uuid(),
          name: z.string(),
          category: z.string().optional(),
          unitsSold: z.number().int().nonnegative(),
          price: z.string(),
          foodCost: z.string(),
          contributionMargin: z.string(),
          totalContribution: z.string(),
          popularityShare: z.string(),
          classification: classificationSchema,
          recommendation: recommendationSchema,
        }),
      ),
    }),
  );

  const primeCostStatusSchema = z.enum(['good', 'warning', 'high']);
  const primeCostSchema = apiResponseSchema(
    z.object({
      period: z.string(),
      revenue: z.string(),
      foodCost: z.string(),
      foodCostPct: z.string(),
      laborCost: z.string(),
      laborCostPct: z.string(),
      primeCost: z.string(),
      primeCostPct: z.string(),
      status: primeCostStatusSchema,
      benchmarks: z.object({
        primeCostGoodMax: z.string(),
        primeCostWarningMax: z.string(),
        foodCostGoodMin: z.string(),
        foodCostGoodMax: z.string(),
        laborCostGoodMin: z.string(),
        laborCostGoodMax: z.string(),
        foodCostStatus: primeCostStatusSchema,
        laborCostStatus: primeCostStatusSchema,
      }),
    }),
  );

  let ownerToken = '';
  let staffToken = '';
  let tenantId = '';
  let zoneId = '';
  let comboId = ''; // Combo Premium: price=50, ingredientCost=10
  let aguaId = ''; // Agua Mineral: price=20, ingredientCost=15

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

  // Seeds a single issued sale with one line, directly via admin DB client.
  let saleSeq = 0;
  const seedSale = async (
    menuItemId: string,
    name: string,
    qty: number,
    unitPrice: number,
  ): Promise<void> => {
    const total = qty * unitPrice;
    const subtotal = Math.round((total / 1.18) * 100) / 100;
    const igv = Math.round((total - subtotal) * 100) / 100;
    const table = await admin.diningTable.create({
      data: {
        tenantId,
        zoneId,
        code: `T${++saleSeq}`,
        capacity: 4,
        status: 'free',
      },
    });
    const order = await admin.order.create({
      data: {
        tenantId,
        tableId: table.id,
        guests: 2,
        status: 'paid',
        openedAt: IN_PERIOD,
        createdAt: IN_PERIOD,
      },
    });
    await admin.orderItem.create({
      data: {
        tenantId,
        orderId: order.id,
        menuItemId,
        name,
        qty,
        unitPrice,
        createdAt: IN_PERIOD,
      },
    });
    await admin.sale.create({
      data: {
        tenantId,
        orderId: order.id,
        serie: 'B001',
        number: saleSeq,
        docType: 'boleta',
        subtotal,
        igv,
        total,
        status: 'issued',
        issuedAt: IN_PERIOD,
        createdAt: IN_PERIOD,
      },
    });
  };

  beforeAll(async () => {
    await admin.$connect();
    await admin.$executeRawUnsafe(TRUNCATE);

    const tenant = await admin.tenant.create({
      data: { name: 'AnalyticsTest', igvRate: 0.18 },
    });
    tenantId = tenant.id;
    const passwordHash = await hash(password, 4);

    await admin.user.create({
      data: {
        tenantId,
        email: 'owner@analytics.pe',
        name: 'Owner',
        passwordHash,
        roles: ['owner'],
      },
    });
    await admin.user.create({
      data: {
        tenantId,
        email: 'staff@analytics.pe',
        name: 'Staff',
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

    ownerToken = await login('owner@analytics.pe');
    staffToken = await login('staff@analytics.pe');

    // Zone (required for table creation).
    zoneId = idSchema.parse(
      (await post('/api/zones', ownerToken, { name: 'Salón' }).expect(201))
        .body,
    ).data.id;

    // --- Ingredients ---
    // Queso: unitCost=10 → Combo Premium ingredient cost = 1kg × 10 = 10/u.
    const quesoId = idSchema.parse(
      (
        await post('/api/ingredients', ownerToken, {
          sku: 'QUE-A',
          name: 'Queso gouda',
          type: 'raw',
          unit: 'kg',
          unitCost: 10,
        }).expect(201)
      ).body,
    ).data.id;

    // Salmón: unitCost=30 → Agua Mineral ingredient cost = 0.5kg × 30 = 15/u.
    const salmonId = idSchema.parse(
      (
        await post('/api/ingredients', ownerToken, {
          sku: 'SAL-A',
          name: 'Salmón fresco',
          type: 'raw',
          unit: 'kg',
          unitCost: 30,
        }).expect(201)
      ).body,
    ).data.id;

    // --- Recipes ---
    const comboRecipeId = idSchema.parse(
      (
        await post('/api/recipes', ownerToken, {
          name: 'Receta Combo',
          kind: 'dish',
          yield: 1,
          items: [{ ingredientId: quesoId, qty: 1 }],
        }).expect(201)
      ).body,
    ).data.id;

    const aguaRecipeId = idSchema.parse(
      (
        await post('/api/recipes', ownerToken, {
          name: 'Receta Agua',
          kind: 'dish',
          yield: 1,
          items: [{ ingredientId: salmonId, qty: 0.5 }],
        }).expect(201)
      ).body,
    ).data.id;

    // --- Menu items ---
    comboId = idSchema.parse(
      (
        await post('/api/menu/items', ownerToken, {
          recipeId: comboRecipeId,
          name: 'Combo Premium',
          price: 50,
        }).expect(201)
      ).body,
    ).data.id;

    aguaId = idSchema.parse(
      (
        await post('/api/menu/items', ownerToken, {
          recipeId: aguaRecipeId,
          name: 'Agua Mineral',
          price: 20,
        }).expect(201)
      ).body,
    ).data.id;

    // --- Overhead labor cost for the period ---
    await post('/api/overhead-costs', ownerToken, {
      period: PERIOD,
      concept: 'Sueldos de planilla',
      amount: 500,
    }).expect(201);

    // --- Sales in the period ---
    // 9 × Combo Premium (price=50): revenue=450, foodCost=9×10=90
    await seedSale(comboId, 'Combo Premium', 9, 50);
    // 1 × Agua Mineral (price=20): revenue=20, foodCost=1×15=15
    await seedSale(aguaId, 'Agua Mineral', 1, 20);
  });

  afterAll(async () => {
    await admin.$executeRawUnsafe(TRUNCATE);
    await admin.$disconnect();
    await app.close();
  });

  // ===========================================================================
  // HU-07-11 · Menu Engineering
  // ===========================================================================

  it('HU-07-11: menu engineering classifica correctamente star y dog', async () => {
    const view = menuEngSchema.parse(
      (
        await get(
          `/api/reports/menu-engineering?period=${PERIOD}`,
          ownerToken,
        ).expect(200)
      ).body,
    ).data;

    expect(view.period).toBe(PERIOD);
    // N=2 → cutoff = 0.70 × 0.5 = 0.35
    expect(view.popularityCutoff).toBe('0.3500');
    // avgCM = (40 + 5) / 2 = 22.50
    expect(view.avgContributionMargin).toBe('22.50');
    expect(view.items).toHaveLength(2);

    // "Agua Mineral" sorts before "Combo Premium" (alphabetical asc).
    const combo = view.items.find((i) => i.name === 'Combo Premium');
    const agua = view.items.find((i) => i.name === 'Agua Mineral');

    expect(combo).toBeDefined();
    expect(agua).toBeDefined();

    // Combo Premium: 9/10 = 90% share (high pop), CM=40 (high profit) → STAR.
    expect(combo?.classification).toBe('star');
    expect(combo?.recommendation).toBe('promote');
    expect(combo?.unitsSold).toBe(9);
    expect(combo?.price).toBe('50.00');
    expect(combo?.foodCost).toBe('10.00'); // 1kg Queso × S/10
    expect(combo?.contributionMargin).toBe('40.00'); // 50 − 10
    expect(combo?.totalContribution).toBe('360.00'); // 40 × 9
    expect(combo?.popularityShare).toBe('0.9000'); // 9/10

    // Agua Mineral: 1/10 = 10% share (low pop), CM=5 (low profit) → DOG.
    expect(agua?.classification).toBe('dog');
    expect(agua?.recommendation).toBe('remove_or_rework');
    expect(agua?.unitsSold).toBe(1);
    expect(agua?.price).toBe('20.00');
    expect(agua?.foodCost).toBe('15.00'); // 0.5kg Salmón × S/30
    expect(agua?.contributionMargin).toBe('5.00'); // 20 − 15
    expect(agua?.totalContribution).toBe('5.00'); // 5 × 1
    expect(agua?.popularityShare).toBe('0.1000'); // 1/10

    // Assert that at least one star and one dog appear (spec requirement).
    const classifications = view.items.map((i) => i.classification);
    expect(classifications).toContain('star');
    expect(classifications).toContain('dog');
  });

  it('HU-07-11: default period (sin ?period) → 200 sin error', async () => {
    // When no period is supplied, the endpoint defaults to the last complete
    // month. The seed has no data for that month, so items may have unitsSold=0,
    // but the response must be 200 with the correct shape.
    const res = await get('/api/reports/menu-engineering', ownerToken).expect(
      200,
    );
    const view = menuEngSchema.parse(res.body).data;
    // Period string must be a valid YYYY-MM (last complete month).
    expect(view.period).toMatch(/^\d{4}-\d{2}$/);
    expect(Array.isArray(view.items)).toBe(true);
  });

  it('HU-07-11: items ordenados por nombre asc', async () => {
    const view = menuEngSchema.parse(
      (
        await get(
          `/api/reports/menu-engineering?period=${PERIOD}`,
          ownerToken,
        ).expect(200)
      ).body,
    ).data;
    const names = view.items.map((i) => i.name);
    expect(names).toEqual([...names].sort());
  });

  // ===========================================================================
  // HU-07-12 · Prime Cost
  // ===========================================================================

  it('HU-07-12: prime cost con los números esperados y spot-check de la matemática', async () => {
    const view = primeCostSchema.parse(
      (
        await get(
          `/api/reports/prime-cost?period=${PERIOD}`,
          ownerToken,
        ).expect(200)
      ).body,
    ).data;

    expect(view.period).toBe(PERIOD);

    // Revenue = 9×50 + 1×20 = 470.
    expect(view.revenue).toBe('470.00');
    // Food cost = 9×10 + 1×15 = 105.
    expect(view.foodCost).toBe('105.00');
    // Labor cost from "Sueldos de planilla" overhead = 500.
    expect(view.laborCost).toBe('500.00');
    // Prime cost = 105 + 500 = 605.
    expect(view.primeCost).toBe('605.00');
    // Status: 605/470 * 100 ≈ 128.72% > 65% → high.
    expect(view.status).toBe('high');

    // Spot-check: primeCostPct ≈ primeCost / revenue × 100 (within rounding).
    const mathCheck = (Number(view.primeCost) / Number(view.revenue)) * 100;
    expect(Number(view.primeCostPct)).toBeCloseTo(mathCheck, 1);

    // Food cost pct ≈ 105/470 × 100 = 22.34%.
    expect(Number(view.foodCostPct)).toBeCloseTo(22.34, 1);
    // Labor cost pct ≈ 500/470 × 100 = 106.38%.
    expect(Number(view.laborCostPct)).toBeCloseTo(106.38, 1);

    // Benchmark bounds must match the spec.
    expect(view.benchmarks.primeCostGoodMax).toBe('60.00');
    expect(view.benchmarks.primeCostWarningMax).toBe('65.00');
    expect(view.benchmarks.foodCostGoodMin).toBe('28.00');
    expect(view.benchmarks.foodCostGoodMax).toBe('35.00');
    expect(view.benchmarks.laborCostGoodMin).toBe('25.00');
    expect(view.benchmarks.laborCostGoodMax).toBe('35.00');
    // foodCostPct=22.34% ≤ 35% → foodCostStatus='good'.
    expect(view.benchmarks.foodCostStatus).toBe('good');
  });

  it('HU-07-12: default period (sin ?period) → 200 sin error', async () => {
    const res = await get('/api/reports/prime-cost', ownerToken).expect(200);
    const view = primeCostSchema.parse(res.body).data;
    expect(view.period).toMatch(/^\d{4}-\d{2}$/);
    // The last complete month has no sales → revenue=0 and all pcts=0.00.
    expect(view.revenue).toBe('0.00');
    expect(view.primeCostPct).toBe('0.00');
  });

  // ===========================================================================
  // RBAC + autenticación (ambos endpoints)
  // ===========================================================================

  it('staff → 403 en menu-engineering y prime-cost (read Report gate)', async () => {
    await get(
      `/api/reports/menu-engineering?period=${PERIOD}`,
      staffToken,
    ).expect(403);
    await get(`/api/reports/prime-cost?period=${PERIOD}`, staffToken).expect(
      403,
    );
  });

  it('sin token → 401 en menu-engineering y prime-cost', async () => {
    await request(app.getHttpServer())
      .get(`/api/reports/menu-engineering?period=${PERIOD}`)
      .expect(401);
    await request(app.getHttpServer())
      .get(`/api/reports/prime-cost?period=${PERIOD}`)
      .expect(401);
  });
});
