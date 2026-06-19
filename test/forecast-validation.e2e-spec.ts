import { Test } from '@nestjs/testing';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import request from 'supertest';
import { App } from 'supertest/types';
import { PrismaClient, Prisma } from '@prisma/client';
import { hash } from 'bcryptjs';
import { z } from 'zod';
import { AppModule } from './../src/app.module';
import { apiResponseSchema, authTokensSchema } from './../src/shared';

const adminUrl = process.env.DATABASE_URL_ADMIN;
if (!adminUrl) {
  throw new Error('DATABASE_URL_ADMIN no está definido (ver .env)');
}

const TRUNCATE =
  'TRUNCATE TABLE "forecast_runs","sales_history","menu_items","recipes","audit_logs","refresh_tokens","users","tenants" CASCADE';

const at = (day: string): Date => new Date(`${day}T12:00:00-05:00`);

// HU-08-05 — Validación predicho vs real. Requiere DB (+ Redis para el boot).
describe('Forecasting validación predicho vs real — HU-08-05 (e2e)', () => {
  let app: NestFastifyApplication<App>;
  const admin = new PrismaClient({ datasources: { db: { url: adminUrl } } });
  const password = 'Secret12345';
  const tokensSchema = apiResponseSchema(authTokensSchema);

  const validationSchema = apiResponseSchema(
    z.object({
      runId: z.string(),
      scope: z.string(),
      model: z.string().nullable(),
      rows: z.array(
        z.object({
          targetDate: z.string(),
          yhat: z.number(),
          actual: z.number().nullable(),
          errorPct: z.number().nullable(),
          inInterval: z.boolean().nullable(),
          status: z.enum(['compared', 'pending']),
        }),
      ),
      summary: z.object({
        comparedDays: z.number(),
        mape: z.number().nullable(),
        intervalCoveragePct: z.number().nullable(),
      }),
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

  beforeAll(async () => {
    await admin.$connect();
    await admin.$executeRawUnsafe(TRUNCATE);
    const tenant = await admin.tenant.create({ data: { name: 'Motif' } });
    const passwordHash = await hash(password, 4);
    await admin.user.create({
      data: {
        tenantId: tenant.id,
        email: 'owner@fv.pe',
        name: 'O',
        passwordHash,
        roles: ['owner'],
      },
    });
    await admin.user.create({
      data: {
        tenantId: tenant.id,
        email: 'staff@fv.pe',
        name: 'S',
        passwordHash,
        roles: ['staff'],
      },
    });

    // Real: 11 unidades el 08-01, 25 el 09-01. Último día con ventas = 09-01.
    await admin.salesHistory.createMany({
      data: [
        {
          tenantId: tenant.id,
          soldOn: at('2024-01-08'),
          dishName: 'D',
          menuItemId: null,
          qty: 11,
          unitPrice: 10,
          total: 110,
        },
        {
          tenantId: tenant.id,
          soldOn: at('2024-01-09'),
          dishName: 'D',
          menuItemId: null,
          qty: 25,
          unitPrice: 10,
          total: 250,
        },
      ],
    });

    // Corrida completada: 08 (11∈[8,12] ✓, APE 9.09), 09 (25∉[18,22] ✗, APE 20),
    // y un día futuro (2099) que debe quedar pending.
    await admin.forecastRun.create({
      data: {
        tenantId: tenant.id,
        scope: 'total',
        menuItemId: null,
        horizon: 3,
        status: 'completed',
        model: 'AutoETS',
        baseline: 'SeasonalNaive',
        completedAt: new Date(),
        points: [
          { target_date: '2024-01-08', yhat: 10, yhat_lo: 8, yhat_hi: 12 },
          { target_date: '2024-01-09', yhat: 20, yhat_lo: 18, yhat_hi: 22 },
          { target_date: '2099-01-01', yhat: 99, yhat_lo: 90, yhat_hi: 110 },
        ] as Prisma.InputJsonValue,
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
    ownerToken = await login('owner@fv.pe');
    staffToken = await login('staff@fv.pe');
  }, 30_000);

  afterAll(async () => {
    await admin.$executeRawUnsafe(TRUNCATE);
    await admin.$disconnect();
    await app.close();
  });

  it('compara predicho vs real con MAPE acumulado y cobertura del intervalo', async () => {
    const data = validationSchema.parse(
      (
        await request(app.getHttpServer())
          .get('/api/forecasting/validation?scope=total')
          .set(bearer(ownerToken))
          .expect(200)
      ).body,
    ).data;

    const byDate = Object.fromEntries(data.rows.map((r) => [r.targetDate, r]));
    expect(byDate['2024-01-08']).toMatchObject({
      actual: 11,
      inInterval: true,
      errorPct: 9.09,
      status: 'compared',
    });
    expect(byDate['2024-01-09']).toMatchObject({
      actual: 25,
      inInterval: false,
      errorPct: 20,
      status: 'compared',
    });
    expect(byDate['2099-01-01']).toMatchObject({
      actual: null,
      status: 'pending',
    });

    expect(data.summary.comparedDays).toBe(2);
    expect(data.summary.mape).toBe(14.55); // mean(9.09, 20)
    expect(data.summary.intervalCoveragePct).toBe(50); // 1 de 2
  });

  it('staff NO puede ver la validación → 403 (read Report)', async () => {
    await request(app.getHttpServer())
      .get('/api/forecasting/validation?scope=total')
      .set(bearer(staffToken))
      .expect(403);
  });

  it('sin pronóstico para el ámbito → 404', async () => {
    await request(app.getHttpServer())
      .get(
        '/api/forecasting/validation?scope=menuItem&menuItemId=33333333-3333-4333-8333-333333333333',
      )
      .set(bearer(ownerToken))
      .expect(404);
  });
});
