import { describe, expect, it } from 'vitest';
import { buildWaypointCommand } from './history';

const wp = (x: number, y: number) => ({ x, y });

describe('buildWaypointCommand', () => {
  it('returns null when from and to are identical (no-op move)', () => {
    const same = [wp(10, 20), wp(30, 40)];
    expect(buildWaypointCommand('r1', same, [...same.map((w) => ({ ...w }))], 'move')).toBeNull();
  });

  it('builds a move command with deep-copied snapshots', () => {
    const from = [wp(10, 20)];
    const to = [wp(50, 60)];
    const cmd = buildWaypointCommand('r1', from, to, 'move');
    expect(cmd).not.toBeNull();
    expect(cmd!.kind).toBe('waypoint');
    expect(cmd!.refId).toBe('r1');
    expect(cmd!.from).toEqual([{ x: 10, y: 20 }]);
    expect(cmd!.to).toEqual([{ x: 50, y: 60 }]);
    expect(cmd!.label).toBe('Move waypoint');
    // mutate input — snapshot must be independent.
    from[0]!.x = 9999;
    expect(cmd!.from[0]!.x).toBe(10);
  });

  it('labels add op', () => {
    const cmd = buildWaypointCommand('r1', [], [wp(0, 0)], 'add');
    expect(cmd!.label).toBe('Add waypoint');
  });

  it('labels remove op', () => {
    const cmd = buildWaypointCommand('r1', [wp(0, 0)], [], 'remove');
    expect(cmd!.label).toBe('Remove waypoint');
  });

  it('labels clear op', () => {
    const cmd = buildWaypointCommand('r1', [wp(0, 0), wp(10, 10)], [], 'clear');
    expect(cmd!.label).toBe('Reset edge waypoints');
  });

  it('returns null when both arrays are empty (no-op)', () => {
    expect(buildWaypointCommand('r1', [], [], 'move')).toBeNull();
  });

  it('detects length change as not-equal even with identical prefix', () => {
    const cmd = buildWaypointCommand('r1', [wp(0, 0)], [wp(0, 0), wp(10, 10)], 'add');
    expect(cmd).not.toBeNull();
  });
});
