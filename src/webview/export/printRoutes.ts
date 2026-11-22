import { roundedPathString, type EdgeRoute } from '../render/edgeRouter';
import { crossesTable, routeAroundTables } from '../render/portRoute';
import type { Bbox } from '../render/spatialIndex';

type Point = { x: number; y: number };
type Segment = [Point, Point];
const MARKER_LENGTH = 24;
const PORT_CLEARANCE = 10;

function segmentBox(a: Point, b: Point, padding: number): Bbox {
  return {
    x: Math.min(a.x, b.x) - padding,
    y: Math.min(a.y, b.y) - padding,
    w: Math.abs(a.x - b.x) + padding * 2,
    h: Math.abs(a.y - b.y) + padding * 2,
  };
}

/** Use the existing ports to infer the sides, even for manually placed endpoints. */
function outward(port: Point, stub: Point): Point {
  return { x: Math.sign(stub.x - port.x), y: Math.sign(stub.y - port.y) };
}

export function printRoute(
  route: EdgeRoute, sourceBox: Bbox, targetBox: Bbox,
  obstacles: (box: Bbox) => Bbox[], otherSegments: readonly Segment[],
): { d: string; points: Point[] } {
  const { source: a, target: b } = route;
  const original = [a, ...route.segments.map((s) => ({ x: s.x2, y: s.y2 }))];
  const from = outward(a, route.sourceStub);
  const to = outward(b, route.targetStub);
  const axis = from.x ? 'x' : 'y';
  const alongSide = axis === 'x' ? 'y' : 'x';
  const span = axis === 'x' ? 'h' : 'w';

  if (!route.loop && from[axis] === -to[axis] && (b[axis] - a[axis]) * from[axis] >= 2 * MARKER_LENGTH) {
    const low = Math.max(sourceBox[alongSide], targetBox[alongSide]) + PORT_CLEARANCE;
    const high = Math.min(sourceBox[alongSide] + sourceBox[span], targetBox[alongSide] + targetBox[span]) - PORT_CLEARANCE;
    if (low <= high) {
      const preferred = Math.round(Math.min(high, Math.max(low, (a[alongSide] + b[alongSide]) / 2)));
      for (const offset of [0, -PORT_CLEARANCE, PORT_CLEARANCE]) {
        const lane = preferred + offset;
        if (lane < low || lane > high) continue;
        const start = { ...a, [alongSide]: lane };
        const end = { ...b, [alongSide]: lane };
        const corridor = segmentBox(start, end, 2);
        if (obstacles(corridor).some((box) => crossesTable(start, end, box))) continue;
        const routeClearance = segmentBox(start, end, 8);
        if (otherSegments.some(([p, q]) => crossesTable(p, q, routeClearance))) continue;
        return { d: `M${start.x},${start.y} L${end.x},${end.y}`, points: [start, end] };
      }
    }
  }

  // Keep a clear existing route. Widening a table can obstruct previously clear runs.
  const crosses = (p: Point, q: Point) => obstacles(segmentBox(p, q, 1)).some((box) => crossesTable(p, q, box));
  if (!route.segments.some(({ x1, y1, x2, y2 }) => crosses({ x: x1, y: y1 }, { x: x2, y: y2 }))) {
    return { d: route.d, points: original };
  }
  const sourcePorts = clearPorts(a, from, sourceBox, crosses);
  const targetPorts = clearPorts(b, to, targetBox, crosses);
  for (const source of sourcePorts) {
    for (const target of targetPorts) {
      const candidates = obstacles(segmentBox(source.stub, target.stub, 96));
      const detour = routeAroundTables(source.stub, target.stub, candidates, source.direction, target.direction);
      if (!detour) continue;
      const points = [source.port, ...detour, target.port];
      if (!points.some((q, i) => i > 0 && crosses(points[i - 1]!, q))) {
        return { d: roundedPathString(points, 4), points };
      }
    }
  }
  return { d: route.d, points: original };
}

function clearPorts(
  original: Point, direction: Point, box: Bbox, blocked: (a: Point, b: Point) => boolean,
) {
  const result: Array<{ port: Point; stub: Point; direction: Point }> = [];
  const add = (port: Point, direction: Point) => {
    const stub = { x: port.x + direction.x * MARKER_LENGTH, y: port.y + direction.y * MARKER_LENGTH };
    if (!blocked(port, stub)) result.push({ port, stub, direction });
  };

  add(original, direction);
  const sides = [
    { x: -1, y: 0 }, { x: 1, y: 0 }, { x: 0, y: -1 }, { x: 0, y: 1 },
  ];
  for (const side of sides) {
    const horizontal = side.x !== 0;
    const offset = horizontal ? original.y - box.y : original.x - box.x;
    const length = horizontal ? box.h : box.w;
    const preferred = Math.max(PORT_CLEARANCE, Math.min(length - PORT_CLEARANCE, offset));
    for (const lane of new Set([preferred, length / 2, PORT_CLEARANCE, length - PORT_CLEARANCE])) {
      const port = horizontal
        ? { x: box.x + (side.x > 0 ? box.w : 0), y: box.y + lane }
        : { x: box.x + lane, y: box.y + (side.y > 0 ? box.h : 0) };
      if (port.x !== original.x || port.y !== original.y) add(port, side);
    }
  }
  return result;
}
