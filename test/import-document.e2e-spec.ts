/**
 * E11 Smart Onboarding — document import e2e test suite.
 *
 * Coverage (spec/e11/smart-onboarding.spec.md):
 *   1. Happy path preview — CSV fixture → extracted preview (no DB writes).
 *   2. Commit creates Ingredient + MenuCategory + Recipe stub + MenuItem.
 *   3. Idempotent re-commit: skipped list populated, no duplicates.
 *   4. CASL: staff → 403 on both preview and commit.
 *   5. Commit validation: negative price → 400; absurd price → 400.
 *   6. Preview: missing file → 400; unsupported file type → 400.
 *   7. RLS: MenuItem created under tenant A is invisible from tenant B.
 *
 * CoreAiExtractClient is replaced by a DI override (same pattern as chat.e2e-spec.ts)
 * so no real core-ai process is required. DocumentExtractService is real so text
 * extraction logic (CSV/xlsx) is tested. Prisma + RLS FORCE run against the
 * local Docker DB.
 */

import multipart from '@fastify/multipart';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import { hash } from 'bcryptjs';
import request from 'supertest';
import type { App } from 'supertest/types';
import { z } from 'zod';
import { AppModule } from '../src/app.module';
import { CoreAiExtractClient } from '../src/ingestion/core-ai-extract.client';
import {
  apiResponseSchema,
  authTokensSchema,
  type CoreAiExtractResponse,
} from '../src/shared';

// ---------------------------------------------------------------------------
// DB bootstrap
// ---------------------------------------------------------------------------

const adminUrl = process.env.DATABASE_URL_ADMIN;
if (!adminUrl) throw new Error('DATABASE_URL_ADMIN not set (see .env)');

const TRUNCATE = `
  TRUNCATE TABLE
    "menu_items","recipes","menu_categories","ingredients",
    "audit_logs","refresh_tokens","users","tenants"
  CASCADE
`;

// ---------------------------------------------------------------------------
// Stub CoreAiExtractClient — returns predictable canned extraction data
// ---------------------------------------------------------------------------

/** Fixed mock extraction that mirrors what the core-ai mock adapter returns. */
const MOCK_EXTRACTION: CoreAiExtractResponse = {
  menuItems: [
    {
      name: 'Lomo Saltado',
      price: 32.5,
      category: 'Platos de fondo',
      description: null,
    },
    {
      name: 'Ceviche Mixto',
      price: 28.0,
      category: 'Entradas',
      description: null,
    },
  ],
  ingredients: [{ name: 'Carne de res', unit: 'kg', estimatedCost: 32.0 }],
  provider: 'mock',
  model: 'mock-v1',
};

const mockExtractClient: Partial<CoreAiExtractClient> = {
  extract: () => Promise.resolve(MOCK_EXTRACTION),
};

// ---------------------------------------------------------------------------
// Zod response schemas for assertion
// ---------------------------------------------------------------------------

const tokensSchema = apiResponseSchema(authTokensSchema);

const previewSchema = apiResponseSchema(
  z.object({
    menuItems: z.array(
      z.object({
        name: z.string(),
        price: z.number(),
        category: z.string().nullable().optional(),
      }),
    ),
    ingredients: z.array(z.object({ name: z.string(), unit: z.string() })),
    source: z.object({ type: z.string(), filename: z.string() }),
    provider: z.string(),
  }),
);

const commitSchema = apiResponseSchema(
  z.object({
    created: z.object({
      ingredients: z.number(),
      menuItems: z.number(),
      categories: z.number(),
    }),
    skipped: z.array(z.string()),
  }),
);

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('Smart Onboarding — carga de documentos E11 (e2e)', () => {
  let app: NestFastifyApplication<App>;
  const admin = new PrismaClient({ datasources: { db: { url: adminUrl } } });
  const password = 'Secret12345';

  // Tenant A
  let ownerToken = '';
  let managerToken = '';
  let staffToken = '';
  let tenantAId = '';
  // Tenant B (for RLS isolation test)
  let ownerBToken = '';

  const login = async (email: string): Promise<string> => {
    const res = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email, password })
      .expect(200);
    return tokensSchema.parse(res.body).data.accessToken;
  };

  const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

  // CSV fixture with 2 valid dish rows — used as the uploaded "document".
  const CSV_FIXTURE = [
    'nombre,precio,categoria',
    'Lomo Saltado,32.50,Platos de fondo',
    'Ceviche Mixto,28.00,Entradas',
  ].join('\n');

  // The commit payload mirrors what the preview endpoint would return.
  const COMMIT_PAYLOAD = {
    menuItems: MOCK_EXTRACTION.menuItems,
    ingredients: MOCK_EXTRACTION.ingredients,
  };

  const doPreview = (
    token: string,
    filename = 'menu.csv',
    content = CSV_FIXTURE,
  ) =>
    request(app.getHttpServer())
      .post('/api/import/document/preview')
      .set(bearer(token))
      .attach('file', Buffer.from(content), {
        filename,
        contentType: 'text/csv',
      });

  const doCommit = (token: string, body = COMMIT_PAYLOAD) =>
    request(app.getHttpServer())
      .post('/api/import/document/commit')
      .set(bearer(token))
      .send(body);

  beforeAll(async () => {
    await admin.$connect();
    await admin.$executeRawUnsafe(TRUNCATE);

    // Tenant A — owner + manager + staff
    const tenantA = await admin.tenant.create({ data: { name: 'Motif A' } });
    tenantAId = tenantA.id;
    const ph = await hash(password, 4);
    await admin.user.createMany({
      data: [
        {
          tenantId: tenantAId,
          email: 'owner-a@doc.pe',
          name: 'Owner A',
          passwordHash: ph,
          roles: ['owner'],
        },
        {
          tenantId: tenantAId,
          email: 'manager-a@doc.pe',
          name: 'Manager A',
          passwordHash: ph,
          roles: ['manager'],
        },
        {
          tenantId: tenantAId,
          email: 'staff-a@doc.pe',
          name: 'Staff A',
          passwordHash: ph,
          roles: ['staff'],
        },
      ],
    });

    // Tenant B — owner only (for RLS test)
    const tenantB = await admin.tenant.create({ data: { name: 'Motif B' } });
    await admin.user.create({
      data: {
        tenantId: tenantB.id,
        email: 'owner-b@doc.pe',
        name: 'Owner B',
        passwordHash: ph,
        roles: ['owner'],
      },
    });

    // Build app with CoreAiExtractClient stubbed out.
    const mf = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(CoreAiExtractClient)
      .useValue(mockExtractClient)
      .compile();

    app = mf.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );
    app.setGlobalPrefix('api');
    // Register multipart plugin in the test app (mirrors main.ts bootstrap).
    await app.register(multipart, {
      limits: { fileSize: 10 * 1024 * 1024, files: 1 },
    });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    ownerToken = await login('owner-a@doc.pe');
    managerToken = await login('manager-a@doc.pe');
    staffToken = await login('staff-a@doc.pe');
    ownerBToken = await login('owner-b@doc.pe');
  });

  afterAll(async () => {
    await admin.$executeRawUnsafe(TRUNCATE);
    await admin.$disconnect();
    await app.close();
  });

  // -------------------------------------------------------------------------
  // R1 — Preview
  // -------------------------------------------------------------------------

  it('preview: CSV → returns structured preview, 0 DB writes', async () => {
    const res = await doPreview(ownerToken).expect(201);
    const body = previewSchema.parse(res.body);

    expect(body.data.menuItems.length).toBeGreaterThan(0);
    expect(body.data.ingredients.length).toBeGreaterThan(0);
    expect(body.data.source.type).toBe('csv');
    expect(body.data.source.filename).toBe('menu.csv');
    expect(body.data.provider).toBe('mock');

    // Nothing written to DB — tenant A has no menu items yet.
    const count = await admin.menuItem.count({
      where: { tenantId: tenantAId },
    });
    expect(count).toBe(0);
  });

  it('preview: manager can also preview (manage Catalog)', async () => {
    await doPreview(managerToken).expect(201);
  });

  it('preview: staff → 403', async () => {
    await doPreview(staffToken).expect(403);
  });

  it('preview: no file → 400', async () => {
    await request(app.getHttpServer())
      .post('/api/import/document/preview')
      .set(bearer(ownerToken))
      .set('Content-Type', 'multipart/form-data')
      .expect(400);
  });

  it('preview: unsupported file type (.docx) → 400', async () => {
    // .txt / text/plain is treated as CSV (intentional — CSV is plain text).
    // .docx has no matching extension or MIME type → SupportedFileType = 'unknown' → 400.
    await request(app.getHttpServer())
      .post('/api/import/document/preview')
      .set(bearer(ownerToken))
      .attach('file', Buffer.from('dummy content'), {
        filename: 'notes.docx',
        contentType:
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      })
      .expect(400);
  });

  // -------------------------------------------------------------------------
  // R2 — Commit
  // -------------------------------------------------------------------------

  it('commit: creates Ingredients + MenuCategories + Recipes + MenuItems', async () => {
    const res = await doCommit(ownerToken).expect(201);
    const body = commitSchema.parse(res.body);

    expect(body.data.created.menuItems).toBe(2); // Lomo Saltado + Ceviche Mixto
    expect(body.data.created.ingredients).toBe(1); // Carne de res
    expect(body.data.created.categories).toBe(2); // Platos de fondo + Entradas
    expect(body.data.skipped).toHaveLength(0);

    // Verify items exist in DB under tenant A.
    const items = await admin.menuItem.findMany({
      where: { tenantId: tenantAId, deletedAt: null },
      select: { name: true },
    });
    const names = items.map((i) => i.name);
    expect(names).toContain('Lomo Saltado');
    expect(names).toContain('Ceviche Mixto');
  });

  it('commit: idempotent re-commit skips existing items without duplicating', async () => {
    const res = await doCommit(ownerToken).expect(201);
    const body = commitSchema.parse(res.body);

    expect(body.data.created.menuItems).toBe(0); // nothing new
    expect(body.data.created.ingredients).toBe(0);
    expect(body.data.skipped).toContain('Lomo Saltado');
    expect(body.data.skipped).toContain('Ceviche Mixto');
    expect(body.data.skipped).toContain('Carne de res');

    // Still exactly 2 menu items — no duplicates.
    const count = await admin.menuItem.count({
      where: { tenantId: tenantAId, deletedAt: null },
    });
    expect(count).toBe(2);
  });

  it('commit: manager can commit (manage Catalog)', async () => {
    // Manager commits a new item not yet in the catalog.
    const newItem = {
      menuItems: [{ name: 'Aji de Gallina', price: 25.0 }],
      ingredients: [],
    };
    const res = await doCommit(managerToken, newItem).expect(201);
    const body = commitSchema.parse(res.body);
    expect(body.data.created.menuItems).toBe(1);
  });

  it('commit: staff → 403', async () => {
    await doCommit(staffToken).expect(403);
  });

  it('commit: negative price → 400', async () => {
    await doCommit(ownerToken, {
      menuItems: [{ name: 'Bad Item', price: -5 }],
      ingredients: [],
    }).expect(400);
  });

  it('commit: absurd price (>9999) → 400', async () => {
    await doCommit(ownerToken, {
      menuItems: [{ name: 'Crazy Item', price: 10_000 }],
      ingredients: [],
    }).expect(400);
  });

  it('commit: empty arrays → 201 with zeros (no-op is valid)', async () => {
    const res = await doCommit(ownerToken, {
      menuItems: [],
      ingredients: [],
    }).expect(201);
    const body = commitSchema.parse(res.body);
    expect(body.data.created.menuItems).toBe(0);
    expect(body.data.skipped).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // RLS — tenant isolation
  // -------------------------------------------------------------------------

  it('RLS: items committed by tenant A are invisible to tenant B', async () => {
    // Tenant B owner has no items — commit an item for tenant A first
    // (already done in earlier tests). Verify tenant B sees nothing.
    const res = await request(app.getHttpServer())
      .get('/api/menu/items')
      .set(bearer(ownerBToken))
      .expect(200);

    // Tenant B should have no menu items seeded from tenant A's commit.
    const items = (res.body as { data: unknown[] }).data ?? [];
    const names = (items as Array<{ name: string }>).map((i) => i.name);
    expect(names).not.toContain('Lomo Saltado');
    expect(names).not.toContain('Ceviche Mixto');
  });

  it('RLS: commit under tenant B does not create items visible to tenant A', async () => {
    const tenantBItem = {
      menuItems: [{ name: 'Tacu Tacu B', price: 20.0 }],
      ingredients: [],
    };
    await doCommit(ownerBToken, tenantBItem).expect(201);

    // Tenant A should not see 'Tacu Tacu B'.
    const res = await request(app.getHttpServer())
      .get('/api/menu/items')
      .set(bearer(ownerToken))
      .expect(200);
    const names = (
      (res.body as { data: unknown[] }).data as Array<{ name: string }>
    ).map((i) => i.name);
    expect(names).not.toContain('Tacu Tacu B');
  });
});
