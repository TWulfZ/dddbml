import type { EdgeLayout, QualifiedName, Waypoint } from '../../shared/types';
import type { KeyedDepEdge } from './edgeKey';
import type { Bbox } from './spatialIndex';

/** Matches the ref stub length (edgeRouter MIN_STUB) so dep and FK edges leave tables identically. */
const DEP_STUB = 24;
/** Minimum horizontal handle length of the default bezier; keeps near-vertical deps from kinking. */
const MIN_HANDLE = 40;

type Point = { x: number; y: number };

export interface DepEndpointGeom {
  bbox: Bbox;
  /** Absolute port Y: a column row center for column-level deps, the header center otherwise. */
  portY: number;
}

export interface DepInsertHandle extends Point {
  /** Index the new waypoint takes in the waypoint array when this handle is dragged. */
  index: number;
}

export interface DepRoute {
  id: string;
  d: string;
  source: Point;
  target: Point;
  sourceStub: Point;
  targetStub: Point;
  waypoints: Waypoint[];
  /** One per curve span (stub end → waypoint → … → stub end), at the span's t=0.5 point. */
  inserts: DepInsertHandle[];
}

/** Resolves the absolute port Y of a dep endpoint (column row center, else header center). */
export type DepPortY = (table: QualifiedName, columns: readonly string[], bbox: Bbox) => number;

export function routeDeps(
  deps: readonly KeyedDepEdge[],
  bboxOf: (name: QualifiedName) => Bbox | undefined,
  portY: DepPortY,
  layoutOf: (id: string) => EdgeLayout | undefined,
): DepRoute[] {
  const out: DepRoute[] = [];
  for (const d of deps) {
    const a = bboxOf(d.upstream.table);
    const b = bboxOf(d.downstream.table);
    if (!a || !b) continue;
    out.push(routeDep(
      d.id,
      { bbox: a, portY: portY(d.upstream.table, d.upstream.columns, a) },
      { bbox: b, portY: portY(d.downstream.table, d.downstream.columns, b) },
      layoutOf(d.id)?.waypoints ?? [],
    ));
  }
  return out;
}

export function depColor(dep: KeyedDepEdge | undefined, layout: EdgeLayout | undefined): string | undefined {
  return layout?.color ?? dep?.color;
}

/**
 * Smooth (non-orthogonal) dep route: rigid horizontal stubs at both ends, and between them a
 * curve that passes THROUGH the user's waypoints (Catmull-Rom converted to cubic beziers).
 * Spec 18 §Render.
 */
export function routeDep(id: string, src: DepEndpointGeom, tgt: DepEndpointGeom, waypoints: readonly Waypoint[]): DepRoute {
  const forward = src.bbox.x + src.bbox.w / 2 <= tgt.bbox.x + tgt.bbox.w / 2;
  const dirA = forward ? 1 : -1;
  const dirB = -dirA;
  const a: Point = { x: forward ? src.bbox.x + src.bbox.w : src.bbox.x, y: src.portY };
  const b: Point = { x: forward ? tgt.bbox.x : tgt.bbox.x + tgt.bbox.w, y: tgt.portY };

  // Same clamp as refs: overlapping-in-x tables would otherwise get stubs that cross each other.
  const stubLen = Math.max(0, Math.min(DEP_STUB, Math.floor(Math.abs(b.x - a.x) / 2)));
  const aStub: Point = { x: a.x + dirA * stubLen, y: a.y };
  const bStub: Point = { x: b.x + dirB * stubLen, y: b.y };

  const pts: Point[] = [aStub, ...waypoints.map((w) => ({ x: w.x, y: w.y })), bStub];
  const spans = bezierSpans(pts, dirA, dirB);

  let d = `M ${fmt(a)} L ${fmt(aStub)}`;
  const inserts: DepInsertHandle[] = [];
  spans.forEach(([p0, c1, c2, p1], i) => {
    d += ` C ${fmt(c1)} ${fmt(c2)} ${fmt(p1)}`;
    inserts.push({ ...cubicAt(p0, c1, c2, p1, 0.5), index: i });
  });
  d += ` L ${fmt(b)}`;

  return {
    id,
    d,
    source: a,
    target: b,
    sourceStub: aStub,
    targetStub: bStub,
    waypoints: waypoints.map((w) => ({ x: w.x, y: w.y })),
    inserts,
  };
}

/**
 * Endpoint tangents are forced along the stub direction so the curve is C1-continuous with the
 * straight stubs (no visible kink where it leaves the table).
 */
function bezierSpans(pts: Point[], dirA: number, dirB: number): Array<[Point, Point, Point, Point]> {
  const n = pts.length;
  const first = pts[0]!;
  const last = pts[n - 1]!;

  if (n === 2) {
    const h = Math.max(MIN_HANDLE, Math.abs(last.x - first.x) / 2);
    return [[first, { x: first.x + dirA * h, y: first.y }, { x: last.x + dirB * h, y: last.y }, last]];
  }

  const tangents: Point[] = pts.map((p, i) => {
    if (i === 0) return { x: dirA * dist(p, pts[1]!), y: 0 };
    // Entering bStub the curve travels opposite to dirB (towards the table).
    if (i === n - 1) return { x: -dirB * dist(pts[n - 2]!, p), y: 0 };
    const prev = pts[i - 1]!;
    const next = pts[i + 1]!;
    return { x: (next.x - prev.x) / 2, y: (next.y - prev.y) / 2 };
  });

  const spans: Array<[Point, Point, Point, Point]> = [];
  for (let i = 0; i < n - 1; i++) {
    const p0 = pts[i]!;
    const p1 = pts[i + 1]!;
    const t0 = tangents[i]!;
    const t1 = tangents[i + 1]!;
    spans.push([p0, { x: p0.x + t0.x / 3, y: p0.y + t0.y / 3 }, { x: p1.x - t1.x / 3, y: p1.y - t1.y / 3 }, p1]);
  }
  return spans;
}

export function cubicAt(p0: Point, c1: Point, c2: Point, p1: Point, t: number): Point {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const c = 3 * u * t * t;
  const e = t * t * t;
  return { x: a * p0.x + b * c1.x + c * c2.x + e * p1.x, y: a * p0.y + b * c1.y + c * c2.y + e * p1.y };
}

/** Waypoints are persisted in the git-friendly sidecar, which only stores integer coords. */
export function insertDepWaypoint(waypoints: readonly Waypoint[], index: number, p: Point): Waypoint[] {
  const out = waypoints.map((w) => ({ x: w.x, y: w.y }));
  out.splice(Math.max(0, Math.min(index, out.length)), 0, { x: Math.round(p.x), y: Math.round(p.y) });
  return out;
}

function dist(p: Point, q: Point): number {
  return Math.hypot(q.x - p.x, q.y - p.y);
}

function fmt(p: Point): string {
  return `${round2(p.x)} ${round2(p.y)}`;
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
