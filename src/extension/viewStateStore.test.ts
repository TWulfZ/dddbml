import { describe, expect, it } from 'vitest';
import { applyViewState, extractViewState } from './viewStateStore';
import type { Layout } from '../shared/types';

describe('viewStateStore — extract / apply split', () => {
  const full: Layout = {
    version: 1,
    viewport: { x: 5, y: 6, zoom: 2 },
    tables: { a: { x: 1, y: 1 }, b: { x: 2, y: 2, hidden: true } },
    groups: { g1: { color: '#aaa' }, g2: { hidden: true }, g3: { collapsed: true, color: '#bbb' } },
    edges: { e: { waypoints: [{ x: 0, y: 0 }] } },
  };

  it('extracts ONLY view-state (viewport + hidden tables + hidden/collapsed groups)', () => {
    expect(extractViewState(full)).toEqual({
      viewport: { x: 5, y: 6, zoom: 2 },
      tables: { b: { hidden: true } }, // a is visible -> omitted
      groups: { g2: { hidden: true }, g3: { collapsed: true } }, // g1 is color-only -> omitted
    });
  });

  it('re-injects view-state onto a shared layout to rebuild the full layout', () => {
    // The git sidecar (shared form): no viewport, no hidden/collapsed, color-only groups.
    const shared: Layout = {
      version: 1,
      viewport: { x: 0, y: 0, zoom: 1 },
      tables: { a: { x: 1, y: 1 }, b: { x: 2, y: 2 } },
      groups: { g1: { color: '#aaa' }, g3: { color: '#bbb' } },
      edges: { e: { waypoints: [{ x: 0, y: 0 }] } },
    };
    const rebuilt = applyViewState(shared, extractViewState(full));
    expect(rebuilt.viewport).toEqual({ x: 5, y: 6, zoom: 2 });
    expect(rebuilt.tables).toEqual({ a: { x: 1, y: 1 }, b: { x: 2, y: 2, hidden: true } });
    expect(rebuilt.groups).toEqual({
      g1: { color: '#aaa' },
      g3: { color: '#bbb', collapsed: true },
      g2: { hidden: true }, // present only via view-state, still surfaced
    });
    expect(rebuilt.edges).toEqual(shared.edges);
  });
});
