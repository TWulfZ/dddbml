import type { EdgeLayout, GroupLayout, QualifiedName, Ref, Schema, Table, TableGroup, UiDensity } from '../../shared/types';
import { estimateSize } from '../layout/autoLayout';
import type { RowGeometry } from '../layout/tableRows';
import { smallPositionsDelta } from '../state/positionsDelta';
import { edgeKeyedDeps, edgeKeyedRefs, type KeyedDepEdge } from './edgeKey';
import { deriveSceneGeometry, groupContainerRects, sceneBounds, type SceneGeometry, type SceneRect } from './sceneGeometry';
import { SpatialIndex, type Bbox } from './spatialIndex';
import type { EdgeBox } from './useVisibleNames';

const GROUP_PREFIX = '__group__:';
/** Index/endpoint id of a collapsed group's node. */
export const groupNodeId = (name: string): string => GROUP_PREFIX + name;
/** Expanded group boxes live in the spatial index too (culled like tables) under this prefix. */
export const CONTAINER_PREFIX = '__container__:';
export const containerNodeId = (name: string): string => CONTAINER_PREFIX + name;

/** World margin around the drawn scene for the world-size surfaces (edge SVG, grid). */
const WORLD_PADDING = 400;
const EMPTY_WORLD: Bbox = { x: 0, y: 0, w: 800, h: 600 };

type Point = { x: number; y: number };

export interface SceneInputs {
  schema: Schema;
  positions: ReadonlyMap<QualifiedName, Point>;
  groupState: Readonly<Record<string, GroupLayout | undefined>>;
  individuallyHidden: ReadonlySet<QualifiedName>;
  tablesByName: ReadonlyMap<QualifiedName, Table>;
  rows: RowGeometry;
  edgeLayouts: ReadonlyMap<string, EdgeLayout>;
  /** `estimateSize` reads the live density; it only takes part here as a rebuild trigger. */
  density: UiDensity;
  /** Hidden deps get no culling box; the edge layer does not draw them either (spec 18). */
  showDeps: boolean;
}

export interface DerivedScene extends SceneGeometry {
  /** Refs re-keyed by `edgeKey` with hidden/collapsed endpoints remapped (spec 03 `edges`). */
  effectiveRefs: Ref[];
  /** Lets the diff overlay tint a newly-added ref by its stable id (spec 16). */
  refKeyByStableId: Map<string, string>;
  /** Every dep edge after the same remap, shown or not; `showDeps` only gates boxes and drawing. */
  effectiveDeps: KeyedDepEdge[];
}

export interface Scene {
  derived: DerivedScene;
  /** Mutated in place by a drag; its `version` says when it changed. */
  spatialIndex: SpatialIndex;
  /** Edge culling boxes: endpoint node rects ∪ waypoints (spec 04 "Edge culling"). */
  edgeBoxes: EdgeBox[];
  /** Drawn scene ∪ edge boxes, padded: the extent of the world-size surfaces (spec 04). */
  worldBbox: Bbox;
}

/** What an edge box needs from a ref or a dep edge. */
interface BoxedEdge {
  id: string;
  from: QualifiedName;
  to: QualifiedName;
}

interface RectChange {
  before: Bbox;
  after: Bbox;
}

const sameRect = (a: Bbox, b: Bbox): boolean => a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
const toBbox = (r: Bbox): Bbox => ({ x: r.x, y: r.y, w: r.w, h: r.h });

function union(a: Bbox, b: Bbox): Bbox {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

/** True when `before` held a side of `bounds` and `after` no longer reaches it: only a rescan knows the new side. */
function mayShrink(bounds: Bbox, c: RectChange): boolean {
  const { before: b, after: a } = c;
  return (b.x <= bounds.x && a.x > bounds.x)
    || (b.y <= bounds.y && a.y > bounds.y)
    || (b.x + b.w >= bounds.x + bounds.w && a.x + a.w < bounds.x + bounds.w)
    || (b.y + b.h >= bounds.y + bounds.h && a.y + a.h < bounds.y + bounds.h);
}

function padWorld(content: Bbox | null): Bbox {
  if (!content) return EMPTY_WORLD;
  const { x, y, w, h } = content;
  return {
    x: Math.round(x - WORLD_PADDING),
    y: Math.round(y - WORLD_PADDING),
    w: Math.round(w + WORLD_PADDING * 2),
    h: Math.round(h + WORLD_PADDING * 2),
  };
}

function sameExceptPositionsAndEdges(a: SceneInputs, b: SceneInputs): boolean {
  return a.schema === b.schema
    && a.groupState === b.groupState
    && a.individuallyHidden === b.individuallyHidden
    && a.tablesByName === b.tablesByName
    && a.rows === b.rows
    && a.density === b.density
    && a.showDeps === b.showDeps;
}

/**
 * Everything `App` derives from positions for culling and the world surfaces: scene geometry,
 * spatial index, edge boxes and world bbox. A full rebuild is O(tables + refs); a positions-only
 * change recorded by the store (a drag frame) is applied incrementally — `SpatialIndex.move` for the
 * moved tables and their group boxes, re-boxing only their edges, and rescanning the bounds only
 * when a moved rect held one of its sides (spec 04, "Commit del drag por frame").
 */
export class SceneCache {
  private inputs: SceneInputs | null = null;
  private scene: Scene | null = null;
  private readonly groupOf = new Map<QualifiedName, TableGroup>();
  private readonly containerSlot = new Map<string, number>();
  private readonly groupRects = new Map<QualifiedName, Bbox>();
  private readonly boxSlotsByTable = new Map<QualifiedName, number[]>();
  private boxEdges: BoxedEdge[] = [];
  private content: Bbox | null = null;

  public update(next: SceneInputs): Scene {
    const prev = this.inputs;
    const scene = this.scene;
    this.inputs = next;
    if (prev && scene && sameExceptPositionsAndEdges(prev, next)) {
      if (prev.edgeLayouts === next.edgeLayouts) {
        if (prev.positions === next.positions) return scene;
        const moved = smallPositionsDelta(prev.positions, next.positions);
        const moveScene = moved ? this.applyMoves(scene, prev, next, moved) : null;
        if (moveScene) return (this.scene = moveScene);
      } else if (prev.positions === next.positions) {
        return (this.scene = this.withEdges(scene.derived, scene.spatialIndex, next));
      }
    }
    return (this.scene = this.build(next));
  }

  private build(next: SceneInputs): Scene {
    const { schema, positions, tablesByName, rows } = next;
    const geometry = deriveSceneGeometry(schema, positions, next.groupState, next.individuallyHidden, tablesByName, rows.count);
    const { hiddenTables, collapsedTables, collapsedNodes, containers } = geometry;
    const mapEndpoint = (table: QualifiedName): QualifiedName | null => {
      if (hiddenTables.has(table)) return null;
      if (collapsedTables.has(table)) {
        const groupName = tablesByName.get(table)?.groupName;
        return groupName ? groupNodeId(groupName) : null;
      }
      return table;
    };
    const { refs: effectiveRefs, keyByStableId: refKeyByStableId } = edgeKeyedRefs(schema.refs, mapEndpoint);
    const effectiveDeps = edgeKeyedDeps(schema.deps ?? [], mapEndpoint);
    const derived: DerivedScene = { ...geometry, effectiveRefs, refKeyByStableId, effectiveDeps };

    const index = new SpatialIndex();
    for (const t of schema.tables) {
      if (hiddenTables.has(t.name) || collapsedTables.has(t.name)) continue;
      const pos = positions.get(t.name);
      if (!pos) continue;
      index.insert(t.name, this.tableRect(t.name, pos, next));
    }
    for (const g of collapsedNodes) index.insert(groupNodeId(g.name), toBbox(g));
    for (const c of containers) index.insert(containerNodeId(c.name), toBbox(c));

    this.groupOf.clear();
    for (const g of schema.groups) for (const t of g.tables) if (!this.groupOf.has(t)) this.groupOf.set(t, g);
    this.containerSlot.clear();
    containers.forEach((c, i) => this.containerSlot.set(c.name, i));
    return this.withEdges(derived, index, next);
  }

  /** Rebuilds edge boxes and bounds over unchanged geometry (also the waypoint-edit path). */
  private withEdges(derived: DerivedScene, spatialIndex: SpatialIndex, next: SceneInputs): Scene {
    this.groupRects.clear();
    for (const g of derived.collapsedNodes) this.groupRects.set(groupNodeId(g.name), toBbox(g));
    this.boxSlotsByTable.clear();
    this.boxEdges = [];
    const edgeBoxes: EdgeBox[] = [];
    const add = (e: BoxedEdge): void => {
      const box = this.edgeBoxOf(e, next);
      if (!box) return;
      const slot = edgeBoxes.length;
      edgeBoxes.push(box);
      this.boxEdges.push(e);
      this.indexBoxSlot(e.from, slot);
      if (e.to !== e.from) this.indexBoxSlot(e.to, slot);
    };
    for (const r of derived.effectiveRefs) add({ id: r.id, from: r.source.table, to: r.target.table });
    if (next.showDeps) for (const d of derived.effectiveDeps) add({ id: d.id, from: d.upstream.table, to: d.downstream.table });
    this.content = this.scanContent(derived, edgeBoxes, next);
    return { derived, spatialIndex, edgeBoxes, worldBbox: padWorld(this.content) };
  }

  /** Null when the delta is not a plain move of rendered tables; the caller then rebuilds. */
  private applyMoves(scene: Scene, prev: SceneInputs, next: SceneInputs, moved: ReadonlySet<QualifiedName>): Scene | null {
    const d = scene.derived;
    for (const m of moved) {
      if (!next.tablesByName.has(m) || d.hiddenTables.has(m) || d.collapsedTables.has(m)) return null;
      if (!prev.positions.has(m) || !next.positions.has(m)) return null;
    }
    const fullRows = (t: QualifiedName) => next.tablesByName.get(t)?.columns.length ?? 0;
    const changes: RectChange[] = [];

    // Pure phase first: nothing is mutated until every rect is known to be computable.
    const touchedGroups = new Set<TableGroup>();
    for (const m of moved) {
      const g = this.groupOf.get(m);
      if (!g) continue;
      if (!this.containerSlot.has(g.name)) return null;
      touchedGroups.add(g);
    }
    let containers = d.containers;
    let exportContainers = d.exportContainers;
    const containerMoves: SceneRect[] = [];
    for (const g of touchedGroups) {
      const slot = this.containerSlot.get(g.name)!;
      const old = d.containers[slot]!;
      const oldExport = d.exportContainers[slot]!;
      const rects = groupContainerRects(g, old.color, next.positions, d.hiddenTables, next.rows.count, fullRows);
      if (!rects) return null;
      if (sameRect(old, rects.container) && sameRect(oldExport, rects.exportContainer)) continue;
      if (containers === d.containers) {
        containers = d.containers.slice();
        exportContainers = d.exportContainers.slice();
      }
      containers[slot] = rects.container;
      exportContainers[slot] = rects.exportContainer;
      containerMoves.push(rects.container);
      changes.push({ before: old, after: rects.container });
    }

    let edgeBoxes = scene.edgeBoxes;
    const slots = new Set<number>();
    for (const m of moved) for (const s of this.boxSlotsByTable.get(m) ?? []) slots.add(s);
    if (slots.size > 0) {
      edgeBoxes = edgeBoxes.slice();
      for (const s of slots) {
        const box = this.edgeBoxOf(this.boxEdges[s]!, next);
        if (!box) return null;
        changes.push({ before: edgeBoxes[s]!.bbox, after: box.bbox });
        edgeBoxes[s] = box;
      }
    }

    const index = scene.spatialIndex;
    for (const m of moved) {
      const after = this.tableRect(m, next.positions.get(m)!, next);
      changes.push({ before: this.tableRect(m, prev.positions.get(m)!, next), after });
      index.move(m, after);
    }
    for (const c of containerMoves) index.move(containerNodeId(c.name), toBbox(c));

    const derived: DerivedScene = containers === d.containers ? d : { ...d, containers, exportContainers };
    const content = this.content;
    if (!content || changes.some((c) => mayShrink(content, c))) {
      this.content = this.scanContent(derived, edgeBoxes, next);
    } else {
      let grown = content;
      for (const c of changes) grown = union(grown, c.after);
      this.content = grown;
    }
    const padded = padWorld(this.content);
    const worldBbox = sameRect(padded, scene.worldBbox) ? scene.worldBbox : padded;
    return { derived, spatialIndex: index, edgeBoxes, worldBbox };
  }

  private tableRect(name: QualifiedName, pos: Point, inputs: SceneInputs): Bbox {
    const size = estimateSize(inputs.rows.count(name));
    return { x: pos.x, y: pos.y, w: size.width, h: size.height };
  }

  /** Endpoint node rects ∪ waypoints. Full column lists: a superset of the PK/FK-only node is fine for culling. */
  private edgeBoxOf(r: BoxedEdge, inputs: SceneInputs): EdgeBox | null {
    const a = this.endpointRect(r.from, inputs);
    const b = this.endpointRect(r.to, inputs);
    if (!a || !b) return null;
    let minX = Math.min(a.x, b.x), minY = Math.min(a.y, b.y);
    let maxX = Math.max(a.x + a.w, b.x + b.w), maxY = Math.max(a.y + a.h, b.y + b.h);
    for (const wp of inputs.edgeLayouts.get(r.id)?.waypoints ?? []) {
      if (wp.x < minX) minX = wp.x;
      if (wp.y < minY) minY = wp.y;
      if (wp.x > maxX) maxX = wp.x;
      if (wp.y > maxY) maxY = wp.y;
    }
    return { id: r.id, bbox: { x: minX, y: minY, w: maxX - minX, h: maxY - minY } };
  }

  private endpointRect(name: QualifiedName, inputs: SceneInputs): Bbox | null {
    const g = this.groupRects.get(name);
    if (g) return g;
    const p = inputs.positions.get(name);
    if (!p) return null;
    const size = estimateSize(inputs.tablesByName.get(name)?.columns.length ?? 0);
    return { x: p.x, y: p.y, w: size.width, h: size.height };
  }

  private indexBoxSlot(table: QualifiedName, slot: number): void {
    const list = this.boxSlotsByTable.get(table);
    if (list) list.push(slot);
    else this.boxSlotsByTable.set(table, [slot]);
  }

  /** Waypoint runs can be slid far past the outermost table; without the edge boxes the SVG clips them. */
  private scanContent(derived: DerivedScene, edgeBoxes: readonly EdgeBox[], inputs: SceneInputs): Bbox | null {
    let content = sceneBounds(inputs.schema, inputs.positions, derived, inputs.rows.count);
    if (!content) return null;
    for (const { bbox } of edgeBoxes) content = union(content, bbox);
    return content;
  }
}
