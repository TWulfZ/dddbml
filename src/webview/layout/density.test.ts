import { describe, it, expect } from 'vitest';
import { densityMetrics } from './density';

describe('densityMetrics', () => {
  it('returns three distinct profiles', () => {
    const compact = densityMetrics('compact');
    const cozy = densityMetrics('cozy');
    const comfortable = densityMetrics('comfortable');
    expect(compact.tableWidth).toBeLessThan(cozy.tableWidth);
    expect(cozy.tableWidth).toBeLessThan(comfortable.tableWidth);
    expect(compact.rowHeight).toBeLessThan(cozy.rowHeight);
    expect(cozy.rowHeight).toBeLessThan(comfortable.rowHeight);
    expect(compact.headerHeight).toBeLessThan(cozy.headerHeight);
    expect(cozy.headerHeight).toBeLessThan(comfortable.headerHeight);
  });

  it('cozy defaults match the CSS :root tokens (240 / 20 / 28)', () => {
    const cozy = densityMetrics('cozy');
    expect(cozy.tableWidth).toBe(240);
    expect(cozy.rowHeight).toBe(20);
    expect(cozy.headerHeight).toBe(28);
  });

  it('compact targets dense diagrams (≤200px wide)', () => {
    expect(densityMetrics('compact').tableWidth).toBeLessThanOrEqual(200);
  });
});
