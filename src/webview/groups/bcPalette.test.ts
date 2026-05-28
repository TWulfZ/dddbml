import { describe, it, expect } from 'vitest';
import { BC_PALETTE_SIZE, bcColorFor, bcIndex, bcVar, withAlpha } from './bcPalette';

describe('bcIndex', () => {
  it('returns 1..BC_PALETTE_SIZE for any input', () => {
    const names = ['', 'a', 'orders', 'Catalog.Product', 'Aggregate Root', 'なまえ'];
    for (const name of names) {
      const i = bcIndex(name);
      expect(i).toBeGreaterThanOrEqual(1);
      expect(i).toBeLessThanOrEqual(BC_PALETTE_SIZE);
    }
  });

  it('is deterministic', () => {
    expect(bcIndex('billing')).toBe(bcIndex('billing'));
    expect(bcIndex('catalog')).toBe(bcIndex('catalog'));
  });

  it('distributes across the palette for typical BC names', () => {
    const seen = new Set<number>();
    const names = ['billing', 'catalog', 'identity', 'shipping', 'inventory', 'reviews', 'analytics', 'auth', 'payments', 'support', 'docs', 'tracing'];
    for (const n of names) seen.add(bcIndex(n));
    // Hash should hit at least 6 distinct slots for 12 different names.
    expect(seen.size).toBeGreaterThanOrEqual(6);
  });
});

describe('bcVar / bcColorFor', () => {
  it('returns CSS var refs', () => {
    expect(bcVar(1, 'border')).toBe('var(--ddd-bc-1-border)');
    expect(bcVar(12, 'surface')).toBe('var(--ddd-bc-12-surface)');
  });

  it('clamps out-of-range indices', () => {
    expect(bcVar(13, 'border')).toBe('var(--ddd-bc-1-border)');
    expect(bcVar(0, 'border')).toBe('var(--ddd-bc-12-border)');
  });

  it('bcColorFor returns border var by default', () => {
    expect(bcColorFor('orders')).toMatch(/^var\(--ddd-bc-\d+-border\)$/);
  });

  it('bcColorFor supports surface role', () => {
    expect(bcColorFor('orders', 'surface')).toMatch(/^var\(--ddd-bc-\d+-surface\)$/);
  });
});

describe('withAlpha', () => {
  it('wraps var() refs in color-mix', () => {
    expect(withAlpha('var(--ddd-bc-1-border)', 0.5)).toBe(
      'color-mix(in srgb, var(--ddd-bc-1-border) 50%, transparent 50%)',
    );
  });

  it('converts hex to rgba', () => {
    expect(withAlpha('#3366ff', 0.25)).toBe('rgba(51, 102, 255, 0.25)');
  });

  it('expands 3-digit hex', () => {
    expect(withAlpha('#abc', 0.5)).toBe('rgba(170, 187, 204, 0.5)');
  });

  it('converts hsl to hsla', () => {
    expect(withAlpha('hsl(120, 50%, 50%)', 0.4)).toBe('hsla(120, 50%, 50%, 0.4)');
  });

  it('passes through hsla unchanged', () => {
    expect(withAlpha('hsla(120, 50%, 50%, 0.4)', 0.1)).toBe('hsla(120, 50%, 50%, 0.4)');
  });
});
