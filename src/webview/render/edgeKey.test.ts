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
