import { describe, expect, it } from 'vitest';
import { applyDecisions, conflictId, toSerializableConflicts } from './mergeResolver';
import type { MergeConflict } from './mergeThreeWay';
import type { Layout } from '../shared/types';

const layout = (tables: Record<string, unknown>, groups: Record<string, unknown> = {}): Layout => ({
  version: 1,
  viewport: { x: 0, y: 0, zoom: 1 },
  tables: tables as Layout['tables'],
  groups: groups as Layout['groups'],
  edges: {},
});

describe('toSerializableConflicts', () => {
  it('builds a stable id and maps undefined sides to null (postMessage drops undefined)', () => {
    const conflicts: MergeConflict[] = [
      { section: 'tables', key: 'public.a', base: { x: 0, y: 0 }, ours: { x: 10, y: 0 }, theirs: { x: 20, y: 0 } },
      { section: 'tables', key: 'public.b', base: { x: 0, y: 0 }, ours: { x: 5, y: 5 }, theirs: undefined },
    ];
    const ser = toSerializableConflicts(conflicts);
    expect(ser[0]).toEqual({ id: 'tables::public.a', section: 'tables', key: 'public.a', ours: { x: 10, y: 0 }, theirs: { x: 20, y: 0 } });
    expect(ser[1]!.id).toBe('tables::public.b');
    expect(ser[1]!.theirs).toBeNull();
    expect(conflictId('groups', 'ventas')).toBe('groups::ventas');
  });
});

describe('applyDecisions', () => {
  it('applies the chosen side per conflict; a chosen-but-absent side deletes the key', () => {
    const merged = layout({ 'public.a': { x: 10, y: 0 }, 'public.b': { x: 5, y: 5 } });
    const conflicts: MergeConflict[] = [
      { section: 'tables', key: 'public.a', ours: { x: 10, y: 0 }, theirs: { x: 20, y: 0 } },
      { section: 'tables', key: 'public.b', ours: { x: 5, y: 5 }, theirs: undefined }, // theirs deleted it
    ];
    const out = applyDecisions(merged, conflicts, {
      'tables::public.a': 'theirs',
      'tables::public.b': 'theirs',
    });
    expect(out.tables['public.a']).toEqual({ x: 20, y: 0 });
    expect(out.tables['public.b']).toBeUndefined();
  });

  it('falls back to ours when a decision is missing (provisional bias)', () => {
    const merged = layout({ 'public.a': { x: 10, y: 0 } });
    const conflicts: MergeConflict[] = [{ section: 'tables', key: 'public.a', ours: { x: 10, y: 0 }, theirs: { x: 99, y: 9 } }];
    expect(applyDecisions(merged, conflicts, {}).tables['public.a']).toEqual({ x: 10, y: 0 });
  });

  it('routes group conflicts into the groups record and never mutates the input', () => {
    const merged = layout({}, { ventas: { color: '#111111' } });
    const conflicts: MergeConflict[] = [
      { section: 'groups', key: 'ventas', ours: { color: '#111111' }, theirs: { color: '#222222' } },
    ];
    const out = applyDecisions(merged, conflicts, { 'groups::ventas': 'theirs' });
    expect(out.groups['ventas']).toEqual({ color: '#222222' });
    expect(merged.groups['ventas']).toEqual({ color: '#111111' }); // input untouched
  });
});
