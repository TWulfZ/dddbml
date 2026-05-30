import { describe, expect, it } from 'vitest';
import { deepEqual, mergeThreeWay } from './mergeThreeWay';
import type { Layout, TableLayout } from '../shared/types';

const L = (
  tables: Record<string, TableLayout>,
  groups: Layout['groups'] = {},
  edges: Layout['edges'] = {},
): Layout => ({ version: 1, viewport: { x: 0, y: 0, zoom: 1 }, tables, groups, edges });

describe('mergeThreeWay — per-key 3-way merge of shared layout', () => {
  it('only-ours-changed -> keeps ours, no conflict', () => {
    const base = L({ a: { x: 0, y: 0 } });
    const ours = L({ a: { x: 9, y: 9 } });
    const theirs = L({ a: { x: 0, y: 0 } });
    const { merged, conflicts } = mergeThreeWay(base, ours, theirs);
    expect(merged.tables.a).toEqual({ x: 9, y: 9 });
    expect(conflicts).toHaveLength(0);
  });

  it('only-theirs-changed -> takes theirs, no conflict', () => {
    const base = L({ a: { x: 0, y: 0 } });
    const ours = L({ a: { x: 0, y: 0 } });
    const theirs = L({ a: { x: 7, y: 7 } });
    const { merged, conflicts } = mergeThreeWay(base, ours, theirs);
    expect(merged.tables.a).toEqual({ x: 7, y: 7 });
    expect(conflicts).toHaveLength(0);
  });

  it('both-changed-equally -> that value, no conflict', () => {
    const base = L({ a: { x: 0, y: 0 } });
    const ours = L({ a: { x: 5, y: 5 } });
    const theirs = L({ a: { x: 5, y: 5 } });
    const { merged, conflicts } = mergeThreeWay(base, ours, theirs);
    expect(merged.tables.a).toEqual({ x: 5, y: 5 });
    expect(conflicts).toHaveLength(0);
  });

  it('both-changed-differently -> CONFLICT, provisional ours', () => {
    const base = L({ a: { x: 0, y: 0 } });
    const ours = L({ a: { x: 1, y: 1 } });
    const theirs = L({ a: { x: 2, y: 2 } });
    const { merged, conflicts } = mergeThreeWay(base, ours, theirs);
    expect(merged.tables.a).toEqual({ x: 1, y: 1 }); // provisional = ours
    expect(conflicts).toEqual([
      { section: 'tables', key: 'a', base: { x: 0, y: 0 }, ours: { x: 1, y: 1 }, theirs: { x: 2, y: 2 } },
    ]);
  });

  it('ours-added / theirs-added (disjoint) -> both kept, no conflict', () => {
    const base = L({});
    const ours = L({ a: { x: 1, y: 1 } });
    const theirs = L({ b: { x: 2, y: 2 } });
    const { merged, conflicts } = mergeThreeWay(base, ours, theirs);
    expect(merged.tables).toEqual({ a: { x: 1, y: 1 }, b: { x: 2, y: 2 } });
    expect(conflicts).toHaveLength(0);
  });

  it('add/add with different values -> CONFLICT', () => {
    const base = L({});
    const ours = L({ a: { x: 1, y: 1 } });
    const theirs = L({ a: { x: 2, y: 2 } });
    const { conflicts } = mergeThreeWay(base, ours, theirs);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({ section: 'tables', key: 'a', base: undefined });
  });

  it('edit-vs-delete -> CONFLICT', () => {
    const base = L({ a: { x: 0, y: 0 } });
    const ours = L({}); // deleted locally
    const theirs = L({ a: { x: 5, y: 5 } }); // edited remotely
    const { merged, conflicts } = mergeThreeWay(base, ours, theirs);
    expect(conflicts).toHaveLength(1);
    expect(merged.tables.a).toBeUndefined(); // provisional ours = deleted
  });

  it('both-deleted -> absent, no conflict', () => {
    const base = L({ a: { x: 0, y: 0 } });
    const { merged, conflicts } = mergeThreeWay(base, L({}), L({}));
    expect(merged.tables.a).toBeUndefined();
    expect(conflicts).toHaveLength(0);
  });

  it('disjoint regions auto-merge; only the overlap conflicts (the institution case)', () => {
    const base = L({ a: { x: 0, y: 0 }, b: { x: 0, y: 0 }, c: { x: 0, y: 0 }, inst: { x: 100, y: 100 } });
    const ours = L({ a: { x: 10, y: 10 }, b: { x: 0, y: 0 }, c: { x: 0, y: 0 }, inst: { x: 50, y: -10 } });
    const theirs = L({ a: { x: 0, y: 0 }, b: { x: 20, y: 20 }, c: { x: 0, y: 0 }, inst: { x: 30, y: -90 } });
    const { merged, conflicts } = mergeThreeWay(base, ours, theirs);
    expect(merged.tables.a).toEqual({ x: 10, y: 10 }); // ours moved
    expect(merged.tables.b).toEqual({ x: 20, y: 20 }); // theirs moved
    expect(merged.tables.c).toEqual({ x: 0, y: 0 }); // neither moved
    expect(conflicts.map((c) => c.key)).toEqual(['inst']); // only the overlap
  });

  it('merges groups (color) and edges (waypoints) the same way', () => {
    const base = L({}, { g: {} }, { e: { waypoints: [{ x: 0, y: 0 }] } });
    const ours = L({}, { g: { color: '#aaa' } }, { e: { waypoints: [{ x: 1, y: 1 }] } });
    const theirs = L({}, { g: {} }, { e: { waypoints: [{ x: 0, y: 0 }] } });
    const { merged, conflicts } = mergeThreeWay(base, ours, theirs);
    expect(merged.groups.g).toEqual({ color: '#aaa' }); // only ours recolored
    expect(merged.edges?.e).toEqual({ waypoints: [{ x: 1, y: 1 }] }); // only ours re-routed
    expect(conflicts).toHaveLength(0);
  });

  it('result viewport is carried from ours (never merged)', () => {
    const ours: Layout = { version: 1, viewport: { x: 5, y: 6, zoom: 2 }, tables: {}, groups: {}, edges: {} };
    const { merged } = mergeThreeWay(L({}), ours, L({}));
    expect(merged.viewport).toEqual({ x: 5, y: 6, zoom: 2 });
  });
});

describe('deepEqual', () => {
  it('compares nested objects and arrays structurally', () => {
    expect(deepEqual({ x: 1, y: 2 }, { y: 2, x: 1 })).toBe(true);
    expect(deepEqual([{ x: 1 }], [{ x: 1 }])).toBe(true);
    expect(deepEqual([{ x: 1 }], [{ x: 2 }])).toBe(false);
    expect(deepEqual({ a: undefined }, {})).toBe(true);
    expect(deepEqual(undefined, undefined)).toBe(true);
    expect(deepEqual(undefined, { x: 1 })).toBe(false);
  });
});
