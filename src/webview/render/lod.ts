export type LodLevel = 'rect' | 'full';

interface LodThresholds {
  lowThreshold: number;
}

/**
 * Level of detail selection based on zoom factor.
 *
 * rect — zoom < lowThreshold:  just a colored rectangle, no text (name on hover)
 * full — zoom >= lowThreshold: full columns rendered
 *
 * The threshold is user-configurable via VSC settings (see specs/10-settings.md).
 */
export function lodForZoom(zoom: number, thresholds: LodThresholds): LodLevel {
  return zoom < thresholds.lowThreshold ? 'rect' : 'full';
}
