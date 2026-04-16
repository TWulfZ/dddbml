import * as dagre from '@dagrejs/dagre';
import type { QualifiedName, Ref, Table } from '../../shared/types';

export interface NodeSize {
  width: number;
  height: number;
}

/**
 * Runs dagre top-down layout over all tables.
 * Returns a Map of table name → center position.
 *
 * Call only when needed (e.g., tables with no layout entry), NOT on every re-render.
 */
export function autoLayout(
  tables: Table[],
  refs: Ref[],
  sizeOf: (name: QualifiedName) => NodeSize,
): Map<QualifiedName, { x: number; y: number }> {
  const g = new dagre.graphlib.Graph({ multigraph: true, compound: false });
  g.setGraph({
    rankdir: 'TB',
    nodesep: 48,
    ranksep: 96,
    marginx: 32,
    marginy: 32,
  });
  g.setDefaultEdgeLabel(() => ({}));

  for (const t of tables) {
    const size = sizeOf(t.name);
    g.setNode(t.name, { width: size.width, height: size.height });
  }

  for (const r of refs) {
    if (!g.hasNode(r.source.table) || !g.hasNode(r.target.table)) continue;
    g.setEdge(r.source.table, r.target.table, { weight: 1 }, r.id);
  }

  dagre.layout(g);

  const out = new Map<QualifiedName, { x: number; y: number }>();
  for (const t of tables) {
    const node = g.node(t.name) as dagre.Node | undefined;
    if (node && typeof node.x === 'number' && typeof node.y === 'number') {
      out.set(t.name, { x: Math.round(node.x - node.width / 2), y: Math.round(node.y - node.height / 2) });
    }
  }
  return out;
}

/** Geometric constants used across router, renderer, and layout. MUST match CSS `.ddd-table__header`, `.ddd-table__col`, `.ddd-table__cols`. */
export const TABLE_HEADER_H = 28;
export const TABLE_ROW_H = 20;
export const TABLE_WIDTH = 240;
export const TABLE_BOTTOM_PAD = 8; // matches .ddd-table__cols padding (4 top + 4 bottom)

/**
 * Estimate node height based on column count. Width fixed.
 */
export function estimateSize(columnCount: number): NodeSize {
  return { width: TABLE_WIDTH, height: TABLE_HEADER_H + columnCount * TABLE_ROW_H + TABLE_BOTTOM_PAD };
}

/** Y offset (from table top) for the vertical center of a column row at `index`. */
export function columnCenterY(index: number): number {
  // 4px top-padding of .ddd-table__cols before rows start.
  return TABLE_HEADER_H + 4 + index * TABLE_ROW_H + TABLE_ROW_H / 2;
}
