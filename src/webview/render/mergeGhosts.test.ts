import { describe, expect, it } from 'vitest';
import type { SerializableMergeConflict } from '../../shared/types';
import { ghostPos } from './mergeGhosts';

const conflict = (ours: SerializableMergeConflict['ours'], theirs: SerializableMergeConflict['theirs']): SerializableMergeConflict => ({
  id: 'tables::public.users',
  section: 'tables',
  key: 'public.users',
  ours,
  theirs,
});

describe('merge ghost placement', () => {
  it('separates a color-only conflict so both sides are visible and clickable', () => {
    const c = conflict({ x: 100, y: 200, color: '#ff0000' }, { x: 100, y: 200, color: '#0000ff' });
    const ours = ghostPos(c, 'ours', 28);
    const theirs = ghostPos(c, 'theirs', 28);
    expect(ours).toEqual({ x: 100, y: 200 });
    expect(theirs).not.toEqual(ours);
  });

  it('draws each side at its own position when they differ', () => {
    const c = conflict({ x: 100, y: 200 }, { x: 500, y: 600 });
    expect(ghostPos(c, 'ours', 28)).toEqual({ x: 100, y: 200 });
    expect(ghostPos(c, 'theirs', 28)).toEqual({ x: 500, y: 600 });
  });

  it('a side that deletes the position sits where the other side is', () => {
    const c = conflict(null, { x: 500, y: 600 });
    expect(ghostPos(c, 'ours', 28)).toEqual({ x: 500, y: 600 });
  });
});
