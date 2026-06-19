import {
  BadRequestException,
  Injectable,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../platform/prisma/prisma.service';
import { type CoreAiForecastResponse, type RunForecastInput } from '../shared';
import { CoreAiClient } from './core-ai.client';
import {
  zeroFillDailySeries,
  type AggregatedSeries,
  type DailyTotal,
} from './sales-aggregation.util';

// core-ai exige al menos 2 puntos para inferir; con menos no hay serie útil.
const MIN_POINTS_TO_FORECAST = 2;

/** Respuesta del seam de demanda: la serie + metadatos de calidad. Lo que `points`
 *  contiene es exactamente el `history` que consume `core-ai` (`frequency:"D"`). */
export interface DemandSeriesResponse {
  scope: 'total' | 'menuItem';
  seriesId: string;
  label: string;
  frequency: 'D';
  observations: number;
  spanDays: number;
  dataQuality: AggregatedSeries['dataQuality'];
  points: AggregatedSeries['points'];
}

// Fila cruda del GROUP BY: ya un total por día local (no toda la tabla de ventas).
type DailyRow = { ds: string; y: number };

type Tx = Prisma.TransactionClient;

/** Pronóstico generado: metadatos de la serie de origen + salida de core-ai. */
export interface RunForecastResponse {
  series: Omit<DemandSeriesResponse, 'points'>;
  forecast: CoreAiForecastResponse;
}

@Injectable()
export class ForecastingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly coreAi: CoreAiClient,
  ) {}

  /**
   * HU-08-02 · Genera un pronóstico de demanda: arma la serie diaria desde
   * `sales_history` (mismo seam) y la envía a `core-ai`. Síncrono por ahora (el
   * wrap en BullMQ + `ForecastRun` es el siguiente incremento). Si el histórico no
   * alcanza el mínimo para inferir, devuelve 422.
   */
  async runForecast(
    tenantId: string,
    input: RunForecastInput,
  ): Promise<RunForecastResponse> {
    const series = await this.demandSeries(
      tenantId,
      input.scope,
      input.menuItemId,
      input.from,
      input.to,
    );

    if (series.points.length < MIN_POINTS_TO_FORECAST) {
      throw new UnprocessableEntityException(
        'Histórico insuficiente para pronosticar (se requieren al menos ' +
          `${MIN_POINTS_TO_FORECAST} días con datos).`,
      );
    }

    const forecast = await this.coreAi.runForecast({
      series_id: series.seriesId,
      frequency: series.frequency,
      horizon: input.horizon,
      history: series.points,
      engine: input.engine,
    });

    return {
      series: {
        scope: series.scope,
        seriesId: series.seriesId,
        label: series.label,
        frequency: series.frequency,
        observations: series.observations,
        spanDays: series.spanDays,
        dataQuality: series.dataQuality,
      },
      forecast,
    };
  }

  /**
   * E08 · Construye la serie de demanda diaria (zero-filled) desde `sales_history`.
   * La agregación por día (zona Lima, UTC-5 sin DST) y la suma de unidades las
   * hace Postgres (GROUP BY) — no se cargan todas las filas a memoria. Por defecto
   * usa TODO el histórico del tenant; `from`/`to` (ISO) la acotan, exigiendo
   * `from <= to`. `tenant_id` SIEMPRE del JWT; acceso vía `runInTenant` (RLS FORCE).
   */
  async demandSeries(
    tenantId: string,
    scope: 'total' | 'menuItem',
    menuItemId: string | undefined,
    fromIso: string | undefined,
    toIso: string | undefined,
  ): Promise<DemandSeriesResponse> {
    const { from, to } = this.parseWindow(fromIso, toIso);
    const menuId = scope === 'menuItem' ? (menuItemId as string) : null;

    return this.prisma.runInTenant(tenantId, async (tx) => {
      // `sold_on - interval '5 hours'` = día local Lima (la columna es timestamp
      // sin tz, en UTC). RLS filtra el tenant; nunca se filtra tenant_id en la app.
      const daily = await tx.$queryRaw<DailyRow[]>(Prisma.sql`
        SELECT to_char((sold_on - interval '5 hours')::date, 'YYYY-MM-DD') AS ds,
               SUM(qty)::int AS y
        FROM sales_history
        WHERE (${menuId}::uuid IS NULL OR menu_item_id = ${menuId}::uuid)
          AND (${from}::timestamp IS NULL OR sold_on >= ${from}::timestamp)
          AND (${to}::timestamp IS NULL OR sold_on <= ${to}::timestamp)
        GROUP BY 1
        ORDER BY 1
      `);

      const totals: DailyTotal[] = daily.map((r) => ({ ds: r.ds, y: r.y }));
      const seriesId = scope === 'menuItem' ? (menuItemId as string) : 'total';
      const label =
        scope === 'menuItem'
          ? await this.menuItemLabel(tx, menuItemId as string)
          : 'Demanda total';

      const series = zeroFillDailySeries(totals, seriesId, label);
      return {
        scope,
        seriesId: series.seriesId,
        label: series.label,
        frequency: 'D',
        observations: series.observations,
        spanDays: series.spanDays,
        dataQuality: series.dataQuality,
        points: series.points,
      };
    });
  }

  // Etiqueta del plato: nombre del MenuItem si existe; si fue borrado, el nombre
  // más reciente visto en el histórico; si no, el propio id.
  private async menuItemLabel(tx: Tx, menuItemId: string): Promise<string> {
    const item = await tx.menuItem.findFirst({
      where: { id: menuItemId },
      select: { name: true },
    });
    if (item) return item.name;
    const last = await tx.salesHistory.findFirst({
      where: { menuItemId },
      orderBy: { soldOn: 'desc' },
      select: { dishName: true },
    });
    return last?.dishName ?? menuItemId;
  }

  private parseWindow(
    fromIso: string | undefined,
    toIso: string | undefined,
  ): { from: Date | null; to: Date | null } {
    const from = fromIso ? new Date(fromIso) : null;
    const to = toIso ? new Date(toIso) : null;
    if (from && to && from.getTime() > to.getTime()) {
      throw new BadRequestException(
        'El rango es inválido: "from" debe ser <= "to"',
      );
    }
    return { from, to };
  }
}
