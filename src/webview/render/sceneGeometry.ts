import { estimateSize } from '../layout/autoLayout';
import { bcColorFor } from '../groups/bcPalette';
import type { GroupLayout, QualifiedName, Schema, Table } from '../../shared/types';
import type { Bbox } from './spatialIndex';

export const GROUP_NODE_W = 220;
export const GROUP_NODE_H = 80;
export const GROUP_CONTAINER_PADDING = 24;
export const GROUP_CONTAINER_HEADER = 20;

export interface SceneRect { name: string; x: number; y: number; w: number; h: number; color: string }
export interface CollapsedNodeRect extends SceneRect { count: number }

export interface SceneGeometry {
  /** Individually hidden tables plus every member of a hidden group. */
  hiddenTables: Set<QualifiedName>;
  /** Members of collapsed groups (drawn as one group node). */
  collapsedTables: Set<QualifiedName>;
  collapsedNodes: CollapsedNodeRect[];
  containers: SceneRect[];
}

/**
 * What is actually drawn: hidden/collapsed membership plus group node and container rects. Shared by
 * App (render + culling) and fitToContent so the camera frames exactly the rendered scene.
 */
export function deriveSceneGeometry(
  schema: Schema,
  positions: ReadonlyMap<QualifiedName, { x: number; y: number }>,
  groupState: Readonly<Record<string, GroupLayout | undefined>>,
  individuallyHidden: ReadonlySet<QualifiedName>,
  tablesByName: ReadonlyMap<QualifiedName, Table>,
): SceneGeometry {
  const hiddenTables = new Set<QualifiedName>(individuallyHidden);
  const collapsedTables = new Set<QualifiedName>();
  const collapsedNodes: CollapsedNodeRect[] = [];
  const containers: SceneRect[] = [];

  for (const g of schema.groups) {
    const st = groupState[g.name];
    if (st?.hidden) {
      for (const t of g.tables) hiddenTables.add(t);
      continue;
    }
    if (!st?.collapsed) {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      let n = 0;
      for (const t of g.tables) {
        if (hiddenTables.has(t)) continue;
        const pos = positions.get(t);
        if (!pos) continue;
        const size = estimateSize(tablesByName.get(t)?.columns.length ?? 0);
        if (pos.x < minX) minX = pos.x;
        if (pos.y < minY) minY = pos.y;
        if (pos.x + size.width > maxX) maxX = pos.x + size.width;
        if (pos.y + size.height > maxY) maxY = pos.y + size.height;
        n++;
      }
      if (n > 0) {
        containers.push({
          name: g.name,
          x: Math.round(minX - GROUP_CONTAINER_PADDING),
          y: Math.round(minY - GROUP_CONTAINER_PADDING - GROUP_CONTAINER_HEADER),
          w: Math.round(maxX - minX + GROUP_CONTAINER_PADDING * 2),
          h: Math.round(maxY - minY + GROUP_CONTAINER_PADDING * 2 + GROUP_CONTAINER_HEADER),
          color: st?.color ?? bcColorFor(g.name),
        });
      }
      continue;
    }
    let sumX = 0, sumY = 0, n = 0;
    for (const t of g.tables) {
      const pos = positions.get(t);
      if (!pos) continue;
      const size = estimateSize(tablesByName.get(t)?.columns.length ?? 0);
      sumX += pos.x + size.width / 2;
      sumY += pos.y + size.height / 2;
      n++;
      collapsedTables.add(t);
    }
    if (n > 0) {
      collapsedNodes.push({
        name: g.name,
        x: Math.round(sumX / n - GROUP_NODE_W / 2),
        y: Math.round(sumY / n - GROUP_NODE_H / 2),
        w: GROUP_NODE_W,
        h: GROUP_NODE_H,
        color: st.color ?? bcColorFor(g.name),
        count: g.tables.length,
      });
    }
  }

  return { hiddenTables, collapsedTables, collapsedNodes, containers };
}

/** Union of every rendered table, collapsed group node and group container; null when nothing is drawn. */
export function sceneBounds(
  schema: Schema,
  positions: ReadonlyMap<QualifiedName, { x: number; y: number }>,
  scene: SceneGeometry,
): Bbox | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const add = (x: number, y: number, w: number, h: number) => {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x + w > maxX) maxX = x + w;
    if (y + h > maxY) maxY = y + h;
  };
  for (const t of schema.tables) {
    if (scene.hiddenTables.has(t.name) || scene.collapsedTables.has(t.name)) continue;
    const pos = positions.get(t.name);
    if (!pos) continue;
    const size = estimateSize(t.columns.length);
    add(pos.x, pos.y, size.width, size.height);
  }
  for (const g of scene.collapsedNodes) add(g.x, g.y, g.w, g.h);
  for (const c of scene.containers) add(c.x, c.y, c.w, c.h);
  if (!Number.isFinite(minX)) return null;
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}
