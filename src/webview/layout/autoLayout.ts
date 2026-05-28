import * as dagre from '@dagrejs/dagre';
import type { QualifiedName, Ref, Table } from '../../shared/types';
import { store } from '../state/store';
import { densityMetrics } from './density';

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
    const node = g.node(t.name) as { x?: number; y?: number; width: number; height: number } | undefined;
    if (node && typeof node.x === 'number' && typeof node.y === 'number') {
      out.set(t.name, { x: Math.round(node.x - node.width / 2), y: Math.round(node.y - node.height / 2) });
    }
  }
  return out;
}

/**
 * Geometric constants come from the active density (CSS tokens mirror in `density.ts`).
 * Source of truth: specs/12-design-system.md.
 */
function activeMetrics() {
  return densityMetrics(store.getState().settings.ui.density);
}

/**
 * Estimate node footprint based on column count and the active density.
 */
export function estimateSize(columnCount: number): NodeSize {
  const m = activeMetrics();
  return { width: m.tableWidth, height: m.headerHeight + columnCount * m.rowHeight + m.colsPad };
}

/** Y offset (from table top) for the vertical center of a column row at `index`. */
export function columnCenterY(index: number): number {
  const m = activeMetrics();
  const topPad = m.colsPad / 2;
  return m.headerHeight + topPad + index * m.rowHeight + m.rowHeight / 2;
}
