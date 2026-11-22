import type { Bbox } from './spatialIndex';

type Point = { x: number; y: number };

/** Open interiors only: the port's outward stub is allowed to touch its table border. */
export function crossesTable(a: Point, b: Point, box: Bbox): boolean {
  return Math.min(a.x, b.x) < box.x + box.w && Math.max(a.x, b.x) > box.x && Math.min(a.y, b.y) < box.y + box.h && Math.max(a.y, b.y) > box.y;
}

/**
 * Small orthogonal visibility grid around the endpoint tables. Only manual ports need this fallback:
 * a freely chosen side may face away from its partner, so the usual single elbow can cross a table.
 * Coordinates include the stub ends and outside rails; direction states penalize unnecessary bends.
 */
export function routeAroundTables(start: Point, end: Point, boxes: Bbox[], sourceDir: Point, targetDir: Point): Point[] | null {
  const xs = [...new Set([start.x, end.x, ...boxes.flatMap((b) => [b.x - 24, b.x + b.w + 24])])].sort((a, b) => a - b);
  const ys = [...new Set([start.y, end.y, ...boxes.flatMap((b) => [b.y - 24, b.y + b.h + 24])])].sort((a, b) => a - b);
  const points = ys.flatMap((y) => xs.map((x) => ({ x, y })));
  const inside = (p: Point) => boxes.some((b) => p.x > b.x && p.x < b.x + b.w && p.y > b.y && p.y < b.y + b.h);
  const source = points.findIndex((p) => p.x === start.x && p.y === start.y);
  const target = points.findIndex((p) => p.x === end.x && p.y === end.y);
  const dist = new Map<number, number>([[source * 3, 0]]);
  const previous = new Map<number, number>();
  const pending = new Set([source * 3]);
  let final: number | undefined;
  while (pending.size) {
    let key = -1, best = Infinity;
    for (const k of pending) if (dist.get(k)! < best) { key = k; best = dist.get(k)!; }
    pending.delete(key);
    const index = Math.floor(key / 3), direction = key % 3;
    if (index === target) { final = key; break; }
    const p = points[index]!;
    const column = index % xs.length, row = Math.floor(index / xs.length);
    const neighbours = [column > 0 ? index - 1 : -1, column + 1 < xs.length ? index + 1 : -1, row > 0 ? index - xs.length : -1, row + 1 < ys.length ? index + xs.length : -1];
    for (const next of neighbours) {
      if (next < 0) continue;
      const q = points[next]!;
      if (inside(q) || boxes.some((b) => crossesTable(p, q, b))) continue;
      const dx = q.x - p.x, dy = q.y - p.y;
      if (index === source && dx * sourceDir.x + dy * sourceDir.y < 0) continue;
      if (next === target && dx * targetDir.x + dy * targetDir.y > 0) continue;
      const axis = dx === 0 ? 2 : 1;
      const nextKey = next * 3 + axis;
      const cost = best + Math.abs(dx) + Math.abs(dy) + (direction && direction !== axis ? 8 : 0);
      if (cost >= (dist.get(nextKey) ?? Infinity)) continue;
      dist.set(nextKey, cost);
      previous.set(nextKey, key);
      pending.add(nextKey);
    }
  }
  if (final === undefined) return null;
  const path: Point[] = [];
  for (let k: number | undefined = final; k !== undefined; k = previous.get(k)) path.push(points[Math.floor(k / 3)]!);
  path.reverse();
  return path.filter((p, i) => {
    const a = path[i - 1], b = path[i + 1];
    return !a || !b || !((a.x === p.x && p.x === b.x) || (a.y === p.y && p.y === b.y));
  });
}
