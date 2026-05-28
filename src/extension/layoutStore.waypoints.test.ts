import { describe, expect, it } from 'vitest';
import { parseLayout, serializeLayout } from './layoutStore';
import type { Layout } from '../shared/types';

const baseLayout = (overrides?: Partial<Layout>): Layout => ({
  version: 1,
  viewport: { x: 0, y: 0, zoom: 1 },
  tables: {},
  groups: {},
  edges: {},
  ...overrides,
});

describe('layoutStore — waypoints serialization', () => {
  it('serializes a single edge with two waypoints in stable git-friendly form', () => {
    const layout = baseLayout({
      edges: {
        'ref-1': { waypoints: [{ x: 320, y: 180 }, { x: 320, y: 420 }] },
      },
    });
    const text = serializeLayout(layout);
    expect(text).toContain('"ref-1": {');
    expect(text).toContain('"waypoints": [');
    expect(text).toContain('{ "x": 320, "y": 180 }');
    expect(text).toContain('{ "x": 320, "y": 420 }');
    expect(text).toMatch(/\n$/); // trailing newline
  });

  it('sorts edge keys alphabetically', () => {
    const layout = baseLayout({
      edges: {
        'z-edge': { waypoints: [{ x: 1, y: 2 }] },
        'a-edge': { waypoints: [{ x: 3, y: 4 }] },
      },
    });
    const text = serializeLayout(layout);
    const aIdx = text.indexOf('"a-edge"');
    const zIdx = text.indexOf('"z-edge"');
    expect(aIdx).toBeGreaterThan(0);
    expect(aIdx).toBeLessThan(zIdx);
  });

  it('roundtrips: parse(serialize(x)) === x for waypoints', () => {
    const layout = baseLayout({
      edges: {
        'edge-a': { waypoints: [{ x: 100, y: 200 }, { x: 100, y: 400 }] },
      },
    });
    const text = serializeLayout(layout);
    const parsed = parseLayout(text);
    expect(parsed.edges).toEqual(layout.edges);
  });

  it('serialize is byte-stable across roundtrips (idempotent)', () => {
    const layout = baseLayout({
      edges: {
        'edge-a': { waypoints: [{ x: 100, y: 200 }] },
      },
    });
    const first = serializeLayout(layout);
    const second = serializeLayout(parseLayout(first));
    expect(second).toBe(first);
  });

  it('parses legacy dx/dy entries without dropping them', () => {
    const text = `{
  "version": 1,
  "viewport": { "x": 0, "y": 0, "zoom": 1 },
  "tables": {
  },
  "groups": {
  },
  "edges": {
    "legacy-edge": { "dx": 50, "dy": -10 }
  }
}
`;
    const parsed = parseLayout(text);
    expect(parsed.edges?.['legacy-edge']).toEqual({ dx: 50, dy: -10 });
  });

  it('serializes legacy dx/dy in compact one-line form when waypoints absent', () => {
    const layout = baseLayout({
      edges: {
        'legacy': { dx: 50, dy: -10 },
      },
    });
    const text = serializeLayout(layout);
    expect(text).toContain('"legacy": { "dx": 50, "dy": -10 }');
  });

  it('drops legacy dx/dy from output when waypoints are present', () => {
    const layout = baseLayout({
      edges: {
        'migrated': { waypoints: [{ x: 100, y: 100 }], dx: 999, dy: 999 },
      },
    });
    const text = serializeLayout(layout);
    expect(text).toContain('"waypoints"');
    // Once waypoints are present, the serializer should not emit dx/dy.
    expect(text).not.toContain('999');
  });

  it('omits empty edges object entries', () => {
    const layout = baseLayout({
      edges: {
        'empty-1': { waypoints: [] },
        'real': { waypoints: [{ x: 10, y: 20 }] },
      },
    });
    const text = serializeLayout(layout);
    expect(text).not.toContain('"empty-1"');
    expect(text).toContain('"real"');
  });

  it('rejects waypoint entries with non-numeric coords', () => {
    const text = `{
  "version": 1,
  "viewport": { "x": 0, "y": 0, "zoom": 1 },
  "tables": {
  },
  "groups": {
  },
  "edges": {
    "bad": { "waypoints": [{ "x": "oops", "y": 10 }, { "x": 5, "y": 6 }] }
  }
}
`;
    const parsed = parseLayout(text);
    expect(parsed.edges?.['bad']?.waypoints).toEqual([{ x: 5, y: 6 }]);
  });

  it('rounds non-integer waypoint coords on parse', () => {
    const text = `{
  "version": 1,
  "viewport": { "x": 0, "y": 0, "zoom": 1 },
  "tables": {
  },
  "groups": {
  },
  "edges": {
    "fractional": { "waypoints": [{ "x": 10.6, "y": 20.4 }] }
  }
}
`;
    const parsed = parseLayout(text);
    expect(parsed.edges?.['fractional']?.waypoints).toEqual([{ x: 11, y: 20 }]);
  });
});
