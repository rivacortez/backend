import { describe, expect, it } from 'vitest';
import { Prisma } from '@prisma/client';
import {
  classifyDish,
  recommendationFor,
  POPULARITY_FACTOR,
} from './menu-engineering.util';

// Shorthand to avoid noise in test expressions.
const d = (v: number | string) => new Prisma.Decimal(v);

/**
 * Unit tests for the Kasavana-Smith classification logic (HU-07-11).
 *
 * Baseline scenario: N=2 items.
 *   popularityCutoff = 0.70 × (1/2) = 0.35
 *   avgContributionMargin = (40 + 5) / 2 = 22.50
 */
describe('menu-engineering.util — classifyDish (HU-07-11)', () => {
  // Cutoff for N=2 items.
  const cutoff = POPULARITY_FACTOR.div(2); // 0.35
  const avgCM = d('22.50');

  // --- Four quadrant tests ---

  it('STAR = high popularity + high profitability', () => {
    const result = classifyDish(
      d('0.90'), // popularityShare >= cutoff (0.35) → high pop
      cutoff,
      d('40.00'), // CM >= avgCM (22.50) → high profit
      avgCM,
    );
    expect(result).toBe('star');
  });

  it('PLOWHORSE = high popularity + low profitability', () => {
    const result = classifyDish(
      d('0.90'), // high pop
      cutoff,
      d('5.00'), // CM < avgCM → low profit
      avgCM,
    );
    expect(result).toBe('plowhorse');
  });

  it('PUZZLE = low popularity + high profitability', () => {
    const result = classifyDish(
      d('0.10'), // popularityShare < cutoff → low pop
      cutoff,
      d('40.00'), // high profit
      avgCM,
    );
    expect(result).toBe('puzzle');
  });

  it('DOG = low popularity + low profitability', () => {
    const result = classifyDish(
      d('0.10'), // low pop
      cutoff,
      d('5.00'), // low profit
      avgCM,
    );
    expect(result).toBe('dog');
  });

  // --- Boundary conditions ---

  it('boundary: popularityShare == cutoff is treated as HIGH popularity (gte)', () => {
    // An item exactly at the cutoff qualifies as high-popularity (gte, not gt).
    const result = classifyDish(cutoff, cutoff, d('40.00'), avgCM);
    expect(result).toBe('star'); // high pop + high profit
  });

  it('boundary: CM == avgCM is treated as HIGH profitability (gte)', () => {
    // An item with CM exactly equal to the average qualifies as high-profitability.
    const result = classifyDish(d('0.90'), cutoff, avgCM, avgCM);
    expect(result).toBe('star'); // high pop + high profit
  });

  it('N=1: single item with sales gets popularityShare=1.0 >= 0.70 → STAR', () => {
    // With a single item, CM = avgCM so both thresholds are tied → star.
    const singleCM = d('30.00');
    const result = classifyDish(
      d('1.00'), // 100% of units sold
      POPULARITY_FACTOR, // cutoff for N=1 = 0.70
      singleCM,
      singleCM, // avgCM equals its own CM
    );
    expect(result).toBe('star');
  });

  it('zero sales: popularityShare=0.00 < cutoff → low popularity', () => {
    // When an item has no sales its share is zero regardless of the cutoff.
    const result = classifyDish(d('0.00'), cutoff, d('40.00'), avgCM);
    expect(result).toBe('puzzle'); // low pop + high profit
  });
});

describe('menu-engineering.util — recommendationFor (HU-07-11)', () => {
  it('star → promote', () => {
    expect(recommendationFor('star')).toBe('promote');
  });

  it('plowhorse → reprice_or_reduce_portion', () => {
    expect(recommendationFor('plowhorse')).toBe('reprice_or_reduce_portion');
  });

  it('puzzle → reposition_or_rename', () => {
    expect(recommendationFor('puzzle')).toBe('reposition_or_rename');
  });

  it('dog → remove_or_rework', () => {
    expect(recommendationFor('dog')).toBe('remove_or_rework');
  });
});

describe('menu-engineering.util — POPULARITY_FACTOR', () => {
  it('POPULARITY_FACTOR is exactly 0.70 (Kasavana-Smith standard threshold)', () => {
    expect(POPULARITY_FACTOR.toFixed(2)).toBe('0.70');
  });

  it('cutoff scales correctly with N', () => {
    // N=2 → 0.35, N=4 → 0.175, N=10 → 0.07
    expect(POPULARITY_FACTOR.div(2).toFixed(4)).toBe('0.3500');
    expect(POPULARITY_FACTOR.div(4).toFixed(4)).toBe('0.1750');
    expect(POPULARITY_FACTOR.div(10).toFixed(4)).toBe('0.0700');
  });
});
