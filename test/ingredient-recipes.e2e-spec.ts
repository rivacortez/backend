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

// QA-06 (bugfix, reporte QA usuario final pre-demo) · Panel "Usado en (0
// recetas)" en el detalle de insumo pese a BOM activo. Root cause: NO existía
// un endpoint reverse-lookup insumo→recetas — `GET /api/recipes` (listado)
// devuelve `RecipeSummary` SIN `items` a propósito (evita cargar el BOM
// completo de cada receta solo para listar); el frontend construía el panel
// filtrando `recipe.items` de ESA respuesta, que siempre viene vacía. Ver
// `RecipesService#usedByIngredient` (nuevo) y `GET /api/ingredients/:id/recipes`.

const adminUrl = process.env.DATABASE_URL_ADMIN;
if (!adminUrl) {
  throw new Error('DATABASE_URL_ADMIN no está definido (ver .env)');
}

const TRUNCATE =
  'TRUNCATE TABLE "recipe_versions","recipe_items","recipes","product_suppliers","suppliers","ingredients","categories","units_of_measure","audit_logs","refresh_tokens","users","tenants" CASCADE';

describe('Catálogo — reverse-lookup insumo→recetas QA-06 (e2e)', () => {
  let app: NestFastifyApplication<App>;
  const admin = new PrismaClient({ datasources: { db: { url: adminUrl } } });
  const password = 'Secret12345';
  const tokensSchema = apiResponseSchema(authTokensSchema);
  const idSchema = apiResponseSchema(z.object({ id: z.uuid() }));
  const usageSchema = apiResponseSchema(
    z.array(
      z.object({
        recipeId: z.uuid(),
        name: z.string(),
        kind: z.string(),
        emoji: z.string().nullable(),
        qty: z.string(),
        wasteFactor: z.string(),
        lineCost: z.string(),
        recipeTotalCost: z.string(),
      }),
    ),
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

  beforeAll(async () => {
    await admin.$connect();
    await admin.$executeRawUnsafe(TRUNCATE);
    const tenant = await admin.tenant.create({ data: { name: 'Motif' } });
    const passwordHash = await hash(password, 4);
    await admin.user.create({
      data: {
        tenantId: tenant.id,
        email: 'owner@ingrec.pe',
        name: 'O',
        passwordHash,
        roles: ['owner'],
      },
    });
    await admin.user.create({
      data: {
        tenantId: tenant.id,
        email: 'staff@ingrec.pe',
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
    ownerToken = await login('owner@ingrec.pe');
    staffToken = await login('staff@ingrec.pe');
  });

  afterAll(async () => {
    await admin.$executeRawUnsafe(TRUNCATE);
    await admin.$disconnect();
    await app.close();
  });

  let pulpoId = '';
  let cebollaId = '';

  it('seed: insumo Pulpo usado en 2 recetas (Ceviche Mixto, Pulpo al Olivo) + 1 receta que NO lo usa', async () => {
    pulpoId = idSchema.parse(
      (
        await post('/api/ingredients', ownerToken, {
          sku: 'PES-002',
          name: 'Pulpo',
          type: 'raw',
          unit: 'kg',
          unitCost: 45,
        }).expect(201)
      ).body,
    ).data.id;
    cebollaId = idSchema.parse(
      (
        await post('/api/ingredients', ownerToken, {
          sku: 'VEG-001',
          name: 'Cebolla',
          type: 'raw',
          unit: 'kg',
          unitCost: 3,
        }).expect(201)
      ).body,
    ).data.id;

    await post('/api/recipes', ownerToken, {
      name: 'Ceviche Mixto',
      kind: 'dish',
      yield: 1,
      emoji: '🐙',
      items: [
        { ingredientId: pulpoId, qty: 0.15, wasteFactor: 0.1 },
        { ingredientId: cebollaId, qty: 0.05 },
      ],
    }).expect(201);
    await post('/api/recipes', ownerToken, {
      name: 'Pulpo al Olivo',
      kind: 'dish',
      yield: 1,
      items: [{ ingredientId: pulpoId, qty: 0.2 }],
    }).expect(201);
    // Receta que NO usa Pulpo → no debe aparecer en el reverse-lookup.
    await post('/api/recipes', ownerToken, {
      name: 'Ensalada de Cebolla',
      kind: 'dish',
      yield: 1,
      items: [{ ingredientId: cebollaId, qty: 0.1 }],
    }).expect(201);
  });

  it('GET /api/ingredients/:id/recipes devuelve EXACTAMENTE las 2 recetas que usan Pulpo', async () => {
    const usages = usageSchema.parse(
      (await get(`/api/ingredients/${pulpoId}/recipes`, staffToken).expect(200))
        .body,
    ).data;
    expect(usages).toHaveLength(2);
    const names = usages.map((u) => u.name).sort();
    expect(names).toEqual(['Ceviche Mixto', 'Pulpo al Olivo']);
    const ceviche = usages.find((u) => u.name === 'Ceviche Mixto');
    expect(ceviche?.qty).toBe('0.15');
    expect(ceviche?.wasteFactor).toBe('0.1');
    // lineCost = unitCost·qty·(1+waste) = 45·0.15·1.1 = 7.425 → 7.43 (2dp)
    expect(ceviche?.lineCost).toBe('7.43');
  });

  it('un insumo que NO se usa en ninguna receta devuelve []', async () => {
    const sinUso = idSchema.parse(
      (
        await post('/api/ingredients', ownerToken, {
          sku: 'SIN-USO',
          name: 'Sin Uso',
          type: 'raw',
          unit: 'un',
          unitCost: 1,
        }).expect(201)
      ).body,
    ).data.id;
    const usages = usageSchema.parse(
      (await get(`/api/ingredients/${sinUso}/recipes`, staffToken).expect(200))
        .body,
    ).data;
    expect(usages).toEqual([]);
  });

  it('insumo inexistente → 404', async () => {
    await get(
      '/api/ingredients/00000000-0000-0000-0000-000000000000/recipes',
      staffToken,
    ).expect(404);
  });
});
