import type { UiDensity } from '../../shared/types';

export interface DensityMetrics {
  tableWidth: number;
  rowHeight: number;
  headerHeight: number;
  colsPad: number;
}

/**
 * Pixel mirror of the CSS density tokens declared in style.css `@layer tokens`.
 * Source of truth: specs/12-design-system.md (Density system table).
 *
 * Used by auto-layout, edge routing, and spatial index — everywhere the layout
 * needs to know table footprint without measuring the DOM.
 */
export function densityMetrics(d: UiDensity): DensityMetrics {
  switch (d) {
    case 'compact':
      return { tableWidth: 200, rowHeight: 16, headerHeight: 22, colsPad: 4 };
    case 'comfortable':
      return { tableWidth: 280, rowHeight: 26, headerHeight: 34, colsPad: 12 };
    case 'cozy':
    default:
      return { tableWidth: 240, rowHeight: 20, headerHeight: 28, colsPad: 8 };
  }
}
