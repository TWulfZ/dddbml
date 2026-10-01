import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { UiDensity } from '../../shared/types';
import { store } from '../state/store';
import { columnCenterY, estimateSize } from './autoLayout';

const css = readFileSync(join(__dirname, '..', 'style.css'), 'utf8');

/** Pixel value of `prop` inside the first CSS rule whose whole selector is exactly `selector`. */
function px(selector: string, prop: string): number {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rule = new RegExp(`\\n\\s*${escaped} \\{([^}]*)\\}`).exec(css);
  if (!rule) throw new Error(`rule ${selector} not found`);
  const body = rule[1]!;
  const m = new RegExp(`(?:^|[\\s;{])${prop}:\\s*(\\d+)px`).exec(body);
  if (!m) throw new Error(`${prop} not found in ${selector}`);
  return Number(m[1]);
}

const initialSettings = store.getState().settings;
afterEach(() => store.getState().setSettings(initialSettings));

describe('estimateSize / columnCenterY mirror the rendered full-LOD table box', () => {
  const borderTop = px('.ddd-table', 'border-top');
  const border = px('.ddd-table', 'border');

  for (const density of ['compact', 'cozy', 'comfortable'] as UiDensity[]) {
    it(`${density}: height and column-row centres include the table borders`, () => {
      store.getState().setSettings({ ...initialSettings, ui: { ...initialSettings.ui, density } });
      const sel = `[data-density='${density}']`;
      const header = px(sel, '--ddd-table-header-h');
      const row = px(sel, '--ddd-table-row-h');
      const padCols = px(sel, '--ddd-table-pad-cols');

      // .ddd-table is border-box with an auto height: header + padded column list + both borders.
      expect(estimateSize(5).height).toBe(borderTop + header + 2 * padCols + 5 * row + border);
      expect(estimateSize(5).width).toBe(px(sel, '--ddd-table-w'));
      expect(columnCenterY(0)).toBe(borderTop + header + padCols + row / 2);
      expect(columnCenterY(3)).toBe(borderTop + header + padCols + 3 * row + row / 2);
    });
  }
});
