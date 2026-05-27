export type LodLevel = 'rect' | 'header' | 'full';

interface LodThresholds {
  mediumThreshold: number;
  lowThreshold: number;
}

/**
 * Level of detail selection based on zoom factor.
 *
 * rect   — zoom < lowThreshold:        just a colored rectangle, no text
 * header — zoom < mediumThreshold:     table name only, no columns
 * full   — zoom >= mediumThreshold:    full columns rendered
 *
 * Thresholds are user-configurable via VSC settings (see specs/10-settings.md).
 */
export function lodForZoom(zoom: number, thresholds: LodThresholds): LodLevel {
  if (zoom < thresholds.lowThreshold) return 'rect';
  if (zoom < thresholds.mediumThreshold) return 'header';
  return 'full';
}
