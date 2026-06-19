import {
  BadGatewayException,
  GatewayTimeoutException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CoreAiClient, type CoreAiForecastRequest } from './core-ai.client';

const REQUEST: CoreAiForecastRequest = {
  series_id: 'total',
  frequency: 'D',
  horizon: 7,
  history: [
    { ds: '2024-01-01', y: 10 },
    { ds: '2024-01-02', y: 12 },
  ],
};

const VALID_RESPONSE = {
  series_id: 'total',
  engine: 'statsforecast',
  model: 'AutoETS',
  baseline: 'SeasonalNaive',
  frequency: 'D',
  points: [{ target_date: '2024-01-03', yhat: 11, yhat_lo: 8, yhat_hi: 14 }],
  backtest: null,
};

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: 'x',
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

describe('CoreAiClient', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('POSTea a /forecast/run y devuelve la respuesta parseada', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(VALID_RESPONSE));
    vi.stubGlobal('fetch', fetchMock);

    const result = await new CoreAiClient().runForecast(REQUEST);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/forecast\/run$/);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toMatchObject({
      series_id: 'total',
      horizon: 7,
    });
    expect(result.model).toBe('AutoETS');
    expect(result.points).toHaveLength(1);
  });

  it('propaga BadGateway cuando core-ai responde no-ok (con detail)', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse({ detail: 'engine timesfm no implementado' }, 501),
        ),
    );

    await expect(
      new CoreAiClient().runForecast(REQUEST),
    ).rejects.toBeInstanceOf(BadGatewayException);
  });

  it('lanza ServiceUnavailable cuando la red falla', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
    );

    await expect(
      new CoreAiClient().runForecast(REQUEST),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('lanza GatewayTimeout (504) cuando core-ai no responde a tiempo', async () => {
    // AbortSignal.timeout aborta con un error de nombre TimeoutError.
    const timeout = Object.assign(new Error('timed out'), {
      name: 'TimeoutError',
    });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(timeout));

    await expect(
      new CoreAiClient().runForecast(REQUEST),
    ).rejects.toBeInstanceOf(GatewayTimeoutException);
  });

  it('lanza BadGateway si la respuesta tiene forma inesperada', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ unexpected: true })),
    );

    await expect(
      new CoreAiClient().runForecast(REQUEST),
    ).rejects.toBeInstanceOf(BadGatewayException);
  });
});
