import type { Column, Table, UiDensity } from '../../shared/types';
import { densityMetrics } from './density';

export const PAD_X: Record<UiDensity, number> = { compact: 6, cozy: 10, comfortable: 12 };
export const TEXT_PX: Record<UiDensity, number> = { compact: 11, cozy: 12, comfortable: 13 };
export const PRINT_FONT = 'Arial, sans-serif';
export const MONO = 'ui-monospace, Menlo, Consolas, monospace';
export const KEY_GUTTER = 40;

export type MeasureText = (value: string, px: number, family: string, weight?: number) => number;

export const estimateTextWidth: MeasureText = (value, px) => Array.from(value).length * px;
let context: CanvasRenderingContext2D | null | undefined;

export const measurePrintText: MeasureText = (value, px, family, weight = 400) => {
  if (context === undefined && typeof document !== 'undefined') {
    context = document.createElement('canvas').getContext('2d');
  }
  if (!context) return estimateTextWidth(value, px, family, weight);
  context.font = `${weight} ${px}px ${family}`;
  return context.measureText(value).width;
};

export function typeLabel(column: Pick<Column, 'type' | 'notNull' | 'unique'>): string {
  return column.type + (column.notNull ? ' NN' : '') + (column.unique ? ' U' : '');
}

const widths = new WeakMap<Table, Partial<Record<UiDensity, number>>>();

export function printTableWidth(table: Table, density: UiDensity, measure: MeasureText = measurePrintText): number {
  const cached = measure === measurePrintText ? widths.get(table) ?? {} : undefined;
  const existing = cached?.[density];
  if (existing !== undefined) return existing;
  const px = TEXT_PX[density];
  let name = 0, type = 0;
  for (const column of table.columns) {
    name = Math.max(name, measure(column.name, px, PRINT_FONT, column.pk ? 600 : 400) + (column.note ? 10 : 0));
    type = Math.max(type, measure(typeLabel(column), px - 1, MONO));
  }
  const title = table.schemaName === 'public' ? table.tableName : `${table.schemaName}.${table.tableName}`;
  const width = Math.max(densityMetrics(density).tableWidth, Math.ceil(2 * PAD_X[density] + Math.max(
    measure(title, px, PRINT_FONT, 600) + 72, // Space for the editor's header controls.
    KEY_GUTTER + name + 14 + type,
  )));
  if (cached) {
    cached[density] = width;
    widths.set(table, cached);
  }
  return width;
}
