import type { QualifiedName } from '../../shared/types';
import { store, type AppState } from '../state/store';
import { estimateSize } from '../layout/autoLayout';
import { fitToBbox, liveScene } from './viewport';
import type { Bbox } from './spatialIndex';

/** A single table framed at 100%: fitting its small box alone would zoom far past reading size. */
const FOCUS_MAX_ZOOM = 1;

export type FocusTarget =
  | { kind: 'table'; bbox: Bbox }
  | { kind: 'group'; bbox: Bbox; notice?: string }
  | { kind: 'none'; notice: string };

/**
 * Where code → diagram navigation lands (spec 19 §Navegación): the table itself, the node of its
 * collapsed group, or — for a hidden table — its group's box with a notice, else just the notice.
 */
export function resolveFocusTarget(s: AppState, name: QualifiedName): FocusTarget {
  if (!s.schema.tables.some((t) => t.name === name)) {
    return { kind: 'none', notice: `${name} is not in the diagram; save the .dbml to update it.` };
  }
  const { scene, rows } = liveScene(s);
  const group = s.schema.groups.find((g) => g.tables.includes(name));
  if (scene.collapsedTables.has(name)) {
    const node = scene.collapsedNodes.find((n) => n.name === group?.name);
    if (node) return { kind: 'group', bbox: node };
  }
  if (scene.hiddenTables.has(name)) {
    const notice = `${name} is hidden.`;
    const box = group ? scene.containers.find((c) => c.name === group.name) : undefined;
    return box ? { kind: 'group', bbox: box, notice } : { kind: 'none', notice };
  }
  const pos = s.positions.get(name);
  if (!pos) return { kind: 'none', notice: `${name} has no position yet.` };
  const size = estimateSize(rows.count(name));
  return { kind: 'table', bbox: { x: pos.x, y: pos.y, w: size.width, h: size.height } };
}

/** `diagram:focusTable`: frame the target and select the table when it is drawn on its own. */
export function focusTable(name: QualifiedName): void {
  const s = store.getState();
  const target = resolveFocusTarget(s, name);
  if (target.kind !== 'table' && target.notice) s.showNotice(target.notice);
  if (target.kind === 'none') return;
  fitToBbox(target.bbox, { maxZoom: FOCUS_MAX_ZOOM });
  if (target.kind === 'table') {
    s.setSelection([name]);
    s.setSelectedEdge(null);
  }
}
