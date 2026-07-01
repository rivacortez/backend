import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { PrismaService } from '../platform/prisma/prisma.service';
import type { DocumentCommitInput, DocumentCommitResponse } from '../shared';

/**
 * E11 Smart Onboarding — catalog entity creation service.
 *
 * Receives the (reviewed) preview payload and creates the corresponding
 * Prisma records inside `runInTenant` so every write is scoped to the
 * authenticated tenant (RLS FORCE). Idempotency is by name: existing
 * records (by exact case-insensitive name match) are skipped and added
 * to the `skipped` list — re-running commit never duplicates.
 *
 * Creation order (dependency graph):
 *   1. Ingredients       — standalone, no FK dependencies.
 *   2. MenuCategories    — standalone; names collected from menuItem.category.
 *   3. Recipes (stubs)   — one minimal stub per menu item (kind='dish').
 *   4. MenuItems         — depends on recipe + optional menu category.
 *
 * CASL policy: caller (controller) must have already verified manage Catalog.
 * tenant_id ALWAYS comes from the JWT claim — never from this payload.
 */
@Injectable()
export class DocumentCommitService {
  private readonly logger = new Logger(DocumentCommitService.name);

  constructor(private readonly prisma: PrismaService) {}

  async commit(
    tenantId: string,
    payload: DocumentCommitInput,
  ): Promise<DocumentCommitResponse> {
    return this.prisma.runInTenant(tenantId, async (tx) => {
      const skipped: string[] = [];
      let createdIngredients = 0;
      let createdMenuItems = 0;
      let createdCategories = 0;

      // -----------------------------------------------------------------------
      // Step 1 — Ingredients
      // Idempotency: exact name match (case-insensitive via Postgres LOWER()).
      // SKU is generated deterministically from the name (hash prefix) so that
      // re-running the same commit generates the same SKU and the unique
      // constraint on (tenant_id, sku) remains stable.
      // -----------------------------------------------------------------------
      for (const ing of payload.ingredients) {
        const existing = await tx.ingredient.findFirst({
          where: {
            deletedAt: null,
            name: { equals: ing.name, mode: 'insensitive' },
          },
          select: { id: true },
        });
        if (existing) {
          this.logger.debug(`ingredient skip (exists): ${ing.name}`);
          skipped.push(ing.name);
          continue;
        }
        const sku = generateSku(ing.name);
        // Ensure the generated SKU is not already taken (collision guard).
        const skuTaken = await tx.ingredient.findFirst({
          where: { sku },
          select: { id: true },
        });
        await tx.ingredient.create({
          data: {
            tenantId,
            sku: skuTaken ? `${sku}-${Date.now()}` : sku,
            name: ing.name,
            type: 'ingredient', // default for AI-imported items
            unit: ing.unit,
            unitCost: ing.estimatedCost ?? 0,
          },
        });
        createdIngredients += 1;
      }

      // -----------------------------------------------------------------------
      // Step 2 — MenuCategories
      // One category per unique name from menuItems; missing categories are
      // created with auto-incremented position. Position is assigned as
      // (existing count + 1) so new categories append after existing ones.
      // -----------------------------------------------------------------------
      const categoryIdByName = new Map<string, string>();
      const categoryNames = [
        ...new Set(
          payload.menuItems
            .map((m) => m.category?.trim())
            .filter((c): c is string => Boolean(c)),
        ),
      ];
      for (const catName of categoryNames) {
        const existing = await tx.menuCategory.findFirst({
          where: {
            deletedAt: null,
            name: { equals: catName, mode: 'insensitive' },
          },
          select: { id: true },
        });
        if (existing) {
          categoryIdByName.set(catName, existing.id);
          continue;
        }
        const count = await tx.menuCategory.count({
          where: { deletedAt: null },
        });
        const cat = await tx.menuCategory.create({
          data: { tenantId, name: catName, position: count + 1 },
          select: { id: true },
        });
        categoryIdByName.set(catName, cat.id);
        createdCategories += 1;
      }

      // -----------------------------------------------------------------------
      // Step 3 + 4 — Recipes (stubs) + MenuItems
      // One minimal Recipe (kind='dish') is created per menu item so that the
      // MenuItem.recipeId FK is satisfied. If a recipe with the same name
      // already exists it is reused (not duplicated).
      // MenuItems are idempotent by name (case-insensitive).
      // -----------------------------------------------------------------------
      for (const mi of payload.menuItems) {
        // 3a. Check if menu item already exists.
        const existingItem = await tx.menuItem.findFirst({
          where: {
            deletedAt: null,
            name: { equals: mi.name, mode: 'insensitive' },
          },
          select: { id: true },
        });
        if (existingItem) {
          this.logger.debug(`menuItem skip (exists): ${mi.name}`);
          skipped.push(mi.name);
          continue;
        }

        // 3b. Find or create a stub Recipe for this item.
        let recipeId: string;
        const existingRecipe = await tx.recipe.findFirst({
          where: {
            deletedAt: null,
            name: { equals: mi.name, mode: 'insensitive' },
          },
          select: { id: true },
        });
        if (existingRecipe) {
          recipeId = existingRecipe.id;
        } else {
          const recipe = await tx.recipe.create({
            data: {
              tenantId,
              name: mi.name,
              kind: 'dish',
              description: mi.description ?? null,
            },
            select: { id: true },
          });
          recipeId = recipe.id;
        }

        // 3c. Resolve menu category ID (may be undefined).
        const menuCategoryId = mi.category
          ? (categoryIdByName.get(mi.category.trim()) ?? null)
          : null;

        // 3d. Create the MenuItem.
        await tx.menuItem.create({
          data: {
            tenantId,
            recipeId,
            name: mi.name,
            price: mi.price,
            menuCategoryId,
            isActive: true,
          },
        });
        createdMenuItems += 1;
      }

      return {
        created: {
          ingredients: createdIngredients,
          menuItems: createdMenuItems,
          categories: createdCategories,
        },
        skipped,
      };
    });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Generate a deterministic, human-readable SKU for AI-imported ingredients.
 *
 * Format: `imt-{slug}-{hash6}` where:
 *   - `imt` prefix marks this as an "imported" ingredient.
 *   - slug is a URL-safe version of the name (max 30 chars).
 *   - hash6 is the first 6 hex chars of MD5(name.lower) — collision guard.
 *
 * The SKU is deterministic: the same name always produces the same SKU,
 * which means repeated commits for the same ingredient generate the same
 * candidate SKU (the service checks for SKU collisions independently).
 * Max output length: 4 + 30 + 1 + 6 = 41 chars (well under the 64-char limit).
 */
function generateSku(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // strip diacritics
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30);
  const hash = createHash('md5')
    .update(name.toLowerCase().trim())
    .digest('hex')
    .slice(0, 6);
  return `imt-${slug}-${hash}`;
}
