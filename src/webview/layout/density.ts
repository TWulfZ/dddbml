import type { UiDensity } from '../../shared/types';

export interface DensityMetrics {
  tableWidth: number;
  rowHeight: number;
  headerHeight: number;
  colsPad: number;
  /** `.ddd-table` outer borders: the 3px accent stripe on top, 1px below. They add to the auto height. */
  borderTop: number;
  borderBottom: number;
}

/**
 * Chrome the renderer draws around an expanded group's tables (padding on every side + a header
 * strip on top). Shared with smart layout so arranged clusters reserve exactly this much room.
 */
export const GROUP_CONTAINER_PADDING = 24;
export const GROUP_CONTAINER_HEADER = 20;

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
      return { tableWidth: 200, rowHeight: 16, headerHeight: 22, colsPad: 4, borderTop: 3, borderBottom: 1 };
    case 'comfortable':
      return { tableWidth: 280, rowHeight: 26, headerHeight: 34, colsPad: 12, borderTop: 3, borderBottom: 1 };
    case 'cozy':
    default:
      return { tableWidth: 240, rowHeight: 20, headerHeight: 28, colsPad: 8, borderTop: 3, borderBottom: 1 };
  }
}
