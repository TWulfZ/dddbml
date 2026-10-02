import { describe, expect, it } from 'vitest';
import { edgeKeyedDeps, edgeKeyedRefs, isEdgeKey } from './edgeKey';
import type { Dep, Ref } from '../../shared/types';

const dep = (up: string, upCols: string[], down: string, downCols: string[], extra?: Partial<Dep>): Dep => ({
  name: null,
  note: null,
  edges: [{ id: 'x', upstream: { table: up, columns: upCols }, downstream: { table: down, columns: downCols } }],
  ...extra,
});

describe('edgeKeyedDeps', () => {
  it('keys deps under dep: so the sidecar loader keeps them and they never collide with an FK key', () => {
    const ref: Ref = {
      id: 'r',
      source: { table: 'public.a', columns: ['id'], relation: '1' },
      target: { table: 'public.b', columns: ['id'], relation: '*' },
    };
    const [fk] = edgeKeyedRefs([ref], (t) => t).refs;
    const [d] = edgeKeyedDeps([dep('public.a', ['id'], 'public.b', ['id'])], (t) => t);
    expect(d!.id).toBe(`dep:${fk!.id}`);
    expect(isEdgeKey(d!.id)).toBe(true);
  });

  it('drops hidden endpoints and deps folded into one node; reroutes a collapsed endpoint to its header', () => {
    const deps = [
      dep('public.a', ['x'], 'public.hidden', ['y']),
      dep('public.a', [], 'public.a2', []),
      dep('public.a', ['x'], 'public.c', ['y'], { color: '#f00', note: 'n' }),
    ];
    const map = (t: string) => (t === 'public.hidden' ? null : t === 'public.a2' ? 'public.a' : t === 'public.c' ? '__group__:G' : t);
    expect(edgeKeyedDeps(deps, map)).toEqual([
      {
        id: 'dep:public.a::x|__group__:G::',
        upstream: { table: 'public.a', columns: ['x'] },
        downstream: { table: '__group__:G', columns: [] },
        color: '#f00',
        note: 'n',
        name: null,
      },
    ]);
  });
});

describe('edgeKeyedRefs — self-refs (spec 05 §Self-loops)', () => {
  const mk = (id: string, s: string, sCol: string, t: string, tCol: string): Ref => ({
    id,
    source: { table: s, columns: [sCol], relation: '*' },
    target: { table: t, columns: [tCol], relation: '1' },
  });

  it('keeps a raw self-ref under its own key', () => {
    const { refs, keyByStableId } = edgeKeyedRefs([mk('self', 'public.a', 'parent_id', 'public.a', 'id')], (t) => t);
    expect(refs.map((r) => r.id)).toEqual(['public.a::parent_id|public.a::id']);
    expect(keyByStableId.get('self')).toBe('public.a::parent_id|public.a::id');
  });

  it('still drops refs whose two ends collapse onto one group node, self-refs included', () => {
    const map = (t: string) => (t === 'public.a' || t === 'public.b' ? '__group__:G' : t);
    const { refs, keyByStableId } = edgeKeyedRefs(
      [mk('ab', 'public.a', 'x', 'public.b', 'y'), mk('aa', 'public.a', 'x', 'public.a', 'id')],
      map,
    );
    expect(refs).toEqual([]);
    expect(keyByStableId.size).toBe(0);
  });
});
