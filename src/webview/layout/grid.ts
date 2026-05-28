import { store } from '../state/store';

/**
 * Returns a coordinate snapper honoring the global magnet (snap-to-grid) setting.
 * When magnet mode is off, snapping degrades to plain integer rounding (current behavior).
 */
export function gridSnapper(): (n: number) => number {
  const { ui } = store.getState().settings;
  if (!ui.snapToGrid || ui.gridSize <= 0) return Math.round;
  const g = ui.gridSize;
  return (n: number) => Math.round(n / g) * g;
}
