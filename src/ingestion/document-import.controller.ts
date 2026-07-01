import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
// Side-effect import: loads @fastify/multipart's TypeScript declaration merge,
// which augments FastifyRequest with .file() / .files() / .isMultipart().
import '@fastify/multipart';
import { type FastifyRequest } from 'fastify';
import { Audited } from '../audit/audited.decorator';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PoliciesGuard } from '../authz/policies.guard';
import { RequireAbility } from '../authz/require-ability.decorator';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import {
  documentCommitSchema,
  ok,
  type ApiResponse,
  type DocumentCommitInput,
  type DocumentCommitResponse,
  type DocumentPreviewResponse,
  type JwtClaims,
} from '../shared';
import { CoreAiExtractClient } from './core-ai-extract.client';
import { DocumentCommitService } from './document-commit.service';
import { DocumentExtractService } from './document-extract.service';

/**
 * E11 Smart Onboarding — document import endpoints.
 *
 * Two-step flow (preview → commit) so the user can review AI-extracted data
 * before anything is written to the database:
 *
 *   POST /import/document/preview  — multipart; no DB writes; returns AI preview.
 *   POST /import/document/commit   — JSON body; creates catalog entities in DB.
 *
 * CASL policy: `manage Catalog` → owner + manager only; staff → 403.
 * tenant_id ALWAYS comes from the JWT claim (never from path, query, or body).
 *
 * The preview endpoint uses Fastify's raw request API to read the multipart
 * file. `@fastify/multipart` is registered globally in main.ts; the import
 * statement at the top of this file loads the TypeScript augmentation so
 * TypeScript sees `.isMultipart()` and `.file()` on `FastifyRequest`.
 */
@Controller('import/document')
@UseGuards(JwtAuthGuard, PoliciesGuard)
export class DocumentImportController {
  constructor(
    private readonly extractor: DocumentExtractService,
    private readonly coreAi: CoreAiExtractClient,
    private readonly committer: DocumentCommitService,
  ) {}

  /**
   * Step 1 — preview: upload document, extract with AI, return structured preview.
   *
   * Accepts multipart/form-data with a single `file` field (PDF, xlsx, xls, csv).
   * Calls core-ai /extract/document; NOTHING is written to the DB.
   * The caller reviews the preview and submits it to /commit to persist.
   *
   * Accepted file types: PDF, .xlsx, .xls, .csv (max 10 MB).
   * manage Catalog → owner + manager; staff → 403.
   */
  @Post('preview')
  @HttpCode(HttpStatus.CREATED)
  @RequireAbility('manage', 'Catalog')
  @Audited('import.document.preview')
  async preview(
    @Req() req: FastifyRequest,
  ): Promise<ApiResponse<DocumentPreviewResponse>> {
    if (!req.isMultipart()) {
      throw new BadRequestException(
        'Se requiere Content-Type: multipart/form-data con un campo "file"',
      );
    }

    // Consume the multipart stream; toBuffer() reads the entire file into memory.
    // The 10 MB size guard is applied inside DocumentExtractService.extractText()
    // AFTER reading, which is safe for in-memory document files.
    //
    // @fastify/multipart throws "Multipart: Boundary not found" at the plugin
    // level (before route handler) when Content-Type header is set but lacks a
    // valid boundary. We convert that plugin error to a clean 400 so the caller
    // gets a consistent error shape rather than a raw 500.
    let part: Awaited<ReturnType<typeof req.file>>;
    try {
      part = await req.file();
    } catch {
      throw new BadRequestException(
        'Se requiere multipart/form-data con un campo "file" válido',
      );
    }
    if (!part) {
      throw new BadRequestException(
        'No se recibió ningún archivo en el campo "file"',
      );
    }

    const buffer = await part.toBuffer();
    const filename = part.filename ?? 'document';
    const mimetype = part.mimetype ?? '';

    // Extract plain text from the file buffer (PDF/xlsx/csv).
    const { text, type } = await this.extractor.extractText(
      buffer,
      filename,
      mimetype,
    );

    // Call core-ai to extract structured menu/ingredient data from the text.
    const extracted = await this.coreAi.extract({
      text,
      target: 'auto',
      currency: 'PEN',
    });

    return ok({
      menuItems: extracted.menuItems,
      ingredients: extracted.ingredients,
      source: { type, filename },
      provider: extracted.provider,
    });
  }

  /**
   * Step 2 — commit: create catalog entities from the (reviewed) preview payload.
   *
   * The body is the (optionally edited) preview. Zod re-validates before any
   * DB write: negative prices → 400, absurd prices > S/9 999 → 400.
   * All writes happen inside runInTenant() → RLS FORCE scopes every row.
   * Idempotent: re-submitting the same payload skips already-existing items.
   *
   * manage Catalog → owner + manager; staff → 403.
   */
  @Post('commit')
  @HttpCode(HttpStatus.CREATED)
  @RequireAbility('manage', 'Catalog')
  @Audited('import.document.commit')
  async commit(
    @CurrentUser() claims: JwtClaims,
    @Body(new ZodValidationPipe(documentCommitSchema))
    body: DocumentCommitInput,
  ): Promise<ApiResponse<DocumentCommitResponse>> {
    const result = await this.committer.commit(claims.tenant_id, body);
    return ok(result);
  }
}
