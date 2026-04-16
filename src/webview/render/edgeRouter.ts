import type { QualifiedName, Ref } from '../../shared/types';
import type { Bbox } from './spatialIndex';

export type Side = 'left' | 'right' | 'top' | 'bottom';

export interface EdgeRoute {
  id: string;
  d: string;
  /** Middle segment of the Manhattan path, exposed so callers can render a draggable handle over it. */
  midSeg?: { x1: number; y1: number; x2: number; y2: number; axis: 'v' | 'h' };
  /** Resolved port coordinates (world space), useful for hit-testing / highlighting. */
  source: { x: number; y: number };
  target: { x: number; y: number };
}

/** Optional per-endpoint port override — used to align edges with the PK/FK column row. */
export type ColumnYResolver = (table: QualifiedName, column: string) => number | undefined;

/** User-adjusted offsets to the middle segment, keyed by ref id. */
export type EdgeOffsetResolver = (refId: string) => { dx?: number; dy?: number } | undefined;

interface PortAssignment {
  sourceSide: Side;
  targetSide: Side;
  sourceRatio: number; // 0..1 along the side
  targetRatio: number;
}

/**
 * Routes every ref orthogonally (Manhattan, 2-elbow max) and distributes
 * ports along each table side to minimize overlap when multiple edges share a side.
 *
 * Returns an ordered list matching refs[] order — callers can filter by visibility.
 */
export function routeRefs(
  refs: Ref[],
  bboxOf: (name: QualifiedName) => Bbox | undefined,
  columnYResolver?: ColumnYResolver,
  offsetResolver?: EdgeOffsetResolver,
): EdgeRoute[] {
  // 1. decide sides for each edge
  const decisions: Array<{ ref: Ref; srcBbox: Bbox; tgtBbox: Bbox; sourceSide: Side; targetSide: Side } | null> = [];
  for (const r of refs) {
    const srcBbox = bboxOf(r.source.table);
    const tgtBbox = bboxOf(r.target.table);
    if (!srcBbox || !tgtBbox) {
      decisions.push(null);
      continue;
    }
    const { sourceSide, targetSide } = chooseSides(srcBbox, tgtBbox);
    decisions.push({ ref: r, srcBbox, tgtBbox, sourceSide, targetSide });
  }

  // 2. group by (table, side) to compute port offsets
  type Group = Array<{ edgeIdx: number; role: 'source' | 'target'; otherCenter: number; orientation: 'h' | 'v' }>;
  const groups = new Map<string, Group>();

  for (let i = 0; i < decisions.length; i++) {
    const d = decisions[i];
    if (!d) continue;

    const srcKey = `${d.ref.source.table}|${d.sourceSide}`;
    const tgtKey = `${d.ref.target.table}|${d.targetSide}`;
    const srcOrientation = orientationOfSide(d.sourceSide);
    const tgtOrientation = orientationOfSide(d.targetSide);

    const tgtCenter = centerOf(d.tgtBbox);
    const srcCenter = centerOf(d.srcBbox);

    const srcOther = srcOrientation === 'v' ? tgtCenter.y : tgtCenter.x;
    const tgtOther = tgtOrientation === 'v' ? srcCenter.y : srcCenter.x;

    pushGroup(groups, srcKey, { edgeIdx: i, role: 'source', otherCenter: srcOther, orientation: srcOrientation });
    pushGroup(groups, tgtKey, { edgeIdx: i, role: 'target', otherCenter: tgtOther, orientation: tgtOrientation });
  }

  // 3. assign port ratios: sort group by otherCenter, evenly distribute
  const portAssign: PortAssignment[] = decisions.map(() => ({
    sourceSide: 'right',
    targetSide: 'left',
    sourceRatio: 0.5,
    targetRatio: 0.5,
  }));

  for (const [, entries] of groups) {
    entries.sort((a, b) => a.otherCenter - b.otherCenter);
    const count = entries.length;
    for (let i = 0; i < count; i++) {
      const entry = entries[i]!;
      const ratio = (i + 1) / (count + 1);
      const d = decisions[entry.edgeIdx]!;
      const assign = portAssign[entry.edgeIdx]!;
      assign.sourceSide = d.sourceSide;
      assign.targetSide = d.targetSide;
      if (entry.role === 'source') assign.sourceRatio = ratio;
      else assign.targetRatio = ratio;
    }
  }

  // 4. build paths
  const out: EdgeRoute[] = [];
  for (let i = 0; i < decisions.length; i++) {
    const d = decisions[i];
    if (!d) continue;
    const assign = portAssign[i]!;

    let sourceY: number | undefined;
    let targetY: number | undefined;
    if (columnYResolver) {
      if (assign.sourceSide === 'left' || assign.sourceSide === 'right') {
        const offset = d.ref.source.columns[0] ? columnYResolver(d.ref.source.table, d.ref.source.columns[0]) : undefined;
        if (offset !== undefined) sourceY = d.srcBbox.y + offset;
      }
      if (assign.targetSide === 'left' || assign.targetSide === 'right') {
        const offset = d.ref.target.columns[0] ? columnYResolver(d.ref.target.table, d.ref.target.columns[0]) : undefined;
        if (offset !== undefined) targetY = d.tgtBbox.y + offset;
      }
    }

    const a = portPoint(d.srcBbox, assign.sourceSide, assign.sourceRatio, sourceY);
    const b = portPoint(d.tgtBbox, assign.targetSide, assign.targetRatio, targetY);

    // All routes are H-V-H (forced horizontal sides). midX is draggable via offsetResolver.
    const userOffset = offsetResolver?.(d.ref.id);
    const midX = Math.round((a.x + b.x) / 2 + (userOffset?.dx ?? 0));
    const path = `M${a.x},${a.y} H${midX} V${b.y} H${b.x}`;
    const midSeg = { x1: midX, y1: a.y, x2: midX, y2: b.y, axis: 'v' as const };

    out.push({ id: d.ref.id, d: path, midSeg, source: a, target: b });
  }
  return out;
}

function pushGroup(
  groups: Map<string, Array<{ edgeIdx: number; role: 'source' | 'target'; otherCenter: number; orientation: 'h' | 'v' }>>,
  key: string,
  entry: { edgeIdx: number; role: 'source' | 'target'; otherCenter: number; orientation: 'h' | 'v' },
): void {
  let arr = groups.get(key);
  if (!arr) {
    arr = [];
    groups.set(key, arr);
  }
  arr.push(entry);
}

function orientationOfSide(side: Side): 'h' | 'v' {
  return side === 'left' || side === 'right' ? 'h' : 'v';
}

function chooseSides(src: Bbox, tgt: Bbox): { sourceSide: Side; targetSide: Side } {
  // dbdiagram-style: always exit/enter horizontally. Column-aligned ports only make sense horizontally,
  // so forcing left/right for every edge keeps routing predictable and aligned with column rows.
  const srcC = centerOf(src);
  const tgtC = centerOf(tgt);
  const dx = tgtC.x - srcC.x;
  return dx >= 0
    ? { sourceSide: 'right', targetSide: 'left' }
    : { sourceSide: 'left', targetSide: 'right' };
}

function centerOf(b: Bbox): { x: number; y: number } {
  return { x: b.x + b.w / 2, y: b.y + b.h / 2 };
}

function portPoint(b: Bbox, side: Side, ratio: number, overrideY?: number, overrideX?: number): { x: number; y: number } {
  const r = Math.max(0.05, Math.min(0.95, ratio));
  switch (side) {
    case 'left':   return { x: b.x,           y: overrideY ?? b.y + b.h * r };
    case 'right':  return { x: b.x + b.w,     y: overrideY ?? b.y + b.h * r };
    case 'top':    return { x: overrideX ?? b.x + b.w * r, y: b.y };
    case 'bottom': return { x: overrideX ?? b.x + b.w * r, y: b.y + b.h };
  }
}

// buildManhattanPath is now inlined in routeRefs because chooseSides forces H-V-H only.
