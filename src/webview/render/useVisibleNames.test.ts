import { describe, expect, it } from 'vitest';
import { cullingBox, routeReachBoxes, visibleEdgeIds, type EdgeBox } from './useVisibleNames';
import { routeRefs } from './edgeRouter';
import type { Ref } from '../../shared/types';
import type { Bbox } from './spatialIndex';

describe('edge culling', () => {
  // Tables A at x=0 and B at x=3000 (240 wide); the camera shows world x 1100..2300 only.
  const viewport = { x: -1100, y: 0, zoom: 1 };
  const query = cullingBox({ w: 1200, h: 800 }, true, viewport)!;
  const ab: EdgeBox = { id: 'a->b', bbox: { x: 0, y: 0, w: 3240, h: 100 } };

  it('keeps an edge that crosses the viewport while both endpoint tables are off-screen', () => {
    expect(visibleEdgeIds([ab], query).has('a->b')).toBe(true);
  });

  it('drops an edge whose whole box is off-screen', () => {
    const far: EdgeBox = { id: 'c->d', bbox: { x: 0, y: 5000, w: 3240, h: 100 } };
    expect(visibleEdgeIds([ab, far], query)).toEqual(new Set(['a->b']));
  });
});

describe('edge culling — routes drawn outside their tables (spec 05 §8)', () => {
  const W = 240;
  // 30 Cs between two stacked tables nest LOOP_STEP apart: the outermost trunk sits ~370 px past them.
  const cols = Array.from({ length: 30 }, (_, i) => `c${i}`);
  const refs: Ref[] = [
    ...cols.map((c) => ({ id: `a.${c}`, source: { table: 'a', columns: [c], relation: '*' as const }, target: { table: 'b', columns: ['id'], relation: '1' as const } })),
    { id: 'a.self', source: { table: 'a', columns: ['c0'], relation: '*' }, target: { table: 'a', columns: ['id'], relation: '1' } },
    { id: 'a.z', source: { table: 'a', columns: ['c1'], relation: '*' }, target: { table: 'z', columns: ['id'], relation: '1' } },
  ];
  const pos: Record<string, Bbox> = { a: { x: 0, y: 0, w: W, h: 1000 }, b: { x: 0, y: 1200, w: W, h: 200 }, z: { x: 2000, y: 0, w: W, h: 200 } };
  const rowY = (_t: string, c: string) => (c === 'id' ? 20 : 40 + 30 * Number(c.slice(1)));
  const routes = routeRefs(refs, (n) => pos[n], rowY);
  const boxes = routeReachBoxes(routes);

  it('covers every drawn point of each C and loop, and skips the Z', () => {
    expect(boxes.map((b) => b.id).sort()).toEqual([...cols.map((c) => `a.${c}`), 'a.self'].sort());
    for (const { id, bbox } of boxes) {
      const r = routes.find((x) => x.id === id)!;
      for (const s of r.segments) {
        for (const [x, y] of [[s.x1, s.y1], [s.x2, s.y2]] as const) {
          expect(x >= bbox.x && x <= bbox.x + bbox.w && y >= bbox.y && y <= bbox.y + bbox.h).toBe(true);
        }
      }
    }
  });

  it('keeps a nested C whose trunk is on screen though its tables are not', () => {
    const outer = Math.max(...boxes.map((b) => b.bbox.x + b.bbox.w));
    expect(outer).toBeGreaterThan(W + 256 + 50);
    // The camera starts past the tables' box grown by the culling margin.
    const query = cullingBox({ w: 400, h: 800 }, true, { x: -(W + 256 + 50), y: 0, zoom: 1 })!;
    const sceneBox: EdgeBox = { id: `a.${cols[29]}`, bbox: { x: 0, y: 0, w: W, h: 1400 } };
    expect(visibleEdgeIds([sceneBox], query).size).toBe(0);
    const seen = visibleEdgeIds(boxes, query);
    expect(seen.size).toBeGreaterThan(0);
    for (const id of seen) {
      const bbox = boxes.find((b) => b.id === id)!.bbox;
      expect(bbox.x + bbox.w).toBeGreaterThanOrEqual(query.x);
    }
  });
});
