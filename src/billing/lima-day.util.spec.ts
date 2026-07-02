import { describe, expect, it } from 'vitest';
import { limaDayKey, startOfLimaDay } from './lima-day.util';

// QA-07 (bugfix) · America/Lima = UTC-5 fijo. Medianoche local (00:00 Lima) =
// 05:00 UTC del mismo día calendario Lima.
describe('lima-day.util', () => {
  describe('startOfLimaDay', () => {
    it('returns 05:00 UTC for an instant in the middle of the Lima day', () => {
      // 2026-07-01 15:30 UTC = 2026-07-01 10:30 Lima.
      const at = new Date('2026-07-01T15:30:00Z');
      expect(startOfLimaDay(at).toISOString()).toBe('2026-07-01T05:00:00.000Z');
    });

    it('crosses midnight correctly: 04:59 UTC is still the PREVIOUS Lima day', () => {
      // 2026-07-01 04:59 UTC = 2026-06-30 23:59 Lima (one minute before midnight).
      const at = new Date('2026-07-01T04:59:00Z');
      expect(startOfLimaDay(at).toISOString()).toBe('2026-06-30T05:00:00.000Z');
    });

    it('crosses midnight correctly: 05:00 UTC is already the NEW Lima day', () => {
      // 2026-07-01 05:00 UTC = 2026-07-01 00:00 Lima (exact midnight).
      const at = new Date('2026-07-01T05:00:00Z');
      expect(startOfLimaDay(at).toISOString()).toBe('2026-07-01T05:00:00.000Z');
    });
  });

  describe('limaDayKey', () => {
    it('returns the Lima calendar day, not the UTC one, near midnight', () => {
      // 2026-07-01 02:00 UTC = 2026-06-30 21:00 Lima → previous day in Lima.
      const at = new Date('2026-07-01T02:00:00Z');
      expect(limaDayKey(at)).toBe('2026-06-30');
    });

    it('returns the same day for a mid-day instant', () => {
      const at = new Date('2026-07-01T18:00:00Z');
      expect(limaDayKey(at)).toBe('2026-07-01');
    });
  });
});
