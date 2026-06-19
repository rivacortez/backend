import {
  BadGatewayException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  coreAiForecastResponseSchema,
  type CoreAiForecastResponse,
} from '../shared';
import { type HistoryPoint } from './sales-aggregation.util';

/** Body que espera `core-ai` en `POST /forecast/run` (snake_case, contrato Python). */
export interface CoreAiForecastRequest {
  series_id: string;
  frequency: 'D';
  horizon: number;
  history: HistoryPoint[];
  engine?: string;
}

/**
 * Cliente HTTP del microservicio de inferencia `core-ai` (FastAPI). NestJS
 * orquesta; core-ai infiere (`backend.md` §3). Síncrono por ahora: el wrap en
 * BullMQ (`ForecastRun` RUNNING/COMPLETED + SSE) es el siguiente incremento.
 *
 * La URL se toma de `CORE_AI_URL` (default `http://localhost:8000`, igual patrón
 * de env directo que `auth-db.client`). La respuesta se valida con Zod antes de
 * propagarse (defensa de borde: nunca confiar en la forma del upstream).
 */
@Injectable()
export class CoreAiClient {
  private readonly baseUrl = process.env.CORE_AI_URL ?? 'http://localhost:8000';

  async runForecast(
    request: CoreAiForecastRequest,
  ): Promise<CoreAiForecastResponse> {
    const response = await this.post('/forecast/run', request);

    if (!response.ok) {
      const detail = await this.safeDetail(response);
      throw new BadGatewayException(
        `core-ai respondió ${response.status}: ${detail}`,
      );
    }

    const parsed = coreAiForecastResponseSchema.safeParse(
      await this.safeJson(response),
    );
    if (!parsed.success) {
      throw new BadGatewayException(
        'core-ai devolvió una respuesta con forma inesperada',
      );
    }
    return parsed.data;
  }

  private async post(path: string, body: unknown): Promise<Response> {
    try {
      return await fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (cause) {
      throw new ServiceUnavailableException(
        `No se pudo contactar a core-ai en ${this.baseUrl}`,
        { cause: cause instanceof Error ? cause : undefined },
      );
    }
  }

  private async safeJson(response: Response): Promise<unknown> {
    try {
      return await response.json();
    } catch {
      return null;
    }
  }

  private async safeDetail(response: Response): Promise<string> {
    const body = await this.safeJson(response);
    if (
      body !== null &&
      typeof body === 'object' &&
      'detail' in body &&
      typeof (body as { detail: unknown }).detail === 'string'
    ) {
      return (body as { detail: string }).detail;
    }
    return response.statusText;
  }
}
