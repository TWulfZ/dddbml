/** Code-unit order: unlike `localeCompare`, identical on every machine regardless of ICU locale, so
 *  teammates on different locales produce the same layout and the same sidecar (audit F88). */
export function cmpCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
