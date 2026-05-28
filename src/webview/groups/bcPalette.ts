/**
 * Bounded-context palette — 12 colors curated for DDD diagrams in VSCode dark themes.
 * Source of truth: specs/12-design-system.md (Bounded-context palette).
 *
 * Each index maps to a pair of CSS custom properties:
 *   --ddd-bc-N-surface  — tinted fill (used as the table tint and group container fill)
 *   --ddd-bc-N-border   — saturated stroke (used for the table accent stripe and group label)
 */
export const BC_PALETTE_SIZE = 12;

export type BcRole = 'surface' | 'border';

/** Deterministic name → palette index (1..12). Same string ⇒ same color across reloads. */
export function bcIndex(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  return (Math.abs(h) % BC_PALETTE_SIZE) + 1;
}

/** Returns the CSS var reference for the palette slot at `idx` (1..12). */
export function bcVar(idx: number, role: BcRole): string {
  const clamped = ((Math.abs(idx) - 1 + BC_PALETTE_SIZE) % BC_PALETTE_SIZE) + 1;
  return `var(--ddd-bc-${clamped}-${role})`;
}

/** Convenience: deterministic color var() for a name. */
export function bcColorFor(name: string, role: BcRole = 'border'): string {
  return bcVar(bcIndex(name), role);
}

/**
 * Mix a color with transparency. Handles:
 *   - CSS var() references (paletted colors) → uses `color-mix`
 *   - legacy hex (#rgb / #rrggbb) → builds an `rgba()` (compatibility with old layout.json)
 *   - legacy hsl(...) → builds an `hsla()` (compatibility with old layout.json)
 *
 * `alpha` is 0..1.
 */
export function withAlpha(color: string, alpha: number): string {
  const pct = Math.round(alpha * 100);
  const transparentPct = 100 - pct;

  if (color.startsWith('var(') || color.startsWith('color-mix(')) {
    return `color-mix(in srgb, ${color} ${pct}%, transparent ${transparentPct}%)`;
  }
  if (color.startsWith('hsl(')) {
    return color.replace('hsl(', 'hsla(').replace(')', `, ${alpha})`);
  }
  if (color.startsWith('hsla(')) {
    return color;
  }
  if (color.startsWith('#')) {
    const hex = color.slice(1);
    const n = hex.length === 3
      ? hex.split('').map((c) => c + c).join('')
      : hex.padEnd(6, '0');
    const r = parseInt(n.slice(0, 2), 16);
    const g = parseInt(n.slice(2, 4), 16);
    const b = parseInt(n.slice(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
  return color;
}
