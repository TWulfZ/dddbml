import { describe, expect, it } from 'vitest';
import { fitScale } from './raster';

describe('fitScale', () => {
  it('passes the desired scale through when within limits', () => {
    expect(fitScale(800, 600, 2)).toEqual({ scale: 2, clamped: false });
  });

  it('keeps small diagrams unclamped', () => {
    const r = fitScale(800, 600, 3);
    expect(r.clamped).toBe(false);
    expect(r.scale).toBe(3);
  });

  it('clamps when a dimension would exceed the max', () => {
    // 10000px wide at 3x = 30000 > 16384 → must clamp.
    const r = fitScale(10000, 500, 3);
    expect(r.clamped).toBe(true);
    expect(r.scale * 10000).toBeLessThanOrEqual(16384 + 1);
  });

  it('clamps when total area would exceed the budget', () => {
    const r = fitScale(8000, 8000, 3);
    expect(r.clamped).toBe(true);
    // area stays under the 64 Mpx budget (~256 MB RGBA)
    expect(r.scale * 8000 * r.scale * 8000).toBeLessThanOrEqual(64 * 1024 * 1024 + 1);
  });

  it('is a no-op for degenerate sizes', () => {
    expect(fitScale(0, 100, 2)).toEqual({ scale: 2, clamped: false });
  });
});
