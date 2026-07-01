import {
  BadGatewayException,
  GatewayTimeoutException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  coreAiExtractResponseSchema,
  type CoreAiExtractRequest,
  type CoreAiExtractResponse,
} from '../shared';

// Document extraction can be slower than chat for large PDFs — allow 30 s.
// Configurable via CORE_AI_TIMEOUT_MS (shared with the forecasting client).
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * HTTP client for core-ai's document extraction endpoint (E11 Smart Onboarding).
 *
 * Mirrors the CoreAiChatClient pattern (backend.md §3):
 *   - NestJS calls core-ai over HTTP (POST /extract/document).
 *   - core-ai runs LLM inference; NestJS owns DB writes, RLS, CASL.
 *   - Responses are Zod-validated at the edge before propagation.
 *
 * Base URL: CORE_AI_URL (default http://localhost:8000).
 * Timeout:  CORE_AI_TIMEOUT_MS (default 30 000 ms).
 */
@Injectable()
export class CoreAiExtractClient {
  private readonly logger = new Logger(CoreAiExtractClient.name);
  private readonly baseUrl = process.env.CORE_AI_URL ?? 'http://localhost:8000';
  private readonly timeoutMs = this.resolveTimeout();

  /**
   * Call core-ai to extract structured menu/ingredient data from document text.
   *
   * The NestJS backend converts the uploaded file to plain text before this call;
   * core-ai only does LLM inference and never touches the business database.
   */
  async extract(request: CoreAiExtractRequest): Promise<CoreAiExtractResponse> {
    const response = await this.post('/extract/document', request);

    if (!response.ok) {
      const detail = await this.safeDetail(response);
      throw new BadGatewayException(
        `core-ai /extract/document respondió ${response.status}: ${detail}`,
      );
    }

    const parsed = coreAiExtractResponseSchema.safeParse(
      await this.safeJson(response),
    );
    if (!parsed.success) {
      throw new BadGatewayException(
        'core-ai devolvió una respuesta de extracción con forma inesperada',
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
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (cause) {
      if (
        cause instanceof Error &&
        (cause.name === 'TimeoutError' || cause.name === 'AbortError')
      ) {
        throw new GatewayTimeoutException(
          `core-ai no respondió en ${this.timeoutMs}ms`,
        );
      }
      throw new ServiceUnavailableException(
        `No se pudo contactar a core-ai en ${this.baseUrl}`,
        { cause: cause instanceof Error ? cause : undefined },
      );
    }
  }

  private resolveTimeout(): number {
    const v = Number(process.env.CORE_AI_TIMEOUT_MS);
    return Number.isFinite(v) && v > 0 ? v : DEFAULT_TIMEOUT_MS;
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
      typeof (body as Record<string, unknown>)['detail'] === 'string'
    ) {
      return (body as Record<string, string>)['detail'] ?? response.statusText;
    }
    return response.statusText;
  }
}
