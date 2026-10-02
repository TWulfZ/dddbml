import type { WebviewToHost } from '../../shared/types';
import type { SceneRect } from './sceneGeometry';
import type { Point } from './viewport';

type AddTable = Extract<WebviewToHost, { type: 'schema:addTable' }>;

/**
 * "New table here" (spec 19 §Crear tabla): the click's world point, snapped like a dropped table,
 * and the expanded group whose box holds it — the innermost one when boxes overlap.
 */
export function newTableRequest(world: Point, containers: readonly SceneRect[], snap: (n: number) => number): AddTable {
  let group: SceneRect | null = null;
  for (const c of containers) {
    const inside = world.x >= c.x && world.x <= c.x + c.w && world.y >= c.y && world.y <= c.y + c.h;
    if (inside && (!group || c.w * c.h < group.w * group.h)) group = c;
  }
  return { type: 'schema:addTable', payload: { x: snap(world.x), y: snap(world.y), ...(group ? { group: group.name } : {}) } };
}
