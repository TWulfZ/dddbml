import { describe, expect, it } from 'vitest';
import { routeRefs, type Side } from './edgeRouter';
import type { EdgeLayout, Ref } from '../../shared/types';
import type { Bbox } from './spatialIndex';

const sides: Side[] = ['left', 'right', 'top', 'bottom'];
const boxes: Record<string, Bbox> = { a: { x: 0, y: 0, w: 200, h: 100 }, b: { x: 500, y: 200, w: 200, h: 100 } };
const ref: Ref = { id: 'r', source: { table: 'a', columns: ['id'], relation: '*' }, target: { table: 'b', columns: ['id'], relation: '1' } };
const point = (box: Bbox, side: Side, ratio: number) => ({
  x: side === 'left' ? box.x : side === 'right' ? box.x + box.w : box.x + box.w * ratio,
  y: side === 'top' ? box.y : side === 'bottom' ? box.y + box.h : box.y + box.h * ratio,
});
const crosses = (s: { x1: number; y1: number; x2: number; y2: number }, b: Bbox) =>
  Math.min(s.x1, s.x2) < b.x + b.w && Math.max(s.x1, s.x2) > b.x && Math.min(s.y1, s.y2) < b.y + b.h && Math.max(s.y1, s.y2) > b.y;

describe('manually placed endpoints on all four table sides', () => {
  for (const sourceSide of sides) for (const targetSide of sides) {
    for (const self of [false, true]) it(`${sourceSide} → ${targetSide}${self ? ' self-reference' : ''}`, () => {
      const r = self ? { ...ref, target: { ...ref.target, table: 'a' } } : ref;
      const layout: EdgeLayout = { sourceSide, sourcePort: .3, targetSide, targetPort: .7 };
      const route = routeRefs([r], (n) => boxes[n], () => 30, () => layout)[0]!;
      expect(route.source).toEqual(point(boxes.a!, sourceSide, .3));
      expect(route.target).toEqual(point(boxes[r.target.table]!, targetSide, .7));
      for (const segment of route.segments) {
        expect(segment.x1 === segment.x2 || segment.y1 === segment.y2).toBe(true);
        for (const name of new Set([r.source.table, r.target.table])) expect(crosses(segment, boxes[name]!)).toBe(false);
      }
    });
  }
});
