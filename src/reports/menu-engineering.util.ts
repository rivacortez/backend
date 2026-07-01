import { Prisma } from '@prisma/client';

/**
 * HU-07-11 · Kasavana-Smith menu engineering matrix — pure classification logic.
 *
 * No NestJS DI, no DB access. All functions take Prisma.Decimal values so they
 * stay accurate (no floating-point error on money comparisons) and are testable
 * in isolation via `src/reports/menu-engineering.util.spec.ts`.
 *
 * Reference: Kasavana & Smith (1982), "Menu Engineering: A Practical Guide to
 * Menu Analysis". The four quadrants cross popularity (units sold) with
 * profitability (contribution margin = price − food cost).
 */

// The four quadrants of the Kasavana-Smith matrix.
export type MenuEngClassification = 'star' | 'plowhorse' | 'puzzle' | 'dog';

// Actionable recommendation derived from each quadrant.
export type MenuEngRecommendation =
  | 'promote'
  | 'reprice_or_reduce_portion'
  | 'reposition_or_rename'
  | 'remove_or_rework';

/**
 * Industry-standard popularity factor for menu engineering.
 *
 * An item is "high popularity" when its share of total units sold in the period
 * is ≥ `0.70 × (1/N)`, where N is the number of items in the analysis.  The
 * 70% multiplier is the canonical Kasavana-Smith threshold — it gives every item
 * a slightly below-average share as the minimum to qualify, filtering out items
 * that are underperforming relative to an equal distribution.
 */
export const POPULARITY_FACTOR = new Prisma.Decimal('0.70');

const RECOMMENDATION_MAP: Record<MenuEngClassification, MenuEngRecommendation> =
  {
    star: 'promote',
    plowhorse: 'reprice_or_reduce_portion',
    puzzle: 'reposition_or_rename',
    dog: 'remove_or_rework',
  };

/**
 * Classifies a single menu item into one of the four Kasavana-Smith quadrants.
 *
 * @param popularityShare  - This item's fraction of total units sold in the period
 *                           (unitsSold / totalUnits). Zero when there were no sales.
 * @param popularityCutoff - `POPULARITY_FACTOR / N` = 0.70 × (1/N). The minimum
 *                           share for an item to be considered "high popularity".
 * @param contributionMargin - `price − foodCost` for this item (PEN, Decimal).
 * @param avgContributionMargin - Simple (unweighted) average CM across all N active
 *                                menu items. Items at or above this average are
 *                                "high profitability". Unweighted because the matrix
 *                                evaluates inherent margin potential, not volume.
 */
export function classifyDish(
  popularityShare: Prisma.Decimal,
  popularityCutoff: Prisma.Decimal,
  contributionMargin: Prisma.Decimal,
  avgContributionMargin: Prisma.Decimal,
): MenuEngClassification {
  const highPop = popularityShare.gte(popularityCutoff);
  const highProfit = contributionMargin.gte(avgContributionMargin);
  if (highPop && highProfit) return 'star';
  if (highPop) return 'plowhorse';
  if (highProfit) return 'puzzle';
  return 'dog';
}

/** Maps a classification to its standard actionable recommendation. */
export function recommendationFor(
  classification: MenuEngClassification,
): MenuEngRecommendation {
  return RECOMMENDATION_MAP[classification];
}
