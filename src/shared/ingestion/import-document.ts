import { z } from 'zod';

/**
 * E11 Smart Onboarding — document import contracts (Zod v4 = única fuente de verdad).
 *
 * Two-step flow:
 *   1. POST /import/document/preview  — multipart upload; returns extracted preview.
 *   2. POST /import/document/commit   — JSON body (reviewed preview); creates catalog entities.
 *
 * Invariants:
 *   - price: 0 ≤ price ≤ 9 999 (absurd prices rejected at commit step).
 *   - estimatedCost ≥ 0 when present.
 *   - tenant_id ALWAYS from JWT claim — NEVER in these schemas.
 *   - Pydantic mirror: team-core-ai/app/extract/schemas.py.
 */

// ---------------------------------------------------------------------------
// Shared item schemas (used in both preview response and commit request)
// ---------------------------------------------------------------------------

/** A menu item extracted from a restaurant document. */
export const extractedMenuItemSchema = z.object({
  name: z.string().trim().min(1).max(200),
  /** Sell price in PEN. Conservative: 0 means "present but unclear". */
  price: z.number().nonnegative(),
  // .nullish() = nullable().optional() — Python None serialises to JSON null,
  // so we accept both null and undefined to keep the schema in sync with the
  // Pydantic mirror (team-core-ai/app/extract/schemas.py).
  category: z.string().trim().min(1).max(100).nullish(),
  description: z.string().trim().min(1).max(500).nullish(),
});
export type ExtractedMenuItem = z.infer<typeof extractedMenuItemSchema>;

/** An ingredient extracted from a restaurant document. */
export const extractedIngredientSchema = z.object({
  name: z.string().trim().min(1).max(200),
  unit: z.string().trim().min(1).max(50),
  // Same nullish() rationale: Python None → JSON null (Pydantic mirror).
  estimatedCost: z.number().nonnegative().nullish(),
});
export type ExtractedIngredient = z.infer<typeof extractedIngredientSchema>;

// ---------------------------------------------------------------------------
// Internal: NestJS → core-ai /extract/document request/response
// ---------------------------------------------------------------------------

/** Body sent by NestJS to core-ai POST /extract/document. */
export const coreAiExtractRequestSchema = z.object({
  text: z.string().min(1).max(200_000),
  target: z.enum(['menu', 'ingredients', 'auto']),
  currency: z.string().default('PEN'),
});
export type CoreAiExtractRequest = z.infer<typeof coreAiExtractRequestSchema>;

/** Response from core-ai POST /extract/document. */
export const coreAiExtractResponseSchema = z.object({
  menuItems: z.array(extractedMenuItemSchema),
  ingredients: z.array(extractedIngredientSchema),
  provider: z.string(),
  model: z.string(),
});
export type CoreAiExtractResponse = z.infer<typeof coreAiExtractResponseSchema>;

// ---------------------------------------------------------------------------
// Public API: preview response
// ---------------------------------------------------------------------------

/** Response of POST /api/import/document/preview. Nothing is written to DB yet. */
export const documentPreviewResponseSchema = z.object({
  menuItems: z.array(extractedMenuItemSchema),
  ingredients: z.array(extractedIngredientSchema),
  source: z.object({
    type: z.enum(['pdf', 'xlsx', 'xls', 'csv', 'unknown']),
    filename: z.string(),
  }),
  provider: z.string(),
});
export type DocumentPreviewResponse = z.infer<
  typeof documentPreviewResponseSchema
>;

// ---------------------------------------------------------------------------
// Public API: commit request / response
// ---------------------------------------------------------------------------

/**
 * Body of POST /api/import/document/commit.
 * The user may edit the preview before committing; Zod re-validates here.
 *
 * Business rules enforced:
 *   - price ≤ 9 999 (absurd price guard — a menu item costing S/10 000+ is clearly wrong).
 *   - price ≥ 0 (no negative prices).
 *   - estimatedCost ≥ 0 when present.
 */
export const documentCommitSchema = z.object({
  menuItems: z.array(
    extractedMenuItemSchema.extend({
      price: z
        .number()
        .nonnegative('El precio no puede ser negativo')
        .max(9_999, 'El precio parece incorrecto (máximo S/9 999)'),
    }),
  ),
  ingredients: z.array(extractedIngredientSchema),
});
export type DocumentCommitInput = z.infer<typeof documentCommitSchema>;

/** Summary of what was created/skipped by POST /api/import/document/commit. */
export const documentCommitResponseSchema = z.object({
  created: z.object({
    ingredients: z.number().int().nonnegative(),
    menuItems: z.number().int().nonnegative(),
    categories: z.number().int().nonnegative(),
  }),
  /** Names of items that already existed (idempotent skip). */
  skipped: z.array(z.string()),
});
export type DocumentCommitResponse = z.infer<
  typeof documentCommitResponseSchema
>;
