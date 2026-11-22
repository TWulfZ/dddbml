import { describe, expect, it } from 'vitest';
import { REF_MARKERS, refColor, refDescription, refMarker, refMarkersSvg } from './refMarkers';

describe('relationship markers shared by canvas and export', () => {
  for (const relation of ['1', '*'] as const) for (const optional of [false, true]) for (const start of [false, true]) {
    it(`${start ? 'source' : 'target'} ${optional ? 'optional' : 'required'} ${relation} has a matching marker`, () => {
      const url = refMarker({ relation, optional }, start);
      const id = url.slice(5, -1);
      const marker = REF_MARKERS.find((m) => m.id === id)!;
      expect(marker).toBeDefined();
      expect(marker.optional).toBe(optional);
      expect(marker.start).toBe(start);
      expect(refMarkersSvg()).toContain(`id="${id}"`);
    });
  }
  it('preserves composite columns, cardinality, name, and actions in descriptions', () => {
    const ref = { id: 'test', name: 'foreign_key', color: '#ff0000',
      source: { table: 'public.child', columns: ['a', 'b'], relation: '*' as const, optional: true },
      target: { table: 'public.parent', columns: ['x', 'y'], relation: '1' as const },
      onDelete: 'set null', onUpdate: 'cascade',
    };
    expect(refDescription(ref)).toBe('foreign_key\npublic.child.(a, b) [0..*] — public.parent.(x, y) [1]\ndelete: set null\nupdate: cascade');
    expect(refColor(ref, undefined)).toBe('#ff0000');
    expect(refColor(ref, { color: '#00ff00' })).toBe('#00ff00');
  });
});

describe('standard crow’s-foot geometry (Lucid reference)', () => {
  it('spreads the many branches toward the table and places the minimum bar behind them', () => {
    const marker = REF_MARKERS.find((m) => m.id === 'ddd-mk-many')!;
    expect(marker.d).toBe('M20,2 L10,6 L20,10 M6,2 L6,10');
  });
  it('draws exactly-one with two bars', () => {
    expect(REF_MARKERS.find((m) => m.id === 'ddd-mk-one')!.d).toBe('M18,2 L18,10 M12,2 L12,10');
  });
});
