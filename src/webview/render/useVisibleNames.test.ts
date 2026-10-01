import { describe, expect, it } from 'vitest';
import { cullingBox, visibleEdgeIds, type EdgeBox } from './useVisibleNames';

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
