import { beforeEach, describe, expect, it } from 'vitest';
import { store } from './store';
import type { MoveCommand } from './history';
import type { SerializableMergeConflict } from '../../shared/types';

const conflicts: SerializableMergeConflict[] = [
  { id: 'tables::a', section: 'tables', key: 'a', ours: { x: 1, y: 1 }, theirs: { x: 2, y: 2 } },
  { id: 'groups::g', section: 'groups', key: 'g', ours: { color: '#111111' }, theirs: { color: '#222222' } },
];

beforeEach(() => store.getState().endMerge());

describe('merge conflict slice', () => {
  it('beginMerge enters blocking mode and drops any stale selection', () => {
    store.getState().setSelection(['public.x']);
    store.getState().setSelectedEdge('e1');
    store.getState().beginMerge(conflicts);
    const s = store.getState();
    expect(s.mergeConflicts).toHaveLength(2);
    expect(s.mergeDecisions).toEqual({});
    expect(s.mergeApplying).toBe(false);
    expect(s.selection.size).toBe(0);
    expect(s.selectedEdgeId).toBeNull();
  });

  it('records one decision, then bulk fills every conflict', () => {
    store.getState().beginMerge(conflicts);
    store.getState().setMergeDecision('tables::a', 'theirs');
    expect(store.getState().mergeDecisions).toEqual({ 'tables::a': 'theirs' });
    store.getState().setMergeDecisionsBulk('ours');
    expect(store.getState().mergeDecisions).toEqual({ 'tables::a': 'ours', 'groups::g': 'ours' });
  });

  it('endMerge clears the mode', () => {
    store.getState().beginMerge(conflicts);
    store.getState().setMergeDecisionsBulk('theirs');
    store.getState().endMerge();
    const s = store.getState();
    expect(s.mergeConflicts).toBeNull();
    expect(s.mergeDecisions).toEqual({});
    expect(s.mergeApplying).toBe(false);
  });

  it('undo/redo are no-ops while resolving (read-only gate)', () => {
    store.getState().setTablePos('public.t', 5, 5);
    const move: MoveCommand = {
      kind: 'move',
      from: [['public.t', { x: 0, y: 0 }]],
      to: [['public.t', { x: 5, y: 5 }]],
      label: 'Move table',
      timestamp: 0,
    };
    store.getState().pushMoveCommand(move);
    store.getState().beginMerge(conflicts);

    store.getState().undo();
    expect(store.getState().positions.get('public.t')).toEqual({ x: 5, y: 5 }); // not reverted
    expect(store.getState().past).toHaveLength(1); // history not popped

    store.getState().endMerge();
    store.getState().clearHistory();
  });

  it('view toggle, cursor clamp, mergeStep, hover; endMerge resets them', () => {
    store.getState().beginMerge(conflicts); // 2 conflicts
    expect(store.getState().mergeView).toBe('all');
    expect(store.getState().mergeCursor).toBe(0);

    store.getState().setMergeView('step');
    expect(store.getState().mergeView).toBe('step');

    store.getState().mergeStep(5); // clamp to last index (1)
    expect(store.getState().mergeCursor).toBe(1);
    store.getState().mergeStep(-5); // clamp to 0
    expect(store.getState().mergeCursor).toBe(0);
    store.getState().setMergeCursor(99); // clamp to last
    expect(store.getState().mergeCursor).toBe(1);

    store.getState().setMergeHover({ id: 'tables::a', side: 'theirs' });
    expect(store.getState().mergeHover).toEqual({ id: 'tables::a', side: 'theirs' });

    store.getState().endMerge();
    expect(store.getState().mergeView).toBe('all');
    expect(store.getState().mergeCursor).toBe(0);
    expect(store.getState().mergeHover).toBeNull();
  });
});
